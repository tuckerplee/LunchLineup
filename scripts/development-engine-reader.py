#!/usr/bin/env python3
"""Pinned read-only native custody history reader for dead-guardian recovery.

No Manager key, startup, retry, old-WAL append, repair or fence/registry deletion.
Closed complete native history plus present kernel/PID1 custody are mandatory.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import select
import socket
import stat
import struct
import time

MAX = 1048576
ROOT = '/run/lunchlineup/engine-custody'


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


class Reader:
    def __init__(self, installation, authority):
        self.i, self.a = installation, authority
        fd = installation.pin(authority['roles']['common'])
        self.c = installation.load_module('common', fd)
        self.s = self.c.Settings(installation, authority)
        self.p, self.q = self.s.p, self.s.policy
        self.h = self.s.modules['history']; self.authz = self.s.modules['authz']
        self.dirfd = self.h.directory()
        self.selected = None; self.checked_links = None

    def binding(self, value):
        self.p.closed(value, ['guestBootId', 'requestSha256', 'requestNonce', 'guardianSessionId', 'localSessionId'])
        require(value['guestBootId'] == self.q['bootId'] and value['requestSha256'] == self.q['requestSha256'], 'native recovery boot/request differs')
        for key in ['requestSha256', 'requestNonce', 'guardianSessionId', 'localSessionId']:
            self.p.sha(value[key])

    def dead_guardian(self):
        end = time.monotonic_ns() + 500_000_000
        name = self.c.UNITS['guardian']
        view = self.c.unit_views(self.s.fds['systemctl'], [name], end)[name]
        require(view['MainPID'] == '0' and view['ActiveState'] in ('inactive', 'failed') and view['Job'] == '' and
                self.c.cgroup_empty('/sys/fs/cgroup/system.slice/' + name), 'native recovery overlaps guardian/process/cgroup/job')

    def select(self, binding):
        self.binding(binding); self.dead_guardian()
        names = os.listdir(self.dirfd)
        require(len(names) <= 8194, 'native recovery inventory bound')
        candidates = [name for name in names if name.endswith('.native')]
        require(len(candidates) == 1 and 'native.active' in names, 'native recovery needs one exact preserved fence/WAL')
        value = self.h.read_chain(self.p, self.dirfd, candidates[0])
        result = self.reduce(value, binding)
        require(set(names) == {candidates[0], 'native.active'} | result['responseFiles'], 'unknown/unreferenced native retained file')
        raw_fence = self.h.read_file(self.dirfd, 'native.active')
        first = value['rows'][0]['row']['body']
        require(raw_fence == self.p.canonical(first['fence']) + b'\n' and hashlib.sha256(raw_fence).hexdigest() == first['fenceSha256'],
                'native original fence bytes differ')
        info = os.stat('native.active', dir_fd=self.dirfd, follow_symlinks=False)
        require(str(info.st_dev) == first['device'] and str(info.st_ino) == first['inode'], 'native original fence inode differs')
        result.update(snapshot=value, name=candidates[0])
        return result

    def process_shape(self, value, role, interpreter=False):
        self.p.closed(value, ['pid', 'starttime', 'cgroup', 'profile', 'executableDevice', 'executableInode', 'networkNamespaceInode'])
        self.p.integer(value['pid'], 2, 2**31 - 1); self.p.local_nanoseconds(value['starttime'])
        require(value['cgroup'] == '/system.slice/' + self.c.UNITS[role] and value['profile'] == self.c.PROFILES[role], 'retained native process role')
        for key in ['executableDevice', 'executableInode', 'networkNamespaceInode']:
            require(type(value[key]) is str and value[key].isdigit(), 'retained native process inode type')
        pin = self.s.fds['interpreter' if interpreter else role]
        info = os.fstat(pin)
        require((value['executableDevice'], value['executableInode']) == (str(info.st_dev), str(info.st_ino)), 'native retained immutable executable differs')

    def identity_shape(self, value, generation):
        self.p.closed(value, ['version', 'generation', 'guestBootId', 'requestSha256', 'nativePolicySha256', 'nativeProcess',
            'engines', 'root', 'raw', 'sockets', 'kernelPolicy', 'configSha256', 'retainedConfigurationsSha256',
            'privateFromBirth', 'inheritedClientsExcluded', 'rawRoutes', 'clientRoute'])
        require(type(value['version']) is int and value['version'] == 1 and value['generation'] == generation and
                value['guestBootId'] == self.q['bootId'] and value['requestSha256'] == self.q['requestSha256'] and
                value['nativePolicySha256'] == self.a['policy']['sha256'] and value['privateFromBirth'] is True and
                value['inheritedClientsExcluded'] is True and value['rawRoutes'] == 'native-to-docker;docker-to-containerd' and
                value['clientRoute'] == 'fixed-finite-read-proxy-with-authz-and-complete-wire-match', 'native birth enforcement grammar differs')
        self.process_shape(value['nativeProcess'], 'native', True)
        require(set(value['engines']) == {'daemon', 'containerd'} and
                set(value['sockets']) == {'docker.sock', 'containerd.sock', 'containerd.sock.ttrpc'}, 'native complete engine/socket birth')
        for role, process in value['engines'].items():
            self.process_shape(process, role)
            require(process['networkNamespaceInode'] == value['nativeProcess']['networkNamespaceInode'], 'native birth namespace pairing')
        for key, path in [('root', ROOT), ('raw', ROOT + '/raw')]:
            self.p.closed(value[key], ['path', 'device', 'inode', 'mode'])
            require(value[key]['path'] == path and value[key]['mode'] == 0o700 and type(value[key]['mode']) is int, 'native birth private parent')
        for name, item in value['sockets'].items():
            self.p.closed(item, ['path', 'device', 'inode', 'mode'])
            require(item['path'] == ROOT + '/raw/' + name and type(item['mode']) is int and item['mode'] in (0o600, 0o660), 'native raw birth socket')
        require(value['configSha256'] == {role: self.q['configs'][role]['sha256'] for role in ('daemon', 'containerd')}, 'native birth exact configuration')
        self.p.sha(value['retainedConfigurationsSha256'])
        require(value['kernelPolicy'] == self.s.kernel_policy(), 'native original confinement differs from independently pinned running policy')

    def reduce(self, snapshot, binding):
        p = self.p
        rows = snapshot['rows']; require(len(rows) >= 11, 'native history incomplete before bound birth')
        state = {'fence': None, 'parent': None, 'listeners': None, 'starts': {}, 'launches': {}, 'activation': None,
                 'identity': None, 'bootstrap': None, 'bound': None, 'live': None, 'completed': [], 'stopped': False, 'guardianGone': False}
        files = set(); proxies = {}; by_sha = {}; counts = {'broker': 0, 'physical': 0}; request_count = 0
        for index, record in enumerate(rows):
            row, digest = record['row'], record['recordSha256']
            event, body = row['event'], row['body']; require(not state['stopped'], 'native activity after original owner stop')
            by_sha[digest] = record
            if event == 'NATIVE_FENCE_CREATED':
                p.closed(body, ['fence', 'fenceSha256', 'device', 'inode']); require(index == 0, 'native fence must be first')
                fence = body['fence']
                p.closed(fence, ['version', 'generation', 'guestBootId', 'requestSha256', 'nativePid', 'nativeStarttime', 'nativePolicySha256', 'deadlineNs'])
                require(type(fence['version']) is int and fence['version'] == 1 and fence['guestBootId'] == binding['guestBootId'] and
                        fence['requestSha256'] == binding['requestSha256'] and fence['nativePolicySha256'] == self.a['policy']['sha256'] and
                        fence['deadlineNs'] == str(self.s.deadline), 'native fence original target/policy')
                p.sha(fence['generation']); p.integer(fence['nativePid'], 2, 2**31-1); p.local_nanoseconds(fence['nativeStarttime'])
                state['fence'] = fence
            elif event == 'PRIVATE_PARENT_CREATED':
                p.closed(body, ['root', 'raw', 'clients', 'nativeProcess', 'kernelPolicy', 'retainedConfigurations'])
                require(index == 1 and state['parent'] is None, 'native private birth order')
                self.process_shape(body['nativeProcess'], 'native', True)
                require(body['nativeProcess']['pid'] == state['fence']['nativePid'] and
                        body['nativeProcess']['starttime'] == state['fence']['nativeStarttime'], 'native original owner differs')
                for key in ['root', 'raw', 'clients']:
                    p.closed(body[key], ['path', 'device', 'inode', 'mode'])
                    require(body[key]['path'] == ROOT + ('' if key == 'root' else '/' + key) and
                            type(body[key]['mode']) is int and body[key]['mode'] == 0o700, 'native private parent birth grammar')
                require(type(body['retainedConfigurations']) is list and len(body['retainedConfigurations']) <= 128, 'native retained inventory bound')
                seen = set()
                for retained in body['retainedConfigurations']:
                    p.closed(retained, ['containerId', 'configurationSha256', 'restartDisabled', 'stopped']); p.sha(retained['containerId'])
                    require(retained['containerId'] not in seen and retained['restartDisabled'] is True and retained['stopped'] is True and
                            set(retained['configurationSha256']) == {'config.v2.json', 'hostconfig.json'}, 'native retained cold-state evidence')
                    for sha in retained['configurationSha256'].values(): p.sha(sha)
                    seen.add(retained['containerId'])
                state['parent'] = body
            elif event == 'NATIVE_LISTENERS_CREATED':
                require(index == 2 and set(body) == {'control', 'plugin', 'client'}, 'native public route birth order')
                for role, item in body.items():
                    p.closed(item, ['path', 'device', 'inode', 'mode'])
                    require(item['path'] == ROOT + '/' + role + '.sock' and type(item['mode']) is int and item['mode'] == 0o600,
                            'native client/control/plugin socket privacy')
                state['listeners'] = body
            elif event == 'ENGINE_START_INTENT':
                p.closed(body, ['role', 'unit', 'generation', 'deadlineNs']); role = body['role']
                require(state['listeners'] is not None and state['identity'] is None and role in ('containerd', 'daemon') and
                        role not in state['starts'] and (role == 'containerd' and not state['starts'] or
                        role == 'daemon' and 'containerd' in state['launches']) and body['unit'] == self.c.UNITS[role] and
                        body['generation'] == state['fence']['generation'] and body['deadlineNs'] == str(self.s.deadline), 'native engine startup sequence')
                state['starts'][role] = body
            elif event == 'ENGINE_LAUNCH_AUTHORIZED':
                p.closed(body, ['role', 'pid', 'starttime', 'generation', 'guestBootId', 'requestSha256', 'nativePolicySha256',
                    'deadlineNs', 'argv', 'configSha256', 'executableSha256', 'nativePid', 'nativeStarttime', 'rawDirectory', 'inheritedClientDescriptorsAllowed'])
                role = body['role']
                require(role in state['starts'] and role not in state['launches'] and state['identity'] is None and
                        body['argv'] == self.s.engine_argv(role) and body['rawDirectory'] == state['parent']['raw'] and
                        body['inheritedClientDescriptorsAllowed'] is False and body['configSha256'] == self.q['configs'][role]['sha256'] and
                        body['executableSha256'] == self.a['roles'][role]['sha256'] and
                        all(body[key] == state['fence'][key] for key in ['generation', 'guestBootId', 'requestSha256', 'nativePolicySha256',
                                                                     'deadlineNs', 'nativePid', 'nativeStarttime']), 'native fixed launch evidence differs')
                p.integer(body['pid'], 2, 2**31-1); p.local_nanoseconds(body['starttime'])
                state['launches'][role] = body
            elif event == 'AUTHZ_ACTIVATED':
                p.closed(body, ['daemon', 'generation'])
                require(set(state['launches']) == {'daemon', 'containerd'} and state['activation'] is None and state['identity'] is None and
                        body['generation'] == state['fence']['generation'], 'native AuthZ activation order')
                self.process_shape(body['daemon'], 'daemon'); state['activation'] = body
            elif event == 'ENGINE_BIRTH':
                p.closed(body, ['identity', 'identitySha256'])
                require(state['activation'] is not None and state['identity'] is None and p.digest(body['identity']) == body['identitySha256'], 'native birth order/digest')
                identity = body['identity']; self.identity_shape(identity, state['fence']['generation'])
                parent = state['parent']
                require(all(identity[key] == parent[key] for key in ['root', 'raw', 'nativeProcess', 'kernelPolicy']) and
                        identity['retainedConfigurationsSha256'] == p.digest(parent['retainedConfigurations']) and
                        identity['engines']['daemon'] == state['activation']['daemon'], 'native private birth/engine/kernel linkage')
                for role, process in identity['engines'].items():
                    require(all(process[key] == state['launches'][role][key] for key in ['pid', 'starttime']), 'native launch actual engine differs')
                state['identity'] = identity; state['birthSha'] = digest
            elif event == 'GUARDIAN_BOOTSTRAP':
                p.closed(body, ['binding', 'guardian']); require(state['identity'] is not None and state['bootstrap'] is None, 'native guardian bootstrap order')
                require(body['binding'] == {key: binding[key] for key in ['requestSha256', 'guestBootId', 'localSessionId']}, 'native bootstrap original fence differs')
                self.guardian_shape(body['guardian']); state['bootstrap'] = body
            elif event == 'GUARDIAN_BOUND':
                p.closed(body, ['binding', 'guardian']); require(state['bootstrap'] is not None and state['bound'] is None, 'native binding order')
                p.closed(body['binding'], [*binding, 'inputTableSha256']); p.sha(body['binding']['inputTableSha256'])
                require(all(body['binding'][key] == value for key, value in binding.items()) and body['guardian'] == state['bootstrap']['guardian'], 'native bound original guardian differs')
                state['bound'] = body['binding']
            elif event == 'READ_REGISTERED':
                p.closed(body, ['registration', 'tokenSha256', 'target', 'daemonIdentitySha256'])
                require(state['bound'] is not None and state['live'] is None and not state['guardianGone'], 'native overlapping/unbound/ownerless registration')
                p.sha(body['tokenSha256']); registration = body['registration']
                target = self.registration(registration, state['bound'], counts)
                require(body['target'] == list(target) and body['daemonIdentitySha256'] == p.digest(state['identity']), 'native registered endpoint/engine differs')
                state['live'] = {'registration': registration, 'registeredSha': digest, 'target': target,
                                 'records': [], 'seen': set(), 'active': None, 'proxies': []}
            elif event == 'PROXY_REQUEST':
                p.closed(body, ['proxyId', 'registeredRecordSha256', 'method', 'uri', 'client']); live = state['live']
                p.sha(body['proxyId']); require(live is not None and live['active'] is None and body['proxyId'] not in proxies and
                    body['registeredRecordSha256'] == live['registeredSha'] and
                    all(proxies[key]['delivered'] is not None for key in live['proxies']), 'native proxy overlapping/unknown handle')
                target = self.authz.request_target(body['method'], body['uri'])
                require(target == live['target'] or target[0] in ('ping', 'version'), 'native proxy endpoint outside registration')
                self.client_shape(body['client'], live['registration'], state['bootstrap']['guardian'])
                proxies[body['proxyId']] = {'request': body, 'enter': None, 'returned': None, 'wire': None, 'delivered': None}
                live['proxies'].append(body['proxyId'])
            elif event == 'DAEMON_READ_ENTER':
                p.closed(body, ['method', 'uri', 'target', 'proxyId', 'registeredRecordSha256', 'request']); live = state['live']
                require(live is not None and live['active'] is None and body['proxyId'] in proxies, 'native unmatched daemon request')
                proxy = proxies[body['proxyId']]; target = self.authz.request_target(body['method'], body['uri']); request_count += 1
                require(proxy['enter'] is None and type(body['request']) is int and body['request'] == request_count and
                        body['target'] == list(target) and target not in live['seen'] and len(live['seen']) < 4 and
                        all(body[key] == proxy['request'][key] for key in ['method', 'uri', 'proxyId', 'registeredRecordSha256']), 'native actual request/proxy order differs')
                live['seen'].add(target); live['active'] = dict(body, requestRecordSha256=digest); proxy['enter'] = live['active']
            elif event == 'DAEMON_READ_RETURNED':
                p.closed(body, ['method', 'uri', 'target', 'proxyId', 'registeredRecordSha256', 'request', 'requestRecordSha256',
                    'responseStatusCode', 'responseBodySha256', 'responseBytes', 'projection', 'responseFile', 'handlerReturned', 'mutationRequestDispatched'])
                live = state['live']; require(live is not None and live['active'] is not None and
                    all(body[key] == value for key, value in live['active'].items()) and type(body['responseStatusCode']) is int and
                    body['responseStatusCode'] == 200 and body['handlerReturned'] is True and body['mutationRequestDispatched'] is False,
                    'native unmatched/non-read daemon return')
                self.response(body, files, state['fence']['generation'])
                result = dict(body, responseRecordSha256=digest); live['records'].append(result); live['active'] = None
                proxies[body['proxyId']]['returned'] = result
            elif event == 'PROXY_WIRE_VERIFIED':
                p.closed(body, ['proxyId', 'registeredRecordSha256', 'callbackRecordSha256', 'responseBytes', 'responseBodySha256', 'headOnly', 'completeWireMatched'])
                proxy = proxies.get(body['proxyId']); require(proxy is not None and proxy['returned'] is not None and proxy['wire'] is None, 'native wire without callback')
                callback = proxy['returned']
                require(body['registeredRecordSha256'] == callback['registeredRecordSha256'] and body['callbackRecordSha256'] == callback['responseRecordSha256'] and
                        body['responseBytes'] == callback['responseBytes'] and body['responseBodySha256'] == callback['responseBodySha256'] and
                        type(body['headOnly']) is bool and body['headOnly'] == (callback['method'] == 'HEAD') and
                        body['completeWireMatched'] is True, 'native complete wire/callback differs')
                proxy['wire'] = digest
            elif event == 'PROXY_DELIVERED':
                p.closed(body, ['proxyId', 'wireRecordSha256', 'registeredRecordSha256']); proxy = proxies.get(body['proxyId'])
                require(proxy is not None and proxy['wire'] is not None and proxy['delivered'] is None and body['wireRecordSha256'] == proxy['wire'] and
                        body['registeredRecordSha256'] == proxy['request']['registeredRecordSha256'], 'native delivery unmatched')
                proxy['delivered'] = digest
            elif event == 'READ_CLOSED':
                fields = ['registration', 'registeredRecordSha256', 'daemonIdentitySha256', 'records', 'wireRecords',
                          'pendingRequests', 'unknownRequests', 'mutationRequestsDispatched', 'activeRequestHandles', 'readResponsesVerified']
                p.closed(body, fields); live = state['live']
                require(live is not None and live['active'] is None and live['target'] in live['seen'] and
                        body['registration'] == live['registration'] and body['registeredRecordSha256'] == live['registeredSha'] and
                        body['daemonIdentitySha256'] == p.digest(state['identity']) and body['records'] == live['records'] and
                        len(body['records']) == len(live['proxies']) and body['activeRequestHandles'] == [] and body['readResponsesVerified'] is True and
                        all(type(body[key]) is int and body[key] == 0 for key in ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched']),
                        'native read close lacks complete callback coverage')
                expected = []
                for item in body['records']:
                    proxy = proxies[item['proxyId']]
                    require(proxy['wire'] is not None and proxy['delivered'] is not None, 'native read close before actual complete delivery')
                    expected.append({'proxyId': item['proxyId'], 'wireRecordSha256': proxy['wire'], 'deliveredRecordSha256': proxy['delivered']})
                require(body['wireRecords'] == expected, 'native closed wire order/coverage differs')
                state['completed'].append(dict(body, settlementRecordSha256=digest)); state['live'] = None
            elif event == 'GUARDIAN_PEER_EXITED':
                p.closed(body, ['guardian', 'binding', 'pendingReadHandles', 'authorityRestored', 'automaticRetryAllowed'])
                require(state['bound'] is not None and state['live'] is None and not state['guardianGone'] and
                        body == {'guardian': state['bootstrap']['guardian'], 'binding': state['bound'],
                                 'pendingReadHandles': [], 'authorityRestored': False, 'automaticRetryAllowed': False},
                        'native guardian death observation has pending/foreign state')
                state['guardianGone'] = True
            elif event == 'NATIVE_OWNER_STOPPED':
                p.closed(body, ['generation', 'binding', 'reason', 'pendingRequests', 'authorityRestored', 'automaticRetryAllowed'])
                require(state['bound'] is not None and state['live'] is None and body == {'generation': state['fence']['generation'],
                    'binding': state['bound'], 'reason': 'original-deadline', 'pendingRequests': 0, 'authorityRestored': False,
                    'automaticRetryAllowed': False} and type(body['pendingRequests']) is int, 'native stop cannot settle unknown work')
                state['stopped'] = True
            else:
                # AUTHZ_UNRESOLVED/NATIVE_UNRESOLVED, unknown extensions and partial
                # actions remain unresolved. Do not manufacture a clean tail.
                raise RuntimeError('native history contains unsupported/unresolved event: ' + str(event))
        require(state['bound'] is not None and state['live'] is None and all(item['delivered'] is not None for item in proxies.values()),
                'native complete retained history has pending/unknown request handles')
        return dict(state, responseFiles=files, bySha=by_sha)

    def guardian_shape(self, value):
        self.p.closed(value, ['pid', 'starttime', 'cgroup', 'profile', 'executableDevice', 'executableInode',
                             'networkNamespaceInode', 'role', 'executableSha256'])
        require(value['role'] == 'guardian' and value['profile'] == self.c.PROFILES['guardian'] and
                value['cgroup'] == '/system.slice/' + self.c.UNITS['guardian'] and
                value['executableSha256'] == self.q['peers']['guardian']['executable']['sha256'], 'native original guardian identity grammar')
        self.p.integer(value['pid'], 2, 2**31 - 1); self.p.local_nanoseconds(value['starttime'])

    def client_shape(self, value, registration, guardian):
        if registration['kind'] == 'physical':
            require(value == guardian, 'native physical response foreign client')
            return
        self.p.closed(value, ['pid', 'starttime', 'cgroup', 'profile', 'executableDevice', 'executableInode', 'networkNamespaceInode', 'role'])
        require(value['role'] == 'broker' and value['profile'] == self.c.PROFILES['broker'] and
                value['cgroup'] == self.q['peers']['broker']['cgroup'], 'native broker response foreign client')
        self.p.integer(value['pid'], 2, 2**31 - 1); self.p.local_nanoseconds(value['starttime'])
        info = os.fstat(self.s.fds['docker'])
        require((value['executableDevice'], value['executableInode']) == (str(info.st_dev), str(info.st_ino)), 'native broker immutable executable differs')

    def registration(self, value, binding, counts):
        p = self.p
        p.closed(value, ['kind', 'command', 'workerNonce', 'args', 'path', 'originalDeadlineNs', 'guardianSessionId', 'requestSha256'])
        kind = value['kind']; require(kind in counts, 'native read registration kind')
        p.integer(value['command'], counts[kind] + 1, counts[kind] + 1)
        require(value['command'] <= (259 if kind == 'broker' else 2048) and
                p.local_nanoseconds(value['originalDeadlineNs']) <= self.s.deadline and
                all(value[key] == binding[key] for key in ['guardianSessionId', 'requestSha256']), 'native read original sequence/binding/deadline')
        counts[kind] += 1
        if kind == 'physical':
            require(value['workerNonce'] is None and value['args'] is None, 'native physical registration worker/args')
            target = self.authz.request_target('GET', value['path'])
            require(target[0] in ('info', 'containers', 'container'), 'native physical endpoint grammar')
            return target
        p.sha(value['workerNonce']); require(value['path'] is None, 'native broker endpoint override')
        args = value['args']
        if args == self.authz.INFO: return ('info', '/info')
        if args == self.authz.LIST: return ('images', '/images/json')
        require(type(args) is list and len(args) == 5 and args[:4] == self.authz.INSPECT and
                type(args[4]) is str and args[4].startswith('sha256:'), 'native fixed broker inspection arguments')
        p.sha(args[4][7:]); return ('image', '/images/' + args[4] + '/json')

    def response(self, body, files, generation):
        descriptor = body['responseFile']; self.p.closed(descriptor, ['name', 'bytes', 'sha256'])
        require(descriptor['name'] == generation + '.response-' + str(body['request']) and descriptor['name'] not in files and
                descriptor['bytes'] == body['responseBytes'] and descriptor['sha256'] == body['responseBodySha256'], 'native complete response-file linkage')
        self.p.integer(body['responseBytes'], 0, MAX-1); self.p.sha(body['responseBodySha256'])
        raw = self.h.read_file(self.dirfd, descriptor['name'], MAX)
        require(len(raw) == descriptor['bytes'] and hashlib.sha256(raw).hexdigest() == descriptor['sha256'], 'native retained response full bytes differ')
        files.add(descriptor['name']); target = body['target']
        if target[0] == 'ping':
            require(raw in (b'', b'OK', b'OK\n'), 'native retained ping body'); projection = {'kind': 'ping'}
        else:
            value = self.authz.decode(raw)
            if target[0] == 'info':
                projection = {'id': value['ID'], 'dockerRootDir': value['DockerRootDir'], 'serverVersion': value['ServerVersion']}
            elif target[0] == 'images':
                require(type(value) is list and len(value) <= 256, 'native retained image list bound')
                for item in value:
                    require(type(item.get('Id')) is str and item['Id'].startswith('sha256:'), 'native retained image ID')
                    self.p.sha(item['Id'][7:])
                projection = {'retainedImageIds': sorted({item['Id'] for item in value})}
            elif target[0] == 'image':
                require(value['Id'] == target[1][8:-5], 'native retained image inspection identity')
                projection = {'id': value['Id'], 'tags': value.get('RepoTags'), 'digests': value.get('RepoDigests')}
            else:
                projection = {'bodySha256': hashlib.sha256(raw).hexdigest()}
        require(body['projection'] == projection, 'native semantic projection differs from full retained actual response')

    def current(self, state, binding):
        identity = state['identity']; process = identity['nativeProcess']
        self.dead_guardian()
        try:
            alive = self.c.starttime(process['pid']) == process['starttime']
        except FileNotFoundError:
            alive = False
        end = time.monotonic_ns() + 500_000_000
        if not alive:
            fcntl.flock(self.dirfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for role in ('native', 'daemon', 'containerd'):
                self.s.unit(role, end, inactive=True)
            for original in [identity['nativeProcess'], *identity['engines'].values()]:
                try:
                    require(self.c.starttime(original['pid']) != original['starttime'], 'retained native actor still alive outside unit')
                except FileNotFoundError:
                    pass
            self.c.old_units_stopped(self.s.fds['systemctl'], end)
            return 'retained-native-wal'
        require(not state['stopped'] and time.monotonic_ns() < self.s.deadline, 'live native owner after original stop/deadline')
        endpoint = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET); endpoint.settimeout(0.5)
        try:
            require(self.c.private_directory(ROOT) == identity['root'] and self.c.private_directory(ROOT + '/raw') == identity['raw'],
                    'live native original private parents changed')
            endpoint.connect(ROOT + '/control.sock')
            pid, uid, gid = struct.unpack('3i', endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require((pid, uid, gid) == (process['pid'], 0, 0) and
                    endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 4096).rstrip(b'\0').decode() == self.c.PROFILES['native'] + ' (enforce)',
                    'live native recovery peer identity/profile')
            observed = self.c.pinned_process(pid, process['starttime'], self.s.fds['interpreter'], self.c.PROFILES['native'],
                                             '/system.slice/' + self.c.UNITS['native'])
            require(observed == process, 'live native process incarnation differs')
            actual, held = Path('/proc', str(pid), 'fd/4').stat(), os.fstat(self.s.fds['custodian'])
            require((actual.st_dev, actual.st_ino) == (held.st_dev, held.st_ino), 'live native pinned entry differs')
            peer = self.p.CredentialPeer(endpoint, pid, 0, 0, process['starttime'], process['cgroup'], self.a['roles']['interpreter']['sha256'])
            nonce = os.urandom(32).hex()
            request = {'sequence': 0, 'op': 'RECOVERY_SNAPSHOT', 'nonce': nonce, 'body': {'binding': binding}}
            data = self.p.canonical(request)
            require(endpoint.send(data, socket.MSG_NOSIGNAL) == len(data), 'native recovery short send')
            left = min(end, self.s.deadline) - time.monotonic_ns()
            require(left > 0 and select.select([endpoint], [], [], left / 1e9)[0], 'native recovery snapshot timeout')
            wire = peer.receive(); require(wire is not None, 'native recovery snapshot missing')
            reply = self.p.parse(wire); self.p.closed(reply, ['sequence', 'op', 'nonce', 'body'])
            require(type(reply['sequence']) is int and reply['sequence'] == 0 and reply['op'] == request['op'] and reply['nonce'] == nonce,
                    'native recovery response freshness/sequence')
            result = reply['body']
            self.p.closed(result, ['identity', 'identitySha256', 'birthRecordSha256', 'nativeHistorySha256', 'readState',
                                  'binding', 'deadlineNs', 'authorityRestored', 'automaticRetryAllowed'])
            read_state = result['readState']
            expected_state = {'daemonIdentitySha256': self.p.digest(identity), 'pendingRequests': 0, 'unknownRequests': 0,
                'mutationRequestsDispatched': 0, 'activeRequestHandles': [],
                'completedReadCommands': sum(item['registration']['kind'] == 'broker' for item in state['completed']),
                'completedRecordsSha256': self.p.digest(state['completed']), 'authorityRestored': False, 'automaticRetryAllowed': False}
            require(result == {'identity': identity, 'identitySha256': self.p.digest(identity), 'birthRecordSha256': state['birthSha'],
                'nativeHistorySha256': state['snapshot']['sha256'], 'readState': expected_state, 'binding': state['bound'],
                'deadlineNs': str(self.s.deadline), 'authorityRestored': False, 'automaticRetryAllowed': False} and
                all(type(read_state[key]) is int for key in ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched', 'completedReadCommands']),
                'native fresh observation differs from complete protected history')
            peer.assert_identity(); require(time.monotonic_ns() < min(end, self.s.deadline), 'native recovery exceeded original response budget')
            return 'live-native-owner'
        finally:
            endpoint.close()

    def verify_links(self, binding, links):
        state = self.select(binding); p = self.p
        require(type(links) is list and 2 <= len(links) <= 4096, 'guardian/native linkage count')
        custody = bound = pending = None; completed = []; previous_sequence = -1
        for record in links:
            p.closed(record, ['recordSha256', 'row']); row = record['row']; p.closed(row, ['sequence', 'previous', 'kind', 'body'])
            require(type(row['sequence']) is int and row['sequence'] > previous_sequence and
                    hashlib.sha256(p.canonical(row) + b'\n').hexdigest() == record['recordSha256'], 'native guardian link canonical digest/order')
            previous_sequence = row['sequence']; body = row['body']
            require(type(body.get('version')) is int and body['version'] == 1, 'native guardian linkage version')
            if row['kind'] == 'NATIVE_CUSTODY':
                p.closed(body, ['version', 'bootstrap']); require(custody is None and bound is None, 'duplicate native guardian custody')
                fence = state['fence']
                expected = dict(state['bootstrap']['binding'], nativePolicySha256=self.a['policy']['sha256'], nativePid=fence['nativePid'],
                    nativeStarttime=fence['nativeStarttime'], deadlineNs=str(self.s.deadline), birthRecordSha256=state['birthSha'],
                    identity=state['identity'], identitySha256=p.digest(state['identity']))
                require(body['bootstrap'] == expected, 'native guardian bootstrap differs from actual retained birth')
                custody = record['recordSha256']
            elif row['kind'] == 'NATIVE_BOUND':
                p.closed(body, ['version', 'binding', 'nativeCustodyRecordSha256'])
                require(custody is not None and bound is None and body['nativeCustodyRecordSha256'] == custody and body['binding'] == state['bound'],
                        'native guardian original binding differs')
                bound = record['recordSha256']
            elif row['kind'] == 'NATIVE_READ_REGISTERED':
                p.closed(body, ['version', 'nativeBoundRecordSha256', 'registration', 'registeredRecordSha256', 'daemonIdentitySha256'])
                require(bound is not None and pending is None and body['nativeBoundRecordSha256'] == bound and len(completed) < len(state['completed']),
                        'native guardian overlapping/extra read registration')
                expected = state['completed'][len(completed)]
                require(all(body[key] == expected[key] for key in ['registration', 'registeredRecordSha256', 'daemonIdentitySha256']),
                        'native guardian registration order/coverage differs')
                pending = record['recordSha256']
            elif row['kind'] == 'NATIVE_READ_SETTLED':
                p.closed(body, ['version', 'guardianRegistrationRecordSha256', 'receipt'])
                require(pending is not None and body['guardianRegistrationRecordSha256'] == pending and
                        body['receipt'] == state['completed'][len(completed)], 'native guardian settlement receipt differs')
                completed.append(body['receipt']); pending = None
            else:
                raise RuntimeError('unknown native guardian linkage event')
        require(custody is not None and bound is not None and pending is None and completed == state['completed'],
                'native guardian link coverage incomplete/extra')
        state['mode'] = self.current(state, binding)
        require(self.h.read_chain(p, self.dirfd, state['name']) == state['snapshot'], 'native history changed during custody observation')
        self.selected = state; self.checked_links = p.digest(links); self.selected_binding = dict(binding)
        return None

    def observe(self, binding):
        self.binding(binding)
        require(self.selected is not None and binding == self.selected_binding and self.checked_links is not None,
                'native recovery requires prior complete same-binding linkage verification')
        state = self.selected
        require(self.h.read_chain(self.p, self.dirfd, state['name']) == state['snapshot'], 'native history changed since linkage verification')
        mode = self.current(state, binding)
        require(mode == state['mode'], 'native owner state changed during recovery observation')
        live = mode == 'live-native-owner'
        return {'version': 1, 'binding': dict(binding), 'mode': mode, 'generation': state['fence']['generation'],
            'engineIdentitySha256': self.p.digest(state['identity']), 'nativeHistorySha256': state['snapshot']['sha256'],
            'birthRecordSha256': state['birthSha'], 'nativeOwnerAlive': live, 'enginesAlive': live,
            'writerExclusionVerified': True, 'pendingRequests': 0, 'unknownRequests': 0, 'mutationRequestsDispatched': 0,
            'activeRequestHandles': [], 'authorityRestored': False, 'fenceClearAuthorized': False, 'automaticRetryAllowed': False}


if __name__ == '__main__':
    raise SystemExit('Native recovery reader is a fixed pinned library, not a CLI.')
