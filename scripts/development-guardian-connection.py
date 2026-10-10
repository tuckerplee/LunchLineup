#!/usr/bin/env python3
"""Fixed installed guest guardian connection. No guest/host service launcher.

The descriptor is inherited at fixed FD3. Kernel peer/PID1/executable custody,
MACed host handshake and shared-OFD proof are checked before reservation. The
fixed guardian service must implement this protocol; absence always refuses.
No caller endpoint, PID, epoch, socket path or guardian object is accepted.
"""
import array
import hashlib
import os
import re
from pathlib import Path
import select
import socket
import stat
import struct
import subprocess
import sys
import time

UNIT = 'lunchlineup-development-guardian.service'
ENTRY = '/usr/local/libexec/lunchlineup/development-guardian'
LOCK = '/run/lock/lunchlineup-deploy.lock'
MAX = 1048576
PROPERTIES = ('MainPID', 'User', 'Group', 'ActiveState', 'SubState', 'Type',
              'NotifyAccess', 'WatchdogUSec', 'RuntimeMaxUSec', 'TimeoutStopUSec',
              'KillMode', 'Delegate', 'ControlGroup', 'ActiveEnterTimestampMonotonic',
              'ExecMainStartTimestampMonotonic', 'WatchdogTimestampMonotonic', 'ExecStopPost')


def fail(reason):
    raise RuntimeError(reason)


