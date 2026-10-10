#!/usr/bin/env python3
"""Native engine custodian's closed Docker AuthZ request/response reducer.

No public CLI, Manager key, daemon launcher or supplied success receipt. The
pinned native owner supplies actual daemon-peer authentication and private WAL.
Only registered one-use bounded GET/HEAD operations can reach a handler. Full
non-streaming response callbacks establish handler completion; client completion
is separately required by the guardian. Unknown/missing callbacks poison custody.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time
from urllib.parse import urlsplit, unquote, parse_qsl

MAX = 1048576
TOKEN_HEADER = 'X-Lunchlineup-Read-Token'
INFO = ['info', '--format', '{"id":{{json .ID}},"dockerRootDir":{{json .DockerRootDir}},"serverVersion":{{json .ServerVersion}}}']
LIST = ['image', 'ls', '--no-trunc', '--format', '{{json .}}']
INSPECT = ['image', 'inspect', '--format', '{"id":{{json .Id}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}}}']


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def decode(data):
    require(type(data) is bytes and len(data) <= MAX, 'engine JSON body bound')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate engine JSON key')
            result[key] = value
        return result
    def constant(_):
        raise RuntimeError('nonfinite engine JSON')
    value = json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    def depth(item, level=0):
        require(level <= 32, 'engine JSON nesting bound')
        if type(item) is dict:
            for child in item.values():
                depth(child, level + 1)
        elif type(item) is list:
            for child in item:
                depth(child, level + 1)
    depth(value)
    return value


def headers(value):
    require(type(value) is dict and len(value) <= 64, 'HTTP header map bound')
    result = {}
    for name, values in value.items():
        require(type(name) is str and re.fullmatch('[A-Za-z0-9-]{1,128}', name), 'HTTP header name')
        key = name.lower()
        require(key not in result, 'duplicate case-insensitive HTTP header')
        # Engine plugin generations document both string and string-list maps;
        # exactly one value is admitted, never joining ambiguous duplicates.
        if type(values) is list:
            require(len(values) == 1, 'multiple HTTP header values refused')
            values = values[0]
        require(type(values) is str and len(values) <= 8192 and '\r' not in values and '\n' not in values,
                'HTTP header value bound')
        result[key] = values
    return result


def request_target(method, uri):
    require(method in ('GET', 'HEAD') and type(uri) is str and len(uri) <= 2048 and
            uri.isascii() and '\\' not in uri and '\r' not in uri and '\n' not in uri, 'read-only HTTP target')
    parsed = urlsplit(uri)
    require(not parsed.scheme and not parsed.netloc and not parsed.fragment, 'origin-form HTTP target required')
    path = unquote(parsed.path, errors='strict')
    require(not re.search('%|[\x00-\x20\x7f]', path), 'ambiguous HTTP path')
    path = re.sub(r'^/v1\.[0-9]{1,3}(?=/)', '', path)
    values = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    query = {}
    for key, value in values:
        require(key not in query, 'duplicate HTTP query parameter')
        query[key] = value
    if path == '/_ping':
        require(not query, 'ping query unsupported')
        return 'ping', path
    require(method == 'GET', 'HEAD only admitted for ping')
    if path in ('/version', '/info'):
        require(not query, 'metadata query unsupported')
        return 'version' if path == '/version' else 'info', path
    if path == '/images/json':
        require(set(query) <= {'all', 'filters', 'digests', 'shared-size'}, 'image listing query unsupported')
        for key in set(query) - {'filters'}:
            require(query[key] in ('0', '1', 'false', 'true'), 'image listing boolean query')
        if 'filters' in query:
            require(decode(query['filters'].encode()) == {}, 'filtered image listing refused')
        return 'images', path
    if re.fullmatch('/images/sha256:[a-f0-9]{64}/json', path):
        require(not query, 'image inspection query unsupported')
        return 'image', path
    if path == '/containers/json':
        require(query == {'all': '1'}, 'physical container listing must include all retained containers')
        return 'containers', path
    if re.fullmatch('/containers/[a-f0-9]{64}/json', path):
        require(not query, 'physical container inspection query unsupported')
        return 'container', path
    raise RuntimeError('HTTP endpoint is not an admitted finite read')


class Authorizer:
    def __init__(self, owner):
        self.owner, self.p = owner, owner.p
        self.live = None
        self.completed = []
        self.failed = False
        self.response_bytes = 0
        self.request_count = 0

    def poison(self, reason):
        self.failed = True
        self.owner.journal.append('AUTHZ_UNRESOLVED', {'reason': str(reason)[:256],
            'authorityRestored': False, 'automaticRetryAllowed': False})

    def register(self, registration):
        # Called only by the native owner's actual authenticated guardian peer.
        p = self.p
        p.closed(registration, ['kind', 'command', 'workerNonce', 'args', 'path', 'originalDeadlineNs',
                                'guardianSessionId', 'requestSha256'])
        require(not self.failed and self.live is None and len(self.completed) < 2048, 'native read registry occupied/failed/full')
        deadline = p.local_nanoseconds(registration['originalDeadlineNs'])
        require(time.monotonic_ns() < deadline <= self.owner.deadline, 'native original read deadline')
        require(registration['guardianSessionId'] == self.owner.binding['guardianSessionId'] and
                registration['requestSha256'] == self.owner.binding['requestSha256'], 'native read owner binding')
        p.integer(registration['command'], 1, 2048)
        kind, args, path = registration['kind'], registration['args'], registration['path']
        if kind == 'broker':
            p.sha(registration['workerNonce'])
            require(path is None, 'broker cannot choose HTTP endpoint')
            if args == INFO:
                target = ('info', '/info')
            elif args == LIST:
                target = ('images', '/images/json')
            else:
                require(type(args) is list and len(args) == 5 and args[:4] == INSPECT and
                        re.fullmatch('sha256:[a-f0-9]{64}', args[4]), 'native broker command not admitted')
                target = ('image', '/images/' + args[4] + '/json')
        else:
            require(kind == 'physical' and args is None and registration['workerNonce'] is None,
                    'native observation role differs')
            target = request_target('GET', path)
            require(target[0] in ('info', 'containers', 'container'), 'physical read outside retained-state scope')
        token = os.urandom(32).hex()
        record = {'registration': registration, 'tokenSha256': hashlib.sha256(token.encode()).hexdigest(),
                  'target': list(target), 'daemonIdentitySha256': self.owner.engine_identity_sha()}
        registered_sha = self.owner.journal.append('READ_REGISTERED', record)
        self.live = {'registration': registration, 'token': token, 'registeredSha256': registered_sha,
                     'target': target, 'deadline': deadline, 'active': None, 'records': [], 'seen': set(),
                     'daemonIdentitySha256': record['daemonIdentitySha256']}
        return {'token': token, 'registeredRecordSha256': registered_sha,
                'daemonIdentitySha256': record['daemonIdentitySha256']}

    def authorize_request(self, body):
        p = self.p
        p.closed(body, ['User', 'UserAuthNMethod', 'RequestMethod', 'RequestURI', 'RequestBody', 'RequestHeader'])
        require(not self.failed and self.live is not None, 'unregistered daemon request')
        entry = self.live
        require(time.monotonic_ns() < entry['deadline'] and entry['active'] is None and len(entry['records']) < 4,
                'read deadline/overlap/metadata request limit')
        values = headers(body['RequestHeader'])
        supplied = values.get(TOKEN_HEADER.lower(), '')
        require(hmac.compare_digest(supplied, entry['token']) and 'upgrade' not in values and
                values.get('content-length', '0') == '0' and 'transfer-encoding' not in values and
                body['RequestBody'] in (None, ''), 'unregistered token/body/upgrade')
        proxy_id = values.get('x-lunchlineup-proxy-request', '')
        p.sha(proxy_id)
        self.owner.assert_proxy_hook(proxy_id, entry, body['RequestMethod'], body['RequestURI'])
        target = request_target(body['RequestMethod'], body['RequestURI'])
        require(target == entry['target'] or target[0] in ('ping', 'version'), 'token bound to another endpoint')
        require(target not in entry['seen'], 'duplicate logical endpoint under one token')
        self.request_count += 1
        require(self.request_count <= 8192, 'native aggregate request count')
        safe = {'method': body['RequestMethod'], 'uri': body['RequestURI'], 'target': list(target), 'proxyId': proxy_id,
                'registeredRecordSha256': entry['registeredSha256'], 'request': self.request_count}
        record_sha = self.owner.journal.append('DAEMON_READ_ENTER', safe)
        entry['active'] = dict(safe, requestRecordSha256=record_sha)
        entry['seen'].add(target)
        return {'Allow': True, 'Msg': '', 'Err': ''}

    def authorize_response(self, body):
        p = self.p
        p.closed(body, ['User', 'UserAuthNMethod', 'RequestMethod', 'RequestURI', 'RequestBody', 'RequestHeader',
                        'ResponseBody', 'ResponseHeader', 'ResponseStatusCode'])
        require(not self.failed and self.live is not None and self.live['active'] is not None, 'unpaired daemon response callback')
        entry, active = self.live, self.live['active']
        require(time.monotonic_ns() < entry['deadline'] and body['RequestMethod'] == active['method'] and
                body['RequestURI'] == active['uri'] and hmac.compare_digest(headers(body['RequestHeader']).get(TOKEN_HEADER.lower(), ''), entry['token']) and
                type(body['ResponseStatusCode']) is int and body['ResponseStatusCode'] == 200,
                'daemon response binding/deadline/status')
        require(headers(body['RequestHeader']).get('x-lunchlineup-proxy-request') == active['proxyId'], 'response proxy binding differs')
        self.owner.assert_proxy_hook(active['proxyId'], entry, body['RequestMethod'], body['RequestURI'])
        require(body['RequestBody'] in (None, ''), 'response request acquired a body')
        raw = body['ResponseBody']
        require(raw is None or type(raw) is str and len(raw) <= (MAX + 2) // 3 * 4, 'response callback body bound')
        raw = b'' if raw is None else base64.b64decode(raw, validate=True)
        require(len(raw) < MAX, 'response callback size')
        self.response_bytes += len(raw)
        require(self.response_bytes <= 32 * MAX, 'native full response aggregate bound')
        response_headers = headers(body['ResponseHeader'])
        require('upgrade' not in response_headers and 'trailer' not in response_headers,
                'hijacked/streamed response unsupported')
        if 'content-length' in response_headers:
            require(response_headers['content-length'] == str(len(raw)) or
                    active['method'] == 'HEAD' and not raw, 'partial callback response body')
        target = tuple(active['target'])
        if target[0] == 'ping':
            require(raw in (b'', b'OK', b'OK\n'), 'unexpected ping response')
            projection = {'kind': 'ping'}
        else:
            require(response_headers.get('content-type', '').split(';', 1)[0] == 'application/json',
                    'non-JSON finite endpoint response')
            value = decode(raw)
            if target[0] == 'info':
                require(type(value) is dict and all(type(value.get(key)) is str for key in ('ID', 'DockerRootDir', 'ServerVersion')),
                        'daemon INFO semantic identity')
                projection = {'id': value['ID'], 'dockerRootDir': value['DockerRootDir'], 'serverVersion': value['ServerVersion']}
            elif target[0] == 'images':
                require(type(value) is list and len(value) <= 256 and all(type(item) is dict and
                        type(item.get('Id')) is str and re.fullmatch('sha256:[a-f0-9]{64}', item['Id']) for item in value),
                        'daemon image-list semantic result')
                projection = {'retainedImageIds': sorted({item['Id'] for item in value})}
            elif target[0] == 'image':
                require(type(value) is dict and value.get('Id') == target[1][len('/images/'):-len('/json')],
                        'daemon image inspection identity')
                projection = {'id': value['Id'], 'tags': value.get('RepoTags'), 'digests': value.get('RepoDigests')}
                require(all(item is None or type(item) is list and len(item) <= 4096 and
                        all(type(name) is str and len(name) <= 4096 for name in item)
                        for item in (projection['tags'], projection['digests'])), 'image association shape/bounds')
            else:
                # Complete raw physical/version bodies remain private in native
                # evidence. Guardian independently applies retained-state policy.
                require(type(value) in (dict, list), 'physical/version JSON response shape')
                projection = {'bodySha256': hashlib.sha256(raw).hexdigest()}
        response_file = self.owner.retain_response(active['request'], raw)
        result = dict(active, responseStatusCode=200, responseBodySha256=hashlib.sha256(raw).hexdigest(),
                      responseBytes=len(raw), projection=projection, responseFile=response_file,
                      handlerReturned=True, mutationRequestDispatched=False)
        record_sha = self.owner.journal.append('DAEMON_READ_RETURNED', result)
        entry['records'].append(dict(result, responseRecordSha256=record_sha))
        entry['active'] = None
        require(time.monotonic_ns() < entry['deadline'], 'daemon response persistence exceeded original deadline')
        return {'Allow': True, 'Msg': '', 'Err': ''}

    def close_read(self, registered_sha):
        require(not self.failed and self.live is not None and self.live['registeredSha256'] == registered_sha,
                'unknown native close-read handle')
        entry = self.live
        require(time.monotonic_ns() < entry['deadline'] and entry['active'] is None and
                entry['target'] in entry['seen'] and self.owner.plugin_inflight == 0 and self.owner.proxy_inflight == 0 and
                self.owner.engine_identity_sha() == entry['daemonIdentitySha256'],
                'daemon read still pending/unknown or incarnation changed')
        primary = [record for record in entry['records'] if tuple(record['target']) == entry['target']]
        require(len(primary) == 1, 'missing/excess completed primary read')
        wire_records = []
        for record in entry['records']:
            wire = self.owner.proxies[record['proxyId']]
            require(wire['delivered'] is True and wire['callbackRecordSha256'] == record['responseRecordSha256'],
                    'semantic callback lacks complete verified/delivered actual wire response')
            wire_records.append({'proxyId': record['proxyId'], 'wireRecordSha256': wire['wireRecordSha256'],
                                 'deliveredRecordSha256': wire['deliveredRecordSha256']})
        receipt = {'registration': entry['registration'], 'registeredRecordSha256': registered_sha,
                   'daemonIdentitySha256': entry['daemonIdentitySha256'], 'records': entry['records'], 'wireRecords': wire_records,
                   'pendingRequests': 0, 'unknownRequests': 0, 'mutationRequestsDispatched': 0,
                   'activeRequestHandles': [], 'readResponsesVerified': True}
        receipt['settlementRecordSha256'] = self.owner.journal.append('READ_CLOSED', receipt)
        self.completed.append(receipt)
        self.live = None
        return receipt

    def snapshot(self):
        require(not self.failed, 'native read history is unresolved')
        return {'daemonIdentitySha256': self.owner.engine_identity_sha(),
                'pendingRequests': int(self.live is not None) + self.owner.plugin_inflight + self.owner.proxy_inflight,
                'unknownRequests': 0, 'mutationRequestsDispatched': 0,
                'activeRequestHandles': [self.live['registeredSha256']] if self.live else [],
                'completedReadCommands': sum(item['registration']['kind'] == 'broker' for item in self.completed),
                'completedRecordsSha256': self.p.digest(self.completed),
                'authorityRestored': False, 'automaticRetryAllowed': False}


if __name__ == '__main__':
    raise SystemExit('Native AuthZ reducer is not a standalone authorization service.')
