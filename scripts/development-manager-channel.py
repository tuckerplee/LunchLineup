#!/usr/bin/env python3
"""KPT117 internal custody primitives; uninstalled, with no launch entry point.

Only pinned guardian/supervisor code may construct these objects. Construction
is not installation authority. No SSH command, child, VM action or Docker action
is launched here. Host authority/finalizer implementation belongs to Manager.
"""
import array
import ctypes
import hashlib
import hmac
import json
import os
from pathlib import Path
import platform
import re
import select
import socket
import stat
import struct
import time

MAX = 1048576
CHANNEL_DOMAIN = 'lunchlineup-development-manager-channel-v1'
ADMISSION_DOMAIN = 'lunchlineup-development-admission-v1'


class Refusal(RuntimeError):
    pass


def require(value, reason):
    if not value:
        raise Refusal(reason)


def closed(value, keys):
    require(type(value) is dict and set(value) == set(keys), 'closed object required')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def parse(data, maximum=MAX):
    require(type(data) is bytes and 0 < len(data) <= maximum, 'frame bound')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate key')
            result[key] = value
        return result
    def constant(_):
        raise Refusal('nonfinite number')
    value = json.loads(data.decode('utf-8'), object_pairs_hook=unique, parse_float=constant, parse_constant=constant)
    def bounded(item, depth=0):
        require(depth <= 32, 'JSON depth bound')
        if isinstance(item, dict):
            for child in item.values():
                bounded(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                bounded(child, depth + 1)
        elif type(item) is int:
            require(abs(item) <= 2**53 - 1, 'JSON integer bound')
    bounded(value)
    require(type(value) is dict and canonical(value) == data, 'noncanonical frame')
    return value


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def sha(value):
    require(type(value) is str and re.fullmatch('[a-f0-9]{64}', value), 'SHA256 required')
    return value


def integer(value, low, high):
    require(type(value) is int and low <= value <= high, 'integer bound')
    return value


def local_nanoseconds(value):
    """Lossless local-clock proof field; canonical decimal signed64 range.

    Strings keep serialized proofs within the unchanged JSON integer policy.
    These are local monotonic readings, never timestamps from a remote clock.
    """
    require(type(value) is str and re.fullmatch(r'(?:0|[1-9][0-9]{0,18})', value),
            'canonical decimal local nanoseconds required')
    return integer(int(value), 0, 2**63 - 1)


class FramedStream:
    """Nonblocking SSH-stdio framing, owned by the single guardian loop.

    FDs must originate in the independently installed fixed SSH adapter; this
    framing layer does not authenticate their provenance. No reconnect/retry.
    Queue bound includes the partially written frame. SSH stderr is separate.
    """
    def __init__(self, read_fd, write_fd):
        self.read_fd, self.write_fd = read_fd, write_fd
        os.set_blocking(read_fd, False)
        os.set_blocking(write_fd, False)
        self.header = bytearray()
        self.body = bytearray()
        self.length = None
        self.pending = []
        self.pending_bytes = 0
        self.failed = False

    def queue(self, body):
        require(not self.failed, 'closed transport')
        try:
            parse(body)
            frame = struct.pack('!I', len(body)) + body
            require(len(self.pending) < 4 and self.pending_bytes + len(frame) <= 4 * MAX,
                    'outgoing queue exhausted')
            self.pending.append(memoryview(frame))
            self.pending_bytes += len(frame)
        except BaseException:
            self.failed = True
            raise

    def flush(self):
        require(not self.failed, 'closed transport')
        try:
            if self.pending:
                try:
                    count = os.write(self.write_fd, self.pending[0])
                except BlockingIOError:
                    return
                require(count > 0, 'transport short write')
                self.pending_bytes -= count
                self.pending[0] = self.pending[0][count:]
                if not self.pending[0]:
                    self.pending.pop(0)
        except BaseException:
            self.failed = True
            raise

    def receive(self):
        """At most one frame, without reading past it or allocating before length."""
        require(not self.failed, 'closed transport')
        try:
            target = self.header if self.length is None else self.body
            remaining = 4 - len(target) if self.length is None else self.length - len(target)
            try:
                chunk = os.read(self.read_fd, min(remaining, 65536))
            except BlockingIOError:
                return None
            require(chunk, 'transport EOF, including partial frame')
            target.extend(chunk)
            if self.length is None and len(self.header) == 4:
                self.length = integer(struct.unpack('!I', self.header)[0], 1, MAX)
            if self.length is not None and len(self.body) == self.length:
                data = bytes(self.body)
                parse(data)
                self.header.clear(); self.body.clear(); self.length = None
                return data
            return None
        except BaseException:
            self.failed = True
            raise


class Authenticator:
    def __init__(self, key, key_id, domain):
        require(type(key) is bytes and len(key) == 32, 'dedicated HMAC key required')
        require(type(key_id) is str and 0 < len(key_id) <= 128, 'key identity required')
        require(domain in (CHANNEL_DOMAIN, ADMISSION_DOMAIN), 'fixed MAC domain')
        self.key, self.key_id, self.domain = key, key_id, domain
        self.counts = {'supervisor-to-manager': 0, 'manager-to-supervisor': 0}

    def envelope(self, payload, direction):
        require(direction in self.counts, 'direction')
        value = {'version': 1, 'domain': self.domain, 'direction': direction,
                 'keyId': self.key_id, 'sequence': self.counts[direction], 'payload': payload}
        return dict(value, mac=hmac.new(self.key, canonical(value), hashlib.sha256).hexdigest())

    def inspect(self, data, direction):
        value = parse(data)
        closed(value, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
        require(type(value['version']) is int and value['version'] == 1 and
                value['domain'] == self.domain and value['direction'] == direction and
                value['keyId'] == self.key_id and type(value['sequence']) is int and
                value['sequence'] == self.counts[direction], 'MAC domain/sequence differs')
        message = {key: value[key] for key in value if key != 'mac'}
        require(type(value['payload']) is dict and type(value['mac']) is str and
                hmac.compare_digest(value['mac'], hmac.new(self.key, canonical(message), hashlib.sha256).hexdigest()),
                'MAC authentication failed')
        return value['payload']

    def consume(self, direction):
        self.counts[direction] += 1


class EpochHandshake:
    """Separate-domain fresh challenge; installed adapter must also pin SSH peer.

    The returned proof is internal guardian state, never a caller's cached file.
    HOST_HELLO carries managerStartNonce to permit the specified epoch digest
    calculation; it is not a secret and does not grant authority independently.
    """
    def __init__(self, key, key_id, guest_boot, machine_id, installation_sha, request_sha, authority_sha):
        self.auth = Authenticator(key, key_id, CHANNEL_DOMAIN)
        self.authority_sha = sha(authority_sha)
        require(machine_id == '80a9dfd43bbc6a074cf9148daa5335c2', 'wrong guest')
        require(type(guest_boot) is str and re.fullmatch('[a-f0-9-]{36}', guest_boot), 'guest boot')
        self.hello = {'type': 'HELLO', 'channelNonce': os.urandom(32).hex(),
                      'guestBootId': guest_boot, 'estate': 'Proxmox1', 'vmid': 107,
                      'machineId': machine_id, 'guardianInstallationSha256': sha(installation_sha),
                      'requestSha256': sha(request_sha)}
        self.sent_ns = None
        self.proof = None
        self.failed = False

    def begin(self):
        require(self.sent_ns is None and not self.failed, 'one-shot HELLO')
        self.sent_ns = time.monotonic_ns()
        wire = canonical(self.auth.envelope(self.hello, 'supervisor-to-manager'))
        self.auth.consume('supervisor-to-manager')
        return wire

    def accept(self, data):
        try:
            now = time.monotonic_ns()
            require(self.sent_ns is not None and self.proof is None and not self.failed and
                    0 <= now - self.sent_ns <= 5_000_000_000, 'late/repeated HOST_HELLO')
            value = self.auth.inspect(data, 'manager-to-supervisor')
            closed(value, [*self.hello, 'managerEpoch', 'hostBootId', 'durableGeneration',
                           'managerStartNonce', 'authorityPolicySha256', 'guardianSessionId'])
            require(value['type'] == 'HOST_HELLO' and all(value[k] == v for k, v in self.hello.items() if k != 'type'), 'HOST_HELLO binding')
            require(type(value['hostBootId']) is str and re.fullmatch('[a-f0-9-]{36}', value['hostBootId']), 'host boot')
            integer(value['durableGeneration'], 1, 2**53 - 1)
            sha(value['managerStartNonce']); sha(value['guardianSessionId'])
            require(value['authorityPolicySha256'] == self.authority_sha, 'authority policy changed')
            epoch = digest({k: value[k] for k in ['hostBootId', 'durableGeneration', 'managerStartNonce', 'authorityPolicySha256']})
            require(value['managerEpoch'] == epoch, 'epoch digest differs')
            self.auth.consume('manager-to-supervisor')
            self.proof = {'managerEpoch': epoch, 'currentEpochProofSha256': hashlib.sha256(data).hexdigest(),
                          'channelNonce': self.hello['channelNonce'], 'guardianSessionId': value['guardianSessionId'],
                          'guestBootId': self.hello['guestBootId'],
                          'verifiedNs': str(integer(now, 0, 2**63 - 1)),
                          'deadlineNs': str(integer(self.sent_ns + 15_000_000_000, 0, 2**63 - 1))}
            return dict(self.proof)
        except BaseException:
            self.failed = True
            raise


class CredentialPeer:
    """Exact installed spawned peer, connection and per-packet credentials.

    Expected PID/starttime/cgroup/executable identity must be derived by the
    guardian from its registered child or independently verified PID1 MainPID,
    never from a candidate request. No incoming descriptor is accepted here;
    initial descriptor transfer requires the separate reviewed entry adapter.
    """
    def __init__(self, endpoint, pid, uid, gid, starttime, cgroup, executable_sha, *, socket_creator=None):
        require(endpoint.family == socket.AF_UNIX and endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_SEQPACKET, 'seqpacket required')
        self.endpoint = endpoint
        self.expected = (integer(pid, 1, 2**31 - 1), integer(uid, 0, 2**31 - 1), integer(gid, 0, 2**31 - 1))
        self.starttime, self.cgroup, self.executable_sha = starttime, cgroup, sha(executable_sha)
        require(type(cgroup) is str and cgroup.startswith('/system.slice/') and '..' not in cgroup and '\n' not in cgroup, 'nondelegated cgroup required')
        self.executable_identity = None
        self.pidfd = os.pidfd_open(pid, 0)
        try:
            creator = self.expected if socket_creator is None else socket_creator
            require(type(creator) is tuple and len(creator) == 3 and all(type(value) is int and value >= 0 for value in creator), 'socket creator identity')
            require(struct.unpack('3i', endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) == creator, 'connection creator differs')
            endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            endpoint.setblocking(False)
            self.assert_identity()
        except BaseException:
            os.close(self.pidfd)
            self.pidfd = None
            raise

    def assert_identity(self):
        require(self.pidfd is not None and not select.select([self.pidfd], [], [], 0)[0], 'registered peer exited')
        proc = Path('/proc') / str(self.expected[0])
        row = (proc / 'stat').read_text()
        tail = row[row.rfind(')') + 2:].split()
        require(len(tail) > 19 and tail[19] == str(self.starttime), 'peer starttime differs')
        require((proc / 'cgroup').read_text() == '0::' + self.cgroup + '\n', 'peer cgroup differs')
        # Hash only on registration; subsequent packet checks compare the pinned
        # executable inode/version. Full immutable interpreter/script descriptor
        # custody is still mandatory in the child-entry integration.
        with (proc / 'exe').open('rb') as source:
            info = os.fstat(source.fileno())
            observed = tuple(getattr(info, field) for field in
                             ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
            if self.executable_identity is None:
                h = hashlib.sha256(); size = 0
                while chunk := source.read(MAX):
                    size += len(chunk)
                    require(size <= 64 * MAX, 'peer executable bound')
                    h.update(chunk)
                after = os.fstat(source.fileno())
                require(observed == tuple(getattr(after, field) for field in
                        ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')) and
                        h.hexdigest() == self.executable_sha, 'peer executable differs')
                self.executable_identity = observed
            else:
                require(observed == self.executable_identity, 'peer executable changed')
        require(not select.select([self.pidfd], [], [], 0)[0], 'peer exited during identity check')

    def receive(self):
        self.assert_identity()
        try:
            body, ancillary, flags, _ = self.endpoint.recvmsg(MAX + 1, socket.CMSG_SPACE(12) + socket.CMSG_SPACE(256 * 4), socket.MSG_CMSG_CLOEXEC)
        except BlockingIOError:
            return None
        credentials = []; invalid = False; close_errors = []
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                descriptors = array.array('i')
                descriptors.frombytes(payload[:len(payload) - len(payload) % descriptors.itemsize])
                for fd in descriptors:
                    try:
                        os.close(fd)
                    except OSError as error:
                        close_errors.append(type(error).__name__)
                invalid = True
            elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(payload) == 12:
                credentials.append(struct.unpack('3i', payload))
            else:
                invalid = True
        require(body and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) and not invalid and not close_errors and credentials == [self.expected], 'packet peer/ancillary differs')
        parse(body)
        self.assert_identity()
        return body

    def close(self):
        fd, self.pidfd = self.pidfd, None
        if fd is not None:
            os.close(fd)


def require_shared_lock(guardian_pid, guardian_fd, local_fd):
    """Installed guardian-created duplicate only. Never reacquire/unlock here.

    Linux x86_64 only in this source slice; unsupported architecture or kcmp
    permission/kernel failure refuses. Provenance + guardian-held flock and
    its independent fence remain necessary in addition to this comparison.
    """
    require(platform.machine() == 'x86_64', 'unqualified kcmp architecture')
    integer(guardian_pid, 1, 2**31 - 1)
    integer(guardian_fd, 0, 2**31 - 1); integer(local_fd, 0, 2**31 - 1)
    info = os.fstat(local_fd)
    path = Path('/run/lock/lunchlineup-deploy.lock')
    require(path.resolve(strict=True) == path, 'noncanonical deployment lock')
    for part in [path, *path.parents]:
        st = part.lstat()
        require(st.st_uid == 0 and not st.st_mode & 0o022, 'lock path custody absent')
    named = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
            (info.st_dev, info.st_ino) == (named.st_dev, named.st_ino), 'lock descriptor custody differs')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    result = libc.syscall(ctypes.c_long(312), ctypes.c_int(os.getpid()), ctypes.c_int(guardian_pid),
                          ctypes.c_int(0), ctypes.c_ulong(local_fd), ctypes.c_ulong(guardian_fd))
    require(result == 0, 'same open-file description not proved')


class GuardianDeadlines:
    """Real guardian-loop timers; no ticker thread, signals or VM actions.

    Caller supplies observed PID1 unit deadlines only after independent unit
    custody verification. A timer refusal must enter guardian/host containment;
    this class cannot install PID1 or turn a callback into independent custody.
    """
    def __init__(self, guest_unit_deadline_ns, host_remaining_ms, operation_ms):
        now = time.monotonic_ns()
        integer(guest_unit_deadline_ns, now + 1, now + 1800_000_000_000)
        integer(host_remaining_ms, 1, 1800000); integer(operation_ms, 1, 1800000)
        self.overall = min(guest_unit_deadline_ns, now + min(host_remaining_ms, operation_ms) * 1000000)
        self.last_heartbeat_ns, self.heartbeat_sequence = now, -1
        self.last_loop_ns = now
        self.fenced = False

    def heartbeat(self, sequence):
        self.check()
        integer(sequence, self.heartbeat_sequence + 1, self.heartbeat_sequence + 1)
        self.heartbeat_sequence = sequence
        self.last_heartbeat_ns = time.monotonic_ns()

    def check(self):
        now = time.monotonic_ns()
        if self.fenced or now >= self.overall or now - self.last_heartbeat_ns >= 5_000_000_000:
            self.fenced = True
            raise Refusal('guardian overall/owner heartbeat expired')
        return now

    def loop_progress(self):
        now = self.check()
        require(now - self.last_loop_ns < 10_000_000_000, 'guardian loop watchdog elapsed')
        self.last_loop_ns = now
        # PID1 WATCHDOG notification may be sent by the installed loop only
        # after this real iteration; never from an unrelated heartbeat thread.



class LeaseProtocol:
    """Serialized authenticated-payload reducer for KPT117.

    Internal trusted adapter only: MAC verification/one-shot custody queue and
    fsynced Session journal must precede each incoming transition. This reducer
    never exposes a dispatch token. Historical replay uses recorded local times
    and reconstructs state only; it cannot renew a live grant. The installed
    integration must fence on ANY parse/persistence/transition failure.
    """
    def __init__(self, request, epoch_proof, policy, request_sent_ns, unit_deadline_ns):
        closed(request, ['type', 'nonce', 'requestSha256', 'guestBootId', 'inputTableSha256'])
        require(request['type'] == 'REQUEST', 'request type')
        for key in ['nonce', 'requestSha256', 'inputTableSha256']:
            sha(request[key])
        closed(epoch_proof, ['managerEpoch', 'currentEpochProofSha256', 'channelNonce',
                             'guardianSessionId', 'guestBootId', 'verifiedNs', 'deadlineNs'])
        closed(policy, ['selectionSha256', 'custodyPolicySha256', 'containmentRightsSha256',
                        'overallLimitMs', 'renewEveryMs', 'leaseTtlMs', 'maxRoundTripMs'])
        for key in ['selectionSha256', 'custodyPolicySha256', 'containmentRightsSha256']:
            sha(policy[key])
        for key in ['managerEpoch', 'currentEpochProofSha256', 'channelNonce', 'guardianSessionId']:
            sha(epoch_proof[key])
        epoch_verified_ns = local_nanoseconds(epoch_proof['verifiedNs'])
        epoch_deadline_ns = local_nanoseconds(epoch_proof['deadlineNs'])
        require(epoch_verified_ns < epoch_deadline_ns, 'epoch proof deadline order')
        require(request['guestBootId'] == epoch_proof['guestBootId'], 'epoch guest differs')
        require((policy['renewEveryMs'], policy['leaseTtlMs'], policy['maxRoundTripMs']) == (5000, 15000, 5000) and
                all(type(policy[k]) is int for k in ['renewEveryMs', 'leaseTtlMs', 'maxRoundTripMs']), 'installed timing differs')
        integer(policy['overallLimitMs'], 1, 1800000)
        integer(request_sent_ns, 0, 2**63 - 1)
        require(type(unit_deadline_ns) is int and unit_deadline_ns > request_sent_ns, 'unit lifetime exhausted')
        self.request = parse(canonical(request))
        self.epoch = parse(canonical(epoch_proof))
        self.epoch_verified_ns, self.epoch_deadline_ns = epoch_verified_ns, epoch_deadline_ns
        self.policy = parse(canonical(policy))
        self.sent_ns = request_sent_ns
        self.overall_ns = min(unit_deadline_ns, request_sent_ns + policy['overallLimitMs'] * 1000000)
        self.state = 'WAIT_GRANT'
        self.grant = self.binding = self.pending = None
        self.expiry_ns = request_sent_ns
        self.next_renew_ns = request_sent_ns
        self.sequence = 0
        self.last_heartbeat = -1
        self.renew_nonces = set()
        self.last_observed_ns = request_sent_ns
        self.failure = None

    def check(self, now_ns):
        integer(now_ns, self.last_observed_ns, 2**63 - 1)
        require(self.state == 'BOUND' and now_ns < min(self.expiry_ns, self.overall_ns), 'lease unavailable')
        if self.pending is not None:
            require(now_ns - self.renew_sent_ns <= 5_000_000_000, 'renewal RTT missed')
        else:
            # The loop must enqueue the renewal at its cadence, not wait for TTL.
            require(now_ns <= self.next_renew_ns, 'renewal cadence missed')
        self.last_observed_ns = now_ns

    def transition(self, direction, payload, now_ns):
        try:
            integer(now_ns, self.last_observed_ns, 2**63 - 1)
            require(self.state not in ('REVOKED', 'FAILED'), 'lease fenced')
            require(direction in ('supervisor-to-manager', 'manager-to-supervisor'), 'direction')
            kind = payload.get('type')
            if kind == 'GRANT' and direction == 'manager-to-supervisor':
                require(self.state == 'WAIT_GRANT', 'duplicate grant')
                closed(payload, ['type', 'nonce', 'requestSha256', 'guestBootId', 'inputTableSha256',
                                 'grantId', 'managerEpoch', 'sequence', 'durationMs', 'maxRoundTripMs'])
                require(all(payload[k] == self.request[k] for k in self.request if k != 'type'), 'grant/request mismatch')
                require(payload['managerEpoch'] == self.epoch['managerEpoch'] and
                        now_ns < self.epoch_deadline_ns and self.epoch_verified_ns <= self.sent_ns and
                        now_ns - self.sent_ns <= 5_000_000_000, 'grant epoch freshness/RTT')
                require(type(payload['grantId']) is str and 0 < len(payload['grantId']) <= 128, 'grant ID')
                require(type(payload['sequence']) is int and payload['sequence'] == 0 and
                        type(payload['durationMs']) is int and payload['durationMs'] == 15000 and
                        type(payload['maxRoundTripMs']) is int and payload['maxRoundTripMs'] == 5000, 'initial grant timing')
                self.expiry_ns = min(self.sent_ns + 15_000_000_000, self.overall_ns)
                require(now_ns < self.expiry_ns, 'initial lease expired')
                self.grant = parse(canonical(payload))
                self.state = 'WAIT_BIND'
            elif kind == 'SESSION_BIND' and direction == 'manager-to-supervisor':
                require(self.state == 'WAIT_BIND' and now_ns < self.expiry_ns, 'binding out of phase')
                expected = dict(self.policy, type='SESSION_BIND', **{k: self.request[k] for k in self.request if k != 'type'},
                                grantId=self.grant['grantId'], managerEpoch=self.epoch['managerEpoch'],
                                guardianSessionId=self.epoch['guardianSessionId'], currentEpochProofSha256=self.epoch['currentEpochProofSha256'])
                require(canonical(payload) == canonical(expected), 'SESSION_BIND differs from independent policy')
                self.binding = parse(canonical(payload))
                self.state = 'BOUND'
                self.next_renew_ns = self.sent_ns + 5_000_000_000
                require(now_ns <= self.next_renew_ns, 'initial renewal cadence missed')
            elif kind == 'REVOKE' and direction == 'manager-to-supervisor':
                require(self.grant is not None, 'unbound revoke')
                closed(payload, ['type', 'grantId', 'managerEpoch', 'guestBootId', 'nonce', 'requestSha256', 'reasonCode', 'containmentRightsSha256'])
                require(all(payload[k] == self.grant[k] for k in ['grantId', 'managerEpoch', 'guestBootId', 'nonce', 'requestSha256']) and
                        payload['containmentRightsSha256'] == self.policy['containmentRightsSha256'], 'revoke binding differs')
                require(type(payload['reasonCode']) is str and re.fullmatch('[A-Z0-9_]{1,64}', payload['reasonCode']), 'bounded reason code')
                self.state = 'REVOKED'
                self.failure = payload['reasonCode']
                self.pending = None
            elif kind == 'RENEW' and direction == 'supervisor-to-manager':
                self.check(now_ns)
                require(self.pending is None and self.sequence < 360 and now_ns >= self.next_renew_ns - 1_000_000_000, 'renewal phase/cadence')
                closed(payload, ['type', 'grantId', 'grantSequence', 'managerEpoch', 'guestBootId', 'nonce',
                                 'requestSha256', 'inputTableSha256', 'selectionSha256', 'renewNonce',
                                 'ledgerSha256', 'unresolvedSummarySha256', 'supervisorHeartbeatSequence'])
                require(all(payload[k] == self.grant[k] for k in ['grantId', 'managerEpoch', 'guestBootId', 'nonce', 'requestSha256', 'inputTableSha256']), 'renewal grant differs')
                integer(payload['grantSequence'], self.sequence + 1, self.sequence + 1)
                integer(payload['supervisorHeartbeatSequence'], self.last_heartbeat + 1, 2**53 - 1)
                require(payload['selectionSha256'] == self.policy['selectionSha256'], 'renewal selection differs')
                for key in ['renewNonce', 'ledgerSha256', 'unresolvedSummarySha256']:
                    sha(payload[key])
                require(payload['renewNonce'] not in self.renew_nonces, 'reused renewal nonce')
                self.renew_nonces.add(payload['renewNonce'])
                self.pending = parse(canonical(payload))
                self.renew_sent_ns = now_ns
            elif kind == 'RENEWED' and direction == 'manager-to-supervisor':
                self.check(now_ns)
                require(self.pending is not None, 'no outstanding renewal')
                expected = dict(self.pending, type='RENEWED', durationMs=15000,
                                overallLimitMs=self.policy['overallLimitMs'], sessionBindSha256=digest(self.binding))
                require(canonical(payload) == canonical(expected), 'renewal echo/bind differs')
                self.sequence = self.pending['grantSequence']
                self.last_heartbeat = self.pending['supervisorHeartbeatSequence']
                self.expiry_ns = min(self.renew_sent_ns + 15_000_000_000, self.overall_ns)
                self.next_renew_ns += 5_000_000_000
                self.pending = None
            else:
                raise Refusal('unexpected lease message')
            self.last_observed_ns = now_ns
        except BaseException:
            self.state = 'FAILED'
            raise

    def channel_lost(self):
        self.state = 'REVOKED'
        self.failure = 'CHANNEL_LOST'
        self.pending = None

    def inventory_deadline(self, original_inventory_expiry_ns):
        require(self.state == 'BOUND', 'inventory needs SESSION_BIND')
        return min(self.expiry_ns, original_inventory_expiry_ns, self.overall_ns)


class JournalBudget:
    """Admission/reservation arithmetic over ACTUAL existing journal bytes.

    This does not own a second ledger or fsync anything. Installed integration
    supplies canonical wrapped byte counts from its existing bounded journals.
    Reserve each journal independently; do not charge only unwrapped payloads.
    """
    def __init__(self, initial_bytes):
        integer(initial_bytes, 0, 512 * 1024)
        self.used = initial_bytes
        self.pairs = 0
        self.pending_bytes = None
        self.tail = MAX

    def reserve_other(self, wrapped_bytes):
        integer(wrapped_bytes, 1, MAX)
        require(self.used + wrapped_bytes + (360 - self.pairs) * 2304 + self.tail <= 4 * MAX,
                'renewal/terminal reserve exhausted')
        self.used += wrapped_bytes

    def begin_pair(self, envelope_bytes, wrapped_bytes):
        integer(envelope_bytes, 1, 2048); integer(wrapped_bytes, envelope_bytes, 2304)
        require(self.pending_bytes is None and self.pairs < 360, 'renewal budget phase')
        require(self.used + (360 - self.pairs) * 2304 + self.tail <= 4 * MAX, 'renewal reserve unavailable')
        self.pending_bytes = wrapped_bytes

    def end_pair(self, envelope_bytes, wrapped_bytes):
        integer(envelope_bytes, 1, 2048); integer(wrapped_bytes, envelope_bytes, 2304)
        require(self.pending_bytes is not None and self.pending_bytes + wrapped_bytes <= 2304, 'actual renewal pair exceeds reserve')
        self.used += self.pending_bytes + wrapped_bytes
        self.pending_bytes = None
        self.pairs += 1


def mutation_admission(*_args, **_kwargs):
    raise Refusal('whole-VM containment right unapproved; engine settlement/dispatch unintegrated')


if __name__ == '__main__':
    raise SystemExit('Uninstalled custody primitives; guardian/child/VM execution refused.')