def protected(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        fail('guardian installation path not canonical')
    for part in [path, *path.parents]:
        info = part.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            fail('guardian installation custody absent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        fail('guardian installation file not regular')
    return fd


def pinned_file(primitives, pin):
    import fcntl
    primitives.closed(pin, ['path', 'bytes', 'sha256', 'veritySha256'])
    primitives.integer(pin['bytes'], 1, 64 * MAX)
    primitives.sha(pin['sha256']); primitives.sha(pin['veritySha256'])
    fd = protected(pin['path'])
    try:
        if os.fstat(fd).st_size != pin['bytes']:
            fail('guardian installed size differs')
        measure = bytearray(struct.pack('HH', 0, 64) + bytes(64))
        fcntl.ioctl(fd, 0xC0046686, measure, True)
        if struct.unpack('HH', measure[:4]) != (1, 32) or measure[4:36].hex() != pin['veritySha256']:
            fail('guardian verity differs')
        h = hashlib.sha256()
        while chunk := os.read(fd, MAX):
            h.update(chunk)
        if h.hexdigest() != pin['sha256']:
            fail('guardian installed hash differs')
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def unit_snapshot(expected_stop_post, systemctl_fd):
    # Guardian-private actual PID1 query, pinned executable FD. Bound output
    # with a pipe reader rather than capture_output's unbounded allocation.
    command = ['/usr/bin/systemctl', 'show', '--no-pager',
               '--property=' + ','.join(PROPERTIES), '--', UNIT]
    child = subprocess.Popen(command, executable='/proc/self/fd/' + str(systemctl_fd),
                             pass_fds=(systemctl_fd,), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, close_fds=True)
    data = bytearray()
    deadline = time.monotonic() + 2
    try:
        os.set_blocking(child.stdout.fileno(), False)
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                fail('PID1 observation timeout')
            if not select.select([child.stdout], [], [], left)[0]:
                fail('PID1 observation timeout')
            chunk = os.read(child.stdout.fileno(), min(4096, 16385 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 16384:
                fail('PID1 observation output bound')
        if child.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            fail('PID1 observation failed')
    finally:
        primary = sys.exc_info()[1]
        cleanup_errors = []
        try:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=2)
        except BaseException as error:
            cleanup_errors.append(error)
        try:
            child.stdout.close()
        except BaseException as error:
            cleanup_errors.append(error)
        if cleanup_errors:
            if primary is None:
                raise cleanup_errors[0]
            try:
                primary.add_note('PID1 observation cleanup unresolved: ' + ','.join(type(x).__name__ for x in cleanup_errors))
            except BaseException:
                pass
    fields = {}
    for line in data.decode('utf-8').splitlines():
        key, separator, value = line.partition('=')
        if not separator or key in fields:
            fail('ambiguous PID1 observation')
        fields[key] = value
    return validate_unit_fields(fields, expected_stop_post)


def validate_unit_fields(fields, expected_stop_post):
    # Caller may use only the fixed guardian's credential-bound fresh snapshot,
    # or this module's actual PID1 query. No public supplied-proof constructor.
    if set(fields) != set(PROPERTIES):
        fail('incomplete PID1 observation')
    expected = {'User': 'root', 'Group': 'root', 'ActiveState': 'active', 'SubState': 'running',
                'Type': 'notify', 'NotifyAccess': 'main', 'WatchdogUSec': '10s',
                'RuntimeMaxUSec': '30min', 'TimeoutStopUSec': '10s',
                'KillMode': 'control-group', 'Delegate': 'no',
                'ControlGroup': '/system.slice/' + UNIT, 'ExecStopPost': expected_stop_post}
    if any(fields[key] != value for key, value in expected.items()):
        fail('PID1 custody/watchdog properties differ')
    for key in ['MainPID', 'ActiveEnterTimestampMonotonic', 'ExecMainStartTimestampMonotonic', 'WatchdogTimestampMonotonic']:
        if not fields[key].isascii() or not fields[key].isdigit() or int(fields[key]) <= 0:
            fail('PID1 identity/timestamp invalid')
        fields[key] = int(fields[key])
    now = time.monotonic_ns()
    activated = fields['ActiveEnterTimestampMonotonic'] * 1000
    watchdog = fields['WatchdogTimestampMonotonic'] * 1000
    if not activated <= watchdog <= now or now - watchdog >= 10_000_000_000:
        fail('PID1 watchdog observation stale')
    fields['deadlineNs'] = activated + 1800_000_000_000
    if now >= fields['deadlineNs']:
        fail('guardian unit runtime exhausted')
    return fields


def require_guardian_flock(pid, fd):
    """Observe the guardian's write flock, without acquiring or unlocking it.

    This complements kcmp and installed descriptor provenance; it does not
    establish exclusive Docker/root-writer ownership.
    """
    info = os.fstat(fd)
    with Path('/proc/locks').open('rb') as source:
        data = source.read(MAX + 1)
    if len(data) > MAX:
        fail('kernel lock observation bound')
    matches = 0
    for line in data.decode('ascii').splitlines():
        fields = line.split()
        if len(fields) != 8 or fields[1:4] != ['FLOCK', 'ADVISORY', 'WRITE'] or fields[4] != str(pid):
            continue
        device = fields[5].split(':')
        if len(device) == 3 and (int(device[0], 16), int(device[1], 16), int(device[2])) == (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino) and fields[6:] == ['0', 'EOF']:
            matches += 1
    if matches != 1:
        fail('guardian-owned deployment flock not observed')


class GuardianPeer:
    """Unprivileged view of the inherited, fixed guardian compartment.

    No cross-process /proc/exe, /proc/fd or kcmp access. The kernel binds the
    original root creator, enforcing LSM socket label, pidfd and each packet's
    actual credentials. Only the independently confined/pinned guardian may
    produce this channel. The public installation pins define its fixed code;
    privileged process/OFD verification remains inside that owner.
    """
    def __init__(self, p, endpoint, pid):
        self.p, self.endpoint = p, endpoint
        self.expected = (p.integer(pid, 1, 2**31 - 1), 0, 0)
        if endpoint.family != socket.AF_UNIX or endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_SEQPACKET:
            fail('inherited guardian seqpacket required')
        self.pidfd = os.pidfd_open(pid, 0)
        try:
            endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            endpoint.setblocking(False)
            self.assert_identity()
        except BaseException:
            self.close()
            raise

    def assert_identity(self):
        if self.pidfd is None or select.select([self.pidfd], [], [], 0)[0]:
            fail('registered guardian incarnation exited')
        if struct.unpack('3i', self.endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) != self.expected:
            fail('guardian socket creator differs')
        label = self.endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 4096).rstrip(b'\0')
        if label != b'lunchlineup-development-guardian (enforce)':
            fail('guardian socket lacks exact enforcing compartment')

    def receive(self):
        self.assert_identity()
        try:
            data, ancillary, flags, _ = self.endpoint.recvmsg(MAX + 1, socket.CMSG_SPACE(12) +
                socket.CMSG_SPACE(256 * 4), socket.MSG_CMSG_CLOEXEC)
        except BlockingIOError:
            return None
        credentials = []; invalid = False
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(payload) == 12:
                credentials.append(struct.unpack('3i', payload))
            elif level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array('i')
                values.frombytes(payload[:len(payload) - len(payload) % values.itemsize])
                for fd in values:
                    os.close(fd)
                invalid = True
            else:
                invalid = True
        if not data or invalid or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or credentials != [self.expected]:
            fail('guardian packet credential/ancillary mismatch')
        self.p.parse(data)
        self.assert_identity()
        return data

    def close(self):
        fd, self.pidfd = self.pidfd, None
        if fd is not None:
            os.close(fd)


class InstalledGuardian:
    """Constructed only by open_fixed; no public supplied-custody constructor."""
    def __init__(self):
        fail('use fixed installed custody establishment')

    def registered_supervisor_peer(self):
        self.assert_live()
        return self.peer

    def current_epoch(self):
        self.assert_live()
        return self.p.parse(self.p.canonical(self.epoch))

    def remaining_unit_deadline_ns(self):
        self.assert_live()
        return self.deadline_ns

    def assert_live(self):
        if self.failed or time.monotonic_ns() >= self.deadline_ns:
            fail('guardian custody unavailable')
        self.peer.assert_identity()
        if not self.release_pending:
            require_guardian_flock(self.pid, self.lock_fd)

    def _send(self, kind, body):
        self.assert_live()
        if self.release_pending and kind not in ('owner-progress', 'retain-unresolved', 'fence', 'release-commit'):
            fail('only settlement observation allowed after forwarded ACK')
        data = self.p.canonical({'sequence': self.out_sequence, 'kind': kind, 'body': body})
        if len(data) > MAX:
            fail('guardian control packet bound')
        try:
            # Nonblocking seqpacket: EAGAIN is failure, never a silent resend.
            if self.socket.send(data, socket.MSG_NOSIGNAL) != len(data):
                fail('guardian packet short send')
            self.out_sequence += 1
        except BaseException:
            self.failed = True
            raise

    def request_admission(self, payload, sent_ns):
        self._send('admission-request', {'payload': payload, 'sentNs': str(sent_ns)})

    def commit_admission(self, envelope_sha, ledger_sha):
        self.p.sha(envelope_sha); self.p.sha(ledger_sha)
        self._send('admission-commit', {'envelopeSha256': envelope_sha, 'ledgerSha256': ledger_sha})

    def start_worker(self, role):
        if role not in ('archive-preflight', 'image-inventory'):
            fail('fixed worker role required')
        self._send('worker-start', {'role': role})

    def owner_progress(self, sequence):
        self.p.integer(sequence, 0, 2**53 - 1)
        self._send('owner-progress', {'heartbeatSequence': sequence})

    def fence_new_work(self):
        self._send('fence', {'requestSha256': self.request_sha})

    def retain_unresolved(self, nonce, request_sha):
        if request_sha != self.request_sha:
            fail('wrong unresolved request')
        self._send('retain-unresolved', {'nonce': nonce, 'requestSha256': request_sha,
                                         'guardianSessionId': self.epoch['guardianSessionId']})

    def accept_terminal_ack(self, envelope):
        if self.release_pending:
            fail('terminal ACK already forwarded')
        self._send('terminal-ack', envelope)
        self.release_pending = True

    def commit_release(self, receipt_sha, ledger_sha):
        self._send('release-commit', {'releaseReceiptSha256': receipt_sha, 'ledgerSha256': ledger_sha})

    def duplicate_lock(self):
        if self.release_pending:
            fail('lock handoff closed after terminal ACK')
        self.assert_live()
        # os.dup preserves the OFD that this exact current guardian compared
        # to this descriptor during the credential-bound adoption exchange.
        # No new open and no privileged cross-process inspection in supervisor.
        if self.ofd_receipt['supervisorFd'] != self.lock_fd:
            fail('adopted local descriptor changed')
        fd = os.dup(self.lock_fd)
        os.set_inheritable(fd, False)
        return fd

    def close_local_unresolved(self):
        # This is descriptor cleanup, NEVER a settlement/ACK/guardian unlock.
        self.failed = True
        fds, self.held = self.held, []
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass
        if self.peer is not None:
            self.peer.close()
        self.socket.close()


def open_fixed(primitives, installation, request_sha, table_sha, key_id):
    primitives.closed(installation, ['guardian', 'interpreter', 'finalizer', 'unitFile',
                                     'execStopPost', 'authorityPolicySha256', 'guardianInstallationSha256'])
    if installation['guardian']['path'] != ENTRY or installation['unitFile']['path'] != '/etc/systemd/system/' + UNIT:
        fail('wrong fixed guardian role')
    if not re.fullmatch(r'/usr/bin/python3\.[0-9]{1,2}', installation['interpreter']['path']) or installation['finalizer']['path'] != '/usr/local/libexec/lunchlineup/development-guardian-finalizer':
        fail('wrong fixed interpreter/finalizer role')
    if type(installation['execStopPost']) is not str or not 0 < len(installation['execStopPost']) <= 4096:
        fail('independently pinned ExecStopPost observation required')
    stop_prefix = '{ path=' + installation['interpreter']['path'] + ' ; argv[]=' + installation['interpreter']['path'] + ' -I ' + installation['finalizer']['path'] + ' ; ignore_errors=no ;'
    if not installation['execStopPost'].startswith(stop_prefix) or installation['execStopPost'].count('{') != 1 or installation['execStopPost'].count('}') != 1 or not installation['execStopPost'].endswith('}'):
        fail('PID1 must execute only the fixed admitted finalizer')
    primitives.sha(installation['authorityPolicySha256']); primitives.sha(installation['guardianInstallationSha256'])
    held = []; received = []; endpoint = None; peer = None
    try:
        for role in ['guardian', 'interpreter', 'finalizer', 'unitFile']:
            held.append(pinned_file(primitives, installation[role]))
        # Root supervisor has no privileged systemd socket or command access.
        # Authenticate inherited guardian code/process first, then consume its
        # fresh actual PID1 observation over this exact private connection.
        endpoint = socket.socket(fileno=os.dup(3))
        os.set_inheritable(endpoint.fileno(), False)
        pid, uid, gid = struct.unpack('3i', endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        primitives.integer(pid, 1, 2**31 - 1)
        if (uid, gid) != (0, 0):
            fail('guardian peer must be root-owned')
        peer = GuardianPeer(primitives, endpoint, pid)
        supervisor_nonce = os.urandom(32).hex()
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        challenge = {'sequence': 0, 'kind': 'custody-request', 'body': {
            'supervisorNonce': supervisor_nonce, 'requestSha256': primitives.sha(request_sha),
            'inputTableSha256': primitives.sha(table_sha), 'guestBootId': boot}}
        sent = time.monotonic_ns()
        data = primitives.canonical(challenge)
        if endpoint.send(data, socket.MSG_NOSIGNAL) != len(data):
            fail('custody challenge short send')
        if not select.select([endpoint], [], [], 5)[0]:
            fail('custody response timeout')
        wire, ancillary, flags, _ = endpoint.recvmsg(65537, socket.CMSG_SPACE(12) + socket.CMSG_SPACE(256 * 4), socket.MSG_CMSG_CLOEXEC)
        credentials = []; invalid = False
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array('i')
                values.frombytes(payload[:len(payload) - len(payload) % values.itemsize])
                received.extend(values)
                if len(payload) % values.itemsize:
                    invalid = True
            elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(payload) == 12:
                credentials.append(struct.unpack('3i', payload))
            else:
                invalid = True
        now = time.monotonic_ns()
        if invalid or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or credentials != [(pid, 0, 0)] or len(received) != 1 or now - sent > 5_000_000_000:
            fail('guardian initial custody packet/FD/RTT differs')
        peer.assert_identity()
        packet = primitives.parse(wire, 65536)
        primitives.closed(packet, ['sequence', 'kind', 'body'])
        primitives.integer(packet['sequence'], 0, 0)
        if packet['kind'] != 'custody-context':
            fail('guardian custody type')
        body = packet['body']
        primitives.closed(body, ['supervisorNonce', 'requestSha256', 'inputTableSha256', 'guestBootId',
                                 'guardianLockFd', 'epochProof', 'hostHello', 'hostLifetime', 'hostObservedGuestNs',
                                 'hostRemainingMs', 'nativeDeadlineNs', 'fenceSha256', 'pid1Snapshot', 'guardianProcessProof'])
        if any(body[key] != challenge['body'][key] for key in challenge['body']):
            fail('guardian custody challenge binding differs')
        primitives.sha(body['fenceSha256'])
        snapshot = body['pid1Snapshot']
        primitives.closed(snapshot, [*PROPERTIES, 'deadlineNs'])
        if any(type(value) is not str for value in snapshot.values()):
            fail('guardian PID1 wire values must be bounded strings')
        observed = validate_unit_fields({key: snapshot[key] for key in PROPERTIES}, installation['execStopPost'])
        if observed['MainPID'] != pid or str(observed['deadlineNs']) != snapshot['deadlineNs']:
            fail('guardian actual PID1 observation differs from registered peer')
        process_proof = body['guardianProcessProof']
        primitives.closed(process_proof, ['pid', 'starttime', 'cgroup', 'entrySha256', 'interpreterSha256'])
        primitives.local_nanoseconds(process_proof['starttime'])
        if process_proof['pid'] != pid or process_proof['cgroup'] != '/system.slice/' + UNIT or process_proof['entrySha256'] != installation['guardian']['sha256'] or process_proof['interpreterSha256'] != installation['interpreter']['sha256']:
            fail('fixed guardian process/installation proof differs')
        epoch = body['epochProof']
        primitives.closed(epoch, ['managerEpoch', 'currentEpochProofSha256', 'channelNonce',
                                  'guardianSessionId', 'guestBootId', 'verifiedNs', 'deadlineNs'])
        verified = primitives.local_nanoseconds(epoch['verifiedNs'])
        deadline = primitives.local_nanoseconds(epoch['deadlineNs'])
        if not sent <= verified <= now < deadline <= verified + 15_000_000_000 or epoch['guestBootId'] != boot:
            fail('guardian epoch must be refreshed after custody challenge')
        # The pinned guardian is the sole MAC verifier/key owner. This peer-bound
        # response carries the already verified host frame, never key material.
        host_wire = primitives.canonical(body['hostHello'])
        envelope = body['hostHello']
        primitives.closed(envelope, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
        if type(envelope['version']) is not int or envelope['version'] != 1 or envelope['domain'] != primitives.CHANNEL_DOMAIN or envelope['direction'] != 'manager-to-supervisor' or envelope['keyId'] != key_id or type(envelope['sequence']) is not int or envelope['sequence'] != 0:
            fail('guardian-verified HOST_HELLO envelope identity differs')
        primitives.sha(envelope['mac'])
        host = envelope['payload']
        primitives.closed(host, ['type', 'channelNonce', 'guestBootId', 'estate', 'vmid', 'machineId',
                                 'guardianInstallationSha256', 'requestSha256', 'managerEpoch', 'hostBootId',
                                 'durableGeneration', 'managerStartNonce', 'authorityPolicySha256', 'guardianSessionId'])
        if host['type'] != 'HOST_HELLO' or host['estate'] != 'Proxmox1' or type(host['vmid']) is not int or host['vmid'] != 107 or host['machineId'] != '80a9dfd43bbc6a074cf9148daa5335c2':
            fail('wrong host handshake target')
        if host['requestSha256'] != request_sha or host['guestBootId'] != boot or host['guardianInstallationSha256'] != installation['guardianInstallationSha256'] or host['authorityPolicySha256'] != installation['authorityPolicySha256']:
            fail('host handshake policy/request differs')
        for key in ['channelNonce', 'managerEpoch', 'managerStartNonce', 'guardianSessionId']:
            primitives.sha(host[key])
        primitives.integer(host['durableGeneration'], 1, 2**53 - 1)
        if type(host['hostBootId']) is not str or not re.fullmatch('[a-f0-9-]{36}', host['hostBootId']):
            fail('invalid host boot identity')
        computed_epoch = primitives.digest({key: host[key] for key in ['hostBootId', 'durableGeneration', 'managerStartNonce', 'authorityPolicySha256']})
        if host['managerEpoch'] != computed_epoch or any(epoch[key] != host[key] for key in ['managerEpoch', 'channelNonce', 'guardianSessionId']) or epoch['currentEpochProofSha256'] != hashlib.sha256(host_wire).hexdigest():
            fail('guardian/host epoch proof differs')
        lifetime = body['hostLifetime']
        primitives.closed(lifetime, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
        if type(lifetime['version']) is not int or lifetime['version'] != 1 or lifetime['domain'] != primitives.CHANNEL_DOMAIN or lifetime['direction'] != 'manager-to-supervisor' or lifetime['keyId'] != key_id or type(lifetime['sequence']) is not int or lifetime['sequence'] != 1:
            fail('guardian-verified host lifetime envelope differs')
        primitives.sha(lifetime['mac'])
        control = lifetime['payload']
        primitives.closed(control, ['type', 'guestBootId', 'guardianSessionId', 'managerEpoch', 'requestSha256', 'hostRemainingMs', 'helloSha256'])
        if control['type'] != 'HOST_LIFETIME' or any(control[k] != host[k] for k in ['guestBootId', 'guardianSessionId', 'managerEpoch', 'requestSha256']) or control['helloSha256'] != primitives.digest(envelope) or control['hostRemainingMs'] != body['hostRemainingMs']:
            fail('guardian host lifetime binding differs')
        observed_ns = primitives.local_nanoseconds(body['hostObservedGuestNs'])
        primitives.integer(body['hostRemainingMs'], 1, 1800000)
        if not sent <= observed_ns <= now:
            fail('host lifetime observation predates custody challenge')
        # Guest-local timestamp at the guardian's HOST request, not its receipt:
        # transport/observation age is charged, no remote clock subtraction.
        native_deadline = primitives.local_nanoseconds(body['nativeDeadlineNs'])
        if native_deadline > observed['deadlineNs']:
            fail('native original lifetime exceeds guardian PID1 boundary')
        overall = min(observed['deadlineNs'], native_deadline, observed_ns + body['hostRemainingMs'] * 1000000)
        if now >= overall:
            fail('host/guest unit lifetime exhausted')
        remote_fd = primitives.integer(body['guardianLockFd'], 0, 2**31 - 1)
        # Report only our received FD number. The privileged owner compares its
        # original OFD against this actual authenticated child/FD via kcmp.
        adoption = {'supervisorNonce': supervisor_nonce, 'contextSha256': primitives.digest(body),
                    'supervisorFd': received[0], 'guardianLockFd': remote_fd}
        message = primitives.canonical({'sequence': 1, 'kind': 'custody-fd', 'body': adoption})
        if endpoint.send(message, socket.MSG_NOSIGNAL) != len(message):
            fail('custody descriptor adoption short send')
        left = min(sent + 5_000_000_000, deadline, overall) - time.monotonic_ns()
        if left <= 0 or not select.select([endpoint], [], [], left / 1000000000)[0]:
            fail('original custody descriptor adoption timeout')
        adopted = peer.receive()
        if adopted is None:
            fail('custody descriptor adoption absent')
        adopted = primitives.parse(adopted)
        primitives.closed(adopted, ['sequence', 'kind', 'body'])
        primitives.integer(adopted['sequence'], 1, 1)
        if adopted['kind'] != 'custody-fd-verified':
            fail('custody descriptor response type')
        proof = adopted['body']
        primitives.closed(proof, [*adoption, 'guardianPid', 'guardianStarttime', 'supervisorPid',
            'supervisorStarttime', 'sameOpenFileDescription', 'guardianLockHeld', 'guardianRecordSha256'])
        if any(proof[key] != value for key, value in adoption.items()) or proof['guardianPid'] != pid or proof['guardianStarttime'] != process_proof['starttime'] or proof['supervisorPid'] != os.getpid() or proof['sameOpenFileDescription'] is not True or proof['guardianLockHeld'] is not True:
            fail('guardian OFD proof/current descriptor binding differs')
        own_stat = Path('/proc/self/stat').read_text()
        own_start = own_stat[own_stat.rfind(')') + 2:].split()[19]
        if proof['supervisorStarttime'] != own_start:
            fail('OFD proof supervisor incarnation differs')
        primitives.sha(proof['guardianRecordSha256'])
        require_guardian_flock(pid, received[0])
        peer.assert_identity()
        if time.monotonic_ns() >= min(sent + 5_000_000_000, deadline, overall):
            fail('custody proof expired during descriptor adoption')
        result = object.__new__(InstalledGuardian)
        result.p, result.socket, result.peer = primitives, endpoint, peer
        result.pid, result.remote_lock_fd, result.lock_fd = pid, remote_fd, received[0]
        result.held = held + received
        result.epoch, result.deadline_ns = primitives.parse(primitives.canonical(epoch)), overall
        result.request_sha, result.fence_sha = request_sha, body['fenceSha256']
        result.ofd_receipt = proof
        result.out_sequence, result.failed, result.release_pending = 2, False, False
        # Context and OFD adoption consume guardian sequences0/1; live queue starts2.
        result.inbound_sequence = 2
        return result
    except BaseException:
        # Never flock-unlock or acknowledge settlement. A sent challenge followed
        # by failure leaves guardian/host responsible for its fence and timeout.
        for fd in held + received:
            try:
                os.close(fd)
            except OSError:
                pass
        if peer is not None:
            try:
                peer.close()
            except OSError:
                pass
        if endpoint is not None:
            try:
                endpoint.close()
            except OSError:
                pass
        raise


if __name__ == '__main__':
    raise SystemExit('Installed guardian connection is not a launcher; execution refused.')
