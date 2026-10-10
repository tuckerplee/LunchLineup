#!/usr/bin/env python3
"""Pinned guardian-private client for the fixed native engine custodian.

Actual Unix credentials/LSM/pidfd/entry custody; no Manager key, arbitrary socket,
PID, command, proof callback or caller-selected recovery target.
"""
import hashlib
import os
from pathlib import Path
import select
import socket
import stat
import struct
import time

MAX = 1048576
UNIT = 'lunchlineup-development-engines.service'
CONTROL = '/run/lunchlineup/engine-custody/control.sock'
CLIENT = '/run/lunchlineup/engine-custody/client.sock'
PROFILE = 'lunchlineup-development-engine-custodian (enforce)'


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


class Client:
    def __init__(self, guardian, installation):
        self.g, self.p, self.i = guardian, guardian.p, guardian.i
        self.p.closed(installation, ['entry', 'interpreter', 'unitFile', 'policy'])
        require(installation['entry']['path'] == '/usr/local/libexec/lunchlineup/development-engine-custodian' and
                installation['unitFile']['path'] == '/etc/systemd/system/' + UNIT, 'fixed native installation roles')
        self.installation = installation
        self.fds = {role: self.i.pin(pin, role == 'policy') for role, pin in installation.items()}
        root = Path(CONTROL).parent
        for path in [root, *root.parents]:
            info = path.lstat()
            require(path.resolve(strict=True) == path and info.st_uid == 0 and not info.st_mode & 0o022,
                    'native control directory custody')
        require(stat.S_IMODE(root.stat().st_mode) == 0o700, 'native control parent must be private from birth')
        info = Path(CONTROL).lstat()
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600, 'native control socket metadata')
        self.endpoint = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.endpoint.settimeout(0.5)
        self.endpoint.connect(CONTROL)
        pid, uid, gid = struct.unpack('3i', self.endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require((uid, gid) == (0, 0), 'native peer UID/GID')
        self.pid = self.p.integer(pid, 1, 2**31 - 1)
        proc = Path('/proc', str(pid))
        row = (proc / 'stat').read_text()
        require(len(row) <= 8192, 'native process stat bound')
        self.starttime = row[row.rfind(')') + 2:].split()[19]
        self.peer = self.p.CredentialPeer(self.endpoint, pid, 0, 0, self.starttime,
                         '/system.slice/' + UNIT, installation['interpreter']['sha256'])
        os.lseek(self.fds['policy'], 0, os.SEEK_SET)
        native_policy = self.p.parse(os.read(self.fds['policy'], MAX + 1))
        os.lseek(self.fds['policy'], 0, os.SEEK_SET)
        require(native_policy['bootId'] == guardian.boot and
                native_policy['requestSha256'] == guardian.policy['approvedRequestBindings']['requestSha256'],
                'independently pinned native startup target differs')
        self.deadline = self.p.local_nanoseconds(native_policy['originalDeadlineNs'])
        self.bootstrap_deadline = min(guardian.started_ns + 10_000_000_000, guardian.original_deadline, self.deadline)
        self.sequence = 0; self.bound = None; self.physical_command = 0
        self.assert_identity()
        self.bootstrap = self.rpc('BOOTSTRAP', {'requestSha256': guardian.policy['approvedRequestBindings']['requestSha256'],
            'guestBootId': guardian.boot, 'localSessionId': guardian.local_id})
        self.p.closed(self.bootstrap, ['guestBootId', 'requestSha256', 'localSessionId', 'nativePolicySha256',
            'nativePid', 'nativeStarttime', 'deadlineNs', 'birthRecordSha256', 'identity', 'identitySha256'])
        require(self.bootstrap['nativePid'] == pid and self.bootstrap['nativeStarttime'] == self.starttime and
                self.bootstrap['guestBootId'] == guardian.boot and self.bootstrap['localSessionId'] == guardian.local_id and
                self.bootstrap['requestSha256'] == guardian.policy['approvedRequestBindings']['requestSha256'] and
                self.bootstrap['nativePolicySha256'] == installation['policy']['sha256'] and
                self.bootstrap['deadlineNs'] == native_policy['originalDeadlineNs'] and
                self.p.digest(self.bootstrap['identity']) == self.bootstrap['identitySha256'], 'native bootstrap binding differs')
        self.p.sha(self.bootstrap['birthRecordSha256'])
        self.deadline = self.p.local_nanoseconds(self.bootstrap['deadlineNs'])
        require(time.monotonic_ns() < self.deadline <= guardian.original_deadline, 'native original lifetime differs')
        guardian.original_deadline = min(guardian.original_deadline, self.deadline)
        self.custody_record = guardian.journal.append('NATIVE_CUSTODY', {'version': 1, 'bootstrap': self.bootstrap})
        self.bound_record = None; self.handles = {}

    def assert_identity(self):
        self.peer.assert_identity()
        require(self.endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 4096).rstrip(b'\0').decode() == PROFILE,
                'native enforcing peer compartment differs')
        proc = Path('/proc', str(self.pid))
        actual, pinned = (proc / 'fd/4').stat(), os.fstat(self.fds['entry'])
        require((actual.st_dev, actual.st_ino) == (pinned.st_dev, pinned.st_ino), 'native immutable entry descriptor differs')
        expected = (self.installation['interpreter']['path'] + '\0-I\0/proc/self/fd/4\0').encode()
        require((proc / 'cmdline').read_bytes() == expected, 'native fixed interpreter/entry invocation differs')

    def rpc(self, op, body, original_deadline=None):
        self.assert_identity()
        start = time.monotonic_ns()
        # BOOTSTRAP is one outstanding request, never a readiness retry. Charge
        # original guardian startup and independently pinned native lifetime.
        response_end = self.bootstrap_deadline if op == 'BOOTSTRAP' else start + 500_000_000
        deadline = min(response_end, self.g.original_deadline,
                       getattr(self, 'deadline', self.g.original_deadline), original_deadline or self.g.original_deadline)
        require(start < deadline, 'native RPC original budget exhausted')
        nonce = os.urandom(32).hex()
        value = {'sequence': self.sequence, 'op': op, 'nonce': nonce, 'body': body}
        raw = self.p.canonical(value)
        require(len(raw) <= MAX and self.endpoint.send(raw, socket.MSG_NOSIGNAL) == len(raw), 'native RPC short send/bound')
        left = deadline - time.monotonic_ns()
        require(left > 0 and select.select([self.endpoint], [], [], left / 1000000000)[0], 'native RPC timeout')
        wire = self.peer.receive()
        require(wire is not None, 'native RPC missing response')
        reply = self.p.parse(wire)
        self.p.closed(reply, ['sequence', 'op', 'nonce', 'body'])
        require(reply['sequence'] == self.sequence and type(reply['sequence']) is int and reply['op'] == op and
                reply['nonce'] == nonce and type(reply['body']) is dict, 'native RPC response binding')
        self.assert_identity()
        require(time.monotonic_ns() < deadline, 'native RPC expired during peer recheck')
        self.sequence += 1
        return reply['body']

    def bind(self):
        g = self.g
        require(g.request is not None and g.epoch is not None, 'native reads before original request binding')
        value = {'guardianSessionId': g.epoch['guardianSessionId'], 'requestSha256': g.request['requestSha256'],
                 'requestNonce': g.request['nonce'], 'inputTableSha256': g.request['inputTableSha256'],
                 'guestBootId': g.boot, 'localSessionId': g.local_id}
        if self.bound is None:
            result = self.rpc('BIND', value)
            require(result == dict(value, authorityRestored=False, automaticRetryAllowed=False), 'native owner binding differs')
            self.bound = value
            self.bound_record = g.journal.append('NATIVE_BOUND', {'version': 1, 'binding': value,
                'nativeCustodyRecordSha256': self.custody_record})
        else:
            require(self.bound == value, 'native binding cannot be replaced')

    def register(self, *, kind, command, worker_nonce, args, path, deadline):
        self.bind()
        registration = {'kind': kind, 'command': command, 'workerNonce': worker_nonce, 'args': args, 'path': path,
            'originalDeadlineNs': str(deadline), 'guardianSessionId': self.bound['guardianSessionId'],
            'requestSha256': self.bound['requestSha256']}
        result = self.rpc('REGISTER_READ', registration, deadline)
        self.p.closed(result, ['registration', 'registeredRecordSha256', 'daemonIdentitySha256', 'configPath', 'token'])
        require(result['registration'] == registration and result['daemonIdentitySha256'] == self.bootstrap['identitySha256'],
                'native read registration/engine differs')
        self.p.sha(result['registeredRecordSha256'])
        if kind == 'broker':
            require(result['token'] is None and type(result['configPath']) is str and
                    result['configPath'].startswith('/run/lunchlineup/engine-custody/clients/'), 'native broker config role')
            self.p.sha(result['configPath'].split('/')[-1])
        else:
            require(result['configPath'] is None, 'physical read cannot obtain broker config')
            self.p.sha(result['token'])
        digest = self.g.journal.append('NATIVE_READ_REGISTERED', {'version': 1,
            'nativeBoundRecordSha256': self.bound_record, 'registration': registration,
            'registeredRecordSha256': result['registeredRecordSha256'], 'daemonIdentitySha256': result['daemonIdentitySha256']})
        self.handles[result['registeredRecordSha256']] = digest
        return result

    def close_read(self, handle, deadline):
        result = self.rpc('CLOSE_READ', {'registeredRecordSha256': handle['registeredRecordSha256']}, deadline)
        self.p.closed(result, ['registration', 'registeredRecordSha256', 'daemonIdentitySha256', 'records', 'wireRecords',
            'pendingRequests', 'unknownRequests', 'mutationRequestsDispatched', 'activeRequestHandles',
            'readResponsesVerified', 'settlementRecordSha256'])
        require(result['registration'] == handle['registration'] and result['registeredRecordSha256'] == handle['registeredRecordSha256'] and
                result['daemonIdentitySha256'] == handle['daemonIdentitySha256'] and result['readResponsesVerified'] is True and
                result['activeRequestHandles'] == [] and all(type(result[key]) is int and result[key] == 0 for key in
                ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched']), 'native daemon settlement incomplete/different')
        self.p.sha(result['settlementRecordSha256'])
        digest = self.handles.pop(result['registeredRecordSha256'])
        self.g.journal.append('NATIVE_READ_SETTLED', {'version': 1,
            'guardianRegistrationRecordSha256': digest, 'receipt': result})
        return result

    def snapshot(self, deadline):
        self.bind()
        result = self.rpc('SNAPSHOT', {}, deadline)
        self.p.closed(result, ['identity', 'identitySha256', 'birthRecordSha256', 'nativeHistorySha256', 'readState',
            'binding', 'deadlineNs', 'authorityRestored', 'automaticRetryAllowed'])
        require(result['binding'] == self.bound and result['identity'] == self.bootstrap['identity'] and
                result['identitySha256'] == self.p.digest(result['identity']) == self.bootstrap['identitySha256'] and
                result['birthRecordSha256'] == self.bootstrap['birthRecordSha256'] and
                result['deadlineNs'] == str(self.deadline) and result['authorityRestored'] is False and
                result['automaticRetryAllowed'] is False, 'native current snapshot/custody differs')
        self.p.sha(result['nativeHistorySha256'])
        return result


if __name__ == '__main__':
    raise SystemExit('Native custodian client is pinned guardian-private code, not a CLI.')
