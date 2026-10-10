#!/usr/bin/env python3
"""Fixed guardian service. FD4 immutable entry, FD5 pinned installation library.

Sole Manager key/channel owner. Supervisor and workers receive only constrained,
peer-bound results. No generic signing, mutable command, image load or VM stop.
"""
import array
import fcntl
import hashlib
import json
import re
import os
from pathlib import Path
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import types

MAX = 1048576
UNIT = 'lunchlineup-development-guardian.service'
LOCK = '/run/lock/lunchlineup-deploy.lock'


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


def notify(value):
    address = os.environ['NOTIFY_SOCKET']
    if address.startswith('@'):
        address = '\0' + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as endpoint:
        endpoint.connect(address)
        require(endpoint.send(value.encode()) == len(value), 'PID1 notify short write')


def starttime(pid):
    text = Path('/proc', str(pid), 'stat').read_text()
    require(len(text) <= 8192, 'process identity bound')
    return text[text.rfind(')') + 2:].split()[19]


class Guardian:
    def __init__(self, installation, authority):
        self.i, self.a = installation, authority
        self.fds = {role: installation.pin(pin) for role, pin in authority['roles'].items()}
        self.modules = {role: installation.load_module(role, self.fds[role]) for role in
                        ['protocol', 'connection', 'workers', 'broker', 'history', 'sessionCustody', 'core', 'physicalCollector', 'nativeClient']}
        if 'pilotReducer' in self.fds:
            self.modules.update({role: installation.load_module(role, self.fds[role])
                                 for role in ('pilotReducer', 'pilotJournal')})
        self.p = self.modules['protocol']
        fd = installation.pin(authority['policy'], True)
        try:
            self.policy = self.p.parse(os.read(fd, MAX + 1))
        finally:
            os.close(fd)
        p, policy = self.p, self.policy
        p.closed(policy, ['installation', 'approvedRequestBindings', 'supervisorTable', 'lease',
                          'journalDirectory', 'nonceDirectory', 'supervisorProfile', 'ssh',
                          'worker', 'workerCgroup', 'brokerCgroup', 'candidate', 'physicalWriterProof', 'nativeInstallation', 'workflow', *(['pilotInputs'] if 'pilotInputs' in policy else [])])
        p.closed(policy['approvedRequestBindings'], ['requestSha256', 'guestBootId', 'inputTableSha256'])
        require(policy['workflow'] in ('no-execution', 'readonly-workers'), 'fixed guardian workflow')
        require(policy['supervisorProfile'] == 'lunchlineup-development-supervisor', 'fixed supervisor confinement')
        require(p.digest(policy['supervisorTable']) == policy['approvedRequestBindings']['inputTableSha256'], 'independent supervisor table differs')
        for role, pin in policy['supervisorTable'].items():
            if role == 'anchor':
                fd = installation.controlled(pin['path'])
                data = os.read(fd, MAX + 1)
                require(hashlib.sha256(data).hexdigest() == pin['sha256'] and p.parse(data)['workflow'] == policy['workflow'], 'supervisor anchor/workflow differs')
            else:
                fd = installation.pin({key: pin[key] for key in ['path', 'bytes', 'sha256', 'veritySha256']})
            info = os.fstat(fd)
            require((info.st_dev, info.st_ino) == (pin['device'], pin['inode']), 'supervisor input incarnation differs')
            self.fds['supervisor:' + role] = fd
        request_fd = self.fds['supervisor:approvedRequest']
        os.lseek(request_fd, 0, os.SEEK_SET)
        approved_request = p.parse(os.read(request_fd, MAX + 1))
        os.lseek(request_fd, 0, os.SEEK_SET)
        require(p.digest(approved_request) == policy['approvedRequestBindings']['requestSha256'] and
                p.digest(approved_request['selection']) == policy['lease']['selectionSha256'], 'guardian approved request/selection differs')
        self.approved_request = p.parse(p.canonical(approved_request))
        candidate = policy['candidate']
        p.closed(candidate, ['policy', 'inputs', 'inventoryBinding'])
        selected = approved_request['selection']
        require(candidate['policy']['sourceSha'] == selected['sourceSha'] and candidate['policy']['treeSha'] == selected['treeSha'] and
                candidate['inputs']['manifest']['path'] == selected['artifactManifest'] and
                candidate['inputs']['manifest']['sha256'] == selected['artifactManifestSha256'] and
                candidate['inputs']['helper']['sha256'] == approved_request['installedHelpers']['archivePreflight']['sha256'], 'guardian candidate selection differs')
        self.boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        require(self.boot == policy['approvedRequestBindings']['guestBootId'] and Path('/etc/machine-id').read_text().strip() == '80a9dfd43bbc6a074cf9148daa5335c2', 'guardian target/boot mismatch')
        for actual, role in [(4, 'guardian'), (5, 'installation')]:
            left, right = os.fstat(actual), os.fstat(self.fds[role])
            require((left.st_dev, left.st_ino) == (right.st_dev, right.st_ino), 'guardian inherited immutable role differs')
        require(Path('/proc/self/cgroup').read_text() == '0::/system.slice/' + UNIT + '\n', 'guardian PID1 cgroup')
        key_fd = installation.pin(authority['managerKey'], True, 32)
        try:
            self.key = os.read(key_fd, 33)
            require(len(self.key) == 32, 'guardian Manager key size')
        finally:
            os.close(key_fd)
        self.auth = p.Authenticator(self.key, authority['keyId'], p.ADMISSION_DOMAIN)
        self.handshake = p.EpochHandshake(self.key, authority['keyId'], self.boot,
             '80a9dfd43bbc6a074cf9148daa5335c2', policy['installation']['guardianInstallationSha256'],
             policy['approvedRequestBindings']['requestSha256'], policy['installation']['authorityPolicySha256'])
        self.local_id = os.urandom(32).hex()
        self.journal = self.modules['history'].Journal(p, policy['journalDirectory'], self.local_id)
        # O_EXCL fence survives any guardian/child/host failure. Only the exact
        # later durable terminal-release protocol may retire it; restart refuses.
        self.fence_fd = os.open('active.fence', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.journal.dirfd)
        fence = p.canonical({'localSessionId': self.local_id, 'guestBootId': self.boot,
                             'guardianPid': os.getpid(), 'guardianStarttime': starttime(os.getpid()),
                             'requestSha256': policy['approvedRequestBindings']['requestSha256']}) + b'\n'
        require(os.write(self.fence_fd, fence) == len(fence), 'guardian fence short write')
        os.fsync(self.fence_fd); os.fsync(self.journal.dirfd)
        self.fence_bytes = fence
        self.fence_sha = hashlib.sha256(fence).hexdigest()
        info = os.fstat(self.fence_fd)
        self.journal.append('FENCE_CREATED', {'fence': p.parse(fence[:-1]), 'guestFenceSha256': self.fence_sha,
            'device': str(info.st_dev), 'inode': str(info.st_ino)})
        self.lock_fd = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(self.lock_fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'deployment lock custody')
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.modules['connection'].require_guardian_flock(os.getpid(), self.lock_fd)
        self.out_sequence = self.in_sequence = 0
        self.pending = self.lease = self.request = self.terminal = self.ack = None
        self.worker = self.broker = None
        self.preflight = self.inventory = None
        self.worker_events = []
        self.worker_records = {}
        self.worker_phases = {}
        self.heartbeat = -1; self.last_owner = time.monotonic_ns()
        self.failed = False; self.released = False
        self.local_release = None; self.release_challenge = None
        self.terminal_proved = False
        self.release_proof = None
        self.release_committed = False
        self.retirement = None
        self.settlement = None
        self.worker_contexts = {}
        self.broker_responses = []
        self.response_bytes = 0
        self.phase = 'STARTING'
        self.original_deadline = time.monotonic_ns() + 1800_000_000_000
        self.started_ns = time.monotonic_ns()
        self.host = self.child = None
        self.endpoint = self.peer = None
        self.replies = []
        self.broker_last_progress = 0
        self.native = self.modules['nativeClient'].Client(self, policy['nativeInstallation'])
        self.native_broker_receipts = []; self.native_broker_handle = None
        self.physical = self.modules['physicalCollector'].Collector(self)

    def send(self, kind, body, fds=()):
        data = self.p.canonical({'sequence': self.out_sequence, 'kind': kind, 'body': body})
        require(len(data) <= MAX, 'guardian reply bound')
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', fds))] if fds else []
        require(self.endpoint.sendmsg([data], ancillary, socket.MSG_NOSIGNAL) == len(data), 'guardian reply short send')
        self.out_sequence += 1

    def launch_supervisor(self):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.child_control_fd = os.dup(child.fileno())
        os.set_inheritable(self.child_control_fd, False)
        # FD3 of guardian and supervisor are opposite endpoints of this exact pair.
        os.dup2(parent.fileno(), 3, inheritable=False)
        parent.close()
        self.endpoint = socket.socket(fileno=3)
        self.endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        self.endpoint.setblocking(False)
        copied = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 16) for fd in
                  [child.fileno(), self.fds['supervisorEntry'], self.fds['interpreter']]]
        profile = self.policy['supervisorProfile']
        def confine():
            import ctypes
            libc = ctypes.CDLL(None, use_errno=True)
            require(libc.prctl(38, 1, 0, 0, 0) == 0, 'supervisor no-new-privileges')
            # Root file ownership is needed by the existing journal grammar;
            # root UID must not confer capabilities or regain them on exec.
            for capability in range(41):
                require(libc.prctl(24, capability, 0, 0, 0) == 0, 'supervisor bounding capability drop')
            require(libc.prctl(28, 15, 0, 0, 0) == 0, 'supervisor locked no-root securebits')
            class CapHeader(ctypes.Structure):
                _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
            class CapData(ctypes.Structure):
                _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
            header, caps = CapHeader(0x20080522, 0), (CapData * 2)()
            require(libc.capset(ctypes.byref(header), ctypes.byref(caps)) == 0, 'supervisor capability clear')
            os.dup2(copied[0], 3, inheritable=True)
            os.dup2(copied[1], 4, inheritable=True)
            with open('/proc/self/attr/exec', 'w') as sink:
                sink.write('exec ' + profile)
        try:
            self.child = subprocess.Popen([self.a['roles']['interpreter']['path'], '-I', '/proc/self/fd/4'],
               executable='/proc/self/fd/' + str(copied[2]), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
               stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, cwd='/', close_fds=True,
               pass_fds=(3, 4, *copied), preexec_fn=confine)
            self.child_pidfd = os.pidfd_open(self.child.pid, 0)
            self.child_start = starttime(self.child.pid)
            self.peer = self.p.CredentialPeer(self.endpoint, self.child.pid, 0, 0, self.child_start,
                 '/system.slice/' + UNIT, self.a['roles']['interpreter']['sha256'], socket_creator=(os.getpid(), 0, 0))
        finally:
            child.close()
            for fd in copied:
                os.close(fd)
        self.phase = 'WAIT_CUSTODY'

    def supervisor_identity(self):
        self.peer.assert_identity()
        proc = Path('/proc', str(self.child.pid))
        require((proc / 'attr/current').read_text().strip() == self.policy['supervisorProfile'] + ' (enforce)', 'supervisor not confined')
        values = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
        require(values['NoNewPrivs'].strip() == '1' and all(int(values[k].strip(), 16) == 0 for k in
                ['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd']), 'supervisor privilege escalation/capabilities available')
        actual, expected = (proc / 'fd/4').stat(), os.fstat(self.fds['supervisorEntry'])
        require((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), 'supervisor immutable entry differs')

    def start_host(self, body):
        p = self.p
        p.closed(body, ['supervisorNonce', 'requestSha256', 'inputTableSha256', 'guestBootId'])
        p.sha(body['supervisorNonce'])
        require(all(body[key] == value for key, value in self.policy['approvedRequestBindings'].items()), 'custody request independent bindings')
        self.supervisor_identity()
        self.custody_request = body
        self.custody_observed = time.monotonic_ns()
        ssh = self.policy['ssh']
        p.closed(ssh, ['host', 'user', 'port', 'identity', 'knownHosts'])
        require(type(ssh['host']) is str and 0 < len(ssh['host']) <= 253 and not ssh['host'].startswith('-') and
                type(ssh['user']) is str and ssh['user'].isalnum(), 'fixed host identity')
        p.integer(ssh['port'], 1, 65535)
        for role in ['identity', 'knownHosts']:
            self.fds['ssh:' + role] = self.i.pin(ssh[role], True)
        self.host = subprocess.Popen(['/usr/bin/ssh', '-F', '/dev/null', '-T', '-o', 'BatchMode=yes',
            '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
            '-o', 'UserKnownHostsFile=/proc/self/fd/' + str(self.fds['ssh:knownHosts']),
            '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ConnectTimeout=3',
            '-o', 'ConnectionAttempts=1', '-i', '/proc/self/fd/' + str(self.fds['ssh:identity']),
            '-p', str(ssh['port']), ssh['user'] + '@' + ssh['host']],
            executable='/proc/self/fd/' + str(self.fds['ssh']), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, cwd='/', close_fds=True,
            pass_fds=(self.fds['ssh'], self.fds['ssh:knownHosts'], self.fds['ssh:identity']))
        self.stream = p.FramedStream(self.host.stdout.fileno(), self.host.stdin.fileno())
        self.stream.queue(self.handshake.begin())
        self.host_start = starttime(self.host.pid)
        self.phase = 'WAIT_HOST_HELLO'

    def terminal_deadline(self):
        # Non-renewing terminal wait. This is not LeaseProtocol.check: normal
        # renewal cadence ends at terminal, but original expiry never extends.
        require(self.lease is not None and time.monotonic_ns() < min(
            self.lease.expiry_ns, self.lease.overall_ns, self.original_deadline),
            'terminal settlement original lease deadline elapsed')

    def host_message(self, wire):
        p = self.p
        received = time.monotonic_ns()
        if self.phase == 'WAIT_HOST_HELLO':
            self.epoch = self.handshake.accept(wire)
            self.host_hello = p.parse(wire)
            self.phase = 'WAIT_HOST_LIFETIME'
            return
        envelope = p.parse(wire)
        if envelope.get('domain') == p.CHANNEL_DOMAIN:
            body = self.handshake.auth.inspect(wire, 'manager-to-supervisor')
            if self.phase == 'WAIT_HOST_LIFETIME':
                p.closed(body, ['type', 'guestBootId', 'guardianSessionId', 'managerEpoch', 'requestSha256', 'hostRemainingMs', 'helloSha256'])
                require(body['type'] == 'HOST_LIFETIME' and all(body[key] == self.host_hello['payload'][key] for key in
                    ['guestBootId', 'guardianSessionId', 'managerEpoch', 'requestSha256']) and body['helloSha256'] == p.digest(self.host_hello), 'host lifetime echo')
                p.integer(body['hostRemainingMs'], 1, 1800000)
                require(received - self.custody_observed < 5_000_000_000, 'host lifetime RTT')
                self.handshake.auth.consume('manager-to-supervisor')
                self.original_deadline = min(self.original_deadline, self.custody_observed + body['hostRemainingMs'] * 1000000)
                require(received < self.original_deadline, 'host original lifetime exhausted')
                self.journal.append('CUSTODY', {'request': self.custody_request, 'epoch': self.epoch,
                    'hostHello': self.host_hello, 'hostLifetime': envelope, 'observedNs': str(self.custody_observed), 'fenceSha256': self.fence_sha})
                observed = self.modules['connection'].unit_snapshot(self.policy['installation']['execStopPost'], self.physical.held['systemctl'])
                require(observed['MainPID'] == os.getpid(), 'custody snapshot guardian PID1 mismatch')
                actual, expected = Path('/proc/self/exe').stat(), os.fstat(self.fds['interpreter'])
                require((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), 'guardian actual interpreter differs')
                process_proof = {'pid': os.getpid(), 'starttime': starttime(os.getpid()), 'cgroup': '/system.slice/' + UNIT,
                    'entrySha256': self.a['roles']['guardian']['sha256'], 'interpreterSha256': self.a['roles']['interpreter']['sha256']}
                self.custody_context = dict(self.custody_request, guardianLockFd=self.lock_fd,
                    epochProof=self.epoch, hostHello=self.host_hello, hostLifetime=envelope,
                    hostObservedGuestNs=str(self.custody_observed), hostRemainingMs=body['hostRemainingMs'],
                    nativeDeadlineNs=str(self.native.deadline),
                    fenceSha256=self.fence_sha, pid1Snapshot={key: str(value) for key, value in observed.items()},
                    guardianProcessProof=process_proof)
                self.send('custody-context', self.custody_context, [self.lock_fd])
                self.phase = 'WAIT_CUSTODY_FD'
                self.last_owner = time.monotonic_ns()
                return
            if body.get('type') == 'HOST_CLEARED':
                self.host_cleared(envelope, received)
            elif body.get('type') in ('HOST_TERMINAL_CHECK', 'HOST_RELEASE_CHECK',
                                       'HOST_READONLY_TERMINAL_CHECK', 'HOST_READONLY_RELEASE_CHECK'):
                self.terminal_challenge(body, received)
            else:
                self.observe(body, received)
            return
        require(self.phase == 'READY' and self.lease is not None, 'admission frame before request')
        payload = self.auth.inspect(wire, 'manager-to-supervisor')
        if payload.get('type') == 'ACK':
            require(self.terminal is not None and self.ack is None, 'unsolicited terminal ACK')
            self.terminal_deadline()
            expected = dict(self.terminal)
            expected.pop('outcome'); expected['type'] = 'ACK'
            require(payload == expected, 'host terminal ACK mismatch')
            self.ack = envelope
        else:
            require(self.terminal is None, 'nonterminal host frame after terminal')
            self.lease.transition('manager-to-supervisor', payload, received)
        self.journal.append('MANAGER', {'envelope': envelope, 'observedNs': str(received)})
        self.auth.consume('manager-to-supervisor')
        if payload.get('type') == 'ACK':
            self.terminal_deadline()
        self.send('manager', envelope)
        if payload.get('type') == 'REVOKE':
            raise RuntimeError('Manager revoked guardian custody')

    def observe(self, body, received):
        p = self.p
        p.closed(body, ['type', 'guestBootId', 'guardianSessionId', 'managerEpoch', 'requestSha256',
             'guardianInstallationSha256', 'observationNonce', 'vmid', 'selectionSha256', 'custodyPolicySha256', 'requestNonce', 'inputTableSha256'])
        require(self.request is not None and body['type'] in ('HOST_OBSERVE', 'HOST_PILOT_BOUNDARY_CHECK') and type(body['vmid']) is int and body['vmid'] == 107, 'observation before registered request')
        expected = dict(self.policy['approvedRequestBindings'], guardianSessionId=self.epoch['guardianSessionId'],
             managerEpoch=self.epoch['managerEpoch'], guardianInstallationSha256=self.policy['installation']['guardianInstallationSha256'],
             requestNonce=self.request['nonce'], selectionSha256=self.policy['lease']['selectionSha256'],
             custodyPolicySha256=self.policy['lease']['custodyPolicySha256'])
        require(all(body[key] == value for key, value in expected.items()), 'observation identity mismatch')
        p.sha(body['observationNonce'])
        self.journal.append('OBSERVATION_CHALLENGE', {'payload': body, 'receivedNs': str(received)})
        self.handshake.auth.consume('manager-to-supervisor')
        receipt = self.physical_writer_gate(received)
        payload = dict(body, type='GUEST_OBSERVATION', machineId='80a9dfd43bbc6a074cf9148daa5335c2',
            guardianPid1Verified=True, sharedLockVerified=True, daemonIpcConfined=True,
            exclusiveWriter=True, mutationAdmissionDenied=True, physicalReceipt=receipt,
            physicalReceiptSha256=p.digest(receipt))
        if body['type'] == 'HOST_PILOT_BOUNDARY_CHECK':
            require(time.monotonic_ns() < min(self.native.deadline, self.original_deadline),
                    'pilot boundary original native/host deadline')
            # Live fixed-source observation, not signing supervisor data or
            # asserting persistent-engine facts from the native QA collector.
            payload['type'] = 'GUEST_PILOT_BOUNDARY'
            payload['pilotBoundary'] = {
                'observationScope': 'native-qa-readonly',
                'installedWorkflow': self.policy['workflow'],
                'pilotLibrariesLoaded': all(name in self.modules for name in ('pilotReducer', 'pilotJournal')),
                'guardianEntrySha256': self.a['roles']['guardian']['sha256'],
                'installationLibrarySha256': self.a['roles']['installation']['sha256'],
                'persistentTruthImplemented': False, 'persistentMutationAuthorized': False,
                'activationAuthorized': False, 'deadOwnerKeyAccessAllowed': False,
                'unavailable': ['persistent-engine-observer', 'independent-persistent-recovery',
                    'producer-runtime-gates', 'live-handoff-effect-producer', 'dead-owner-authenticated-handoff'],
            }
        self.journal.append('OBSERVATION_PRODUCED', payload)
        self.physical.budget()
        require(time.monotonic_ns() - received < 3_000_000_000, 'physical observation original RTT expired')
        envelope = self.handshake.auth.envelope(payload, 'supervisor-to-manager')
        self.stream.queue(p.canonical(envelope))
        self.handshake.auth.consume('supervisor-to-manager')

    def physical_writer_gate(self, original_challenge_ns):
        # Fixed independently pinned collector, actual policy/kernel evidence.
        # None policy or any missing/unreadable installed control refuses.
        return self.physical.collect(original_challenge_ns)

    def terminal_challenge(self, body, received):
        p = self.p
        require(self.lease is not None and time.monotonic_ns() < min(self.lease.expiry_ns, self.lease.overall_ns, self.original_deadline), 'terminal original lease expired')
        readonly = self.terminal is not None and self.terminal['outcome'] == 'readonly-observed'
        release = body.get('type') in ('HOST_RELEASE_CHECK', 'HOST_READONLY_RELEASE_CHECK')
        require(body.get('type') == (('HOST_READONLY_RELEASE_CHECK' if release else 'HOST_READONLY_TERMINAL_CHECK')
                if readonly else ('HOST_RELEASE_CHECK' if release else 'HOST_TERMINAL_CHECK')), 'challenge workflow mismatch')
        fields = ['type', 'grantId', 'managerEpoch', 'guestBootId', 'requestSha256', 'challengeNonce',
                  'guardianSessionId', 'requestNonce', 'terminalSha256', 'inputTableSha256', 'selectionSha256']
        p.closed(body, fields + (['ackSha256'] if release else []))
        require(self.terminal is not None and self.request is not None and self.lease.pending is None and
                self.worker is None and self.broker is None and self.pending is None and not self.replies and
                (readonly or not self.journal.workers.workers), 'terminal challenge has pending/unknown work')
        expected = self.terminal_bindings()
        require(all(body[key] == value for key, value in expected.items()), 'terminal challenge bindings differ')
        p.sha(body['challengeNonce'])
        self.handshake.auth.consume('manager-to-supervisor')
        if release:
            require(self.release_challenge is None and self.release_proof is None and self.local_release is None and self.ack is not None and body['ackSha256'] == p.digest(self.ack['payload']), 'release challenge identity/phase')
            # Host challenge may precede supervisor's durable ACK forwarding.
            # Keep original receipt time and finish only after local unlock.
            self.journal.append('TERMINAL_CHALLENGE_RECEIVED', {'payload': body, 'receivedNs': str(received)})
            self.release_challenge = {'body': body, 'receivedNs': received}
            if hasattr(self, 'forwarded_ack_observation'):
                self.unlock_settled_work(self.forwarded_ack_observation)
            return
        require(not self.terminal_proved and self.local_release is None, 'terminal proof is one-shot')
        self.journal.append('TERMINAL_CHALLENGE_RECEIVED', {'payload': body, 'receivedNs': str(received)})
        self.physical_writer_gate(received)
        self.modules['connection'].require_guardian_flock(os.getpid(), self.lock_fd)
        observed = self.modules['connection'].unit_snapshot(self.policy['installation']['execStopPost'], self.physical.held['systemctl'])
        require(observed['MainPID'] == os.getpid(), 'terminal guardian PID1 incarnation differs')
        terminal_event = 'READONLY_TERMINAL' if readonly else 'TERMINAL'
        observation = self.verify_history(terminal_event)
        require(observation['terminal'] == self.terminal and observation['managerAck'] is None, 'terminal complete history mismatch')
        receipt = self.journal.append('TERMINAL_HISTORY_PROOF', observation)
        row = self.read_core(self.request['nonce'], require_event=terminal_event)['last']
        require(hashlib.sha256(p.canonical(row) + b'\n').hexdigest() == self.terminal['ledgerSha256'], 'terminal ledger binding')
        payload = dict(body, type='GUEST_TERMINAL_PROOF', terminalRow=row, historyReceiptSha256=receipt,
            historyVerified=True, admissionFenced=True, writerExclusionRetained=True, guardianPid1Verified=True,
            guardianLockHeld=True, everDispatched=False, pendingRenewal=False, registeredChildren=[],
            daemonRequestsDispatched=0, unknownRequests=0)
        payload['guestFenceSha256'] = self.fence_identity()['guestFenceSha256']
        if readonly:
            self.settlement = self.worker_settlement(observation, received)
            for key in ['everDispatched', 'daemonRequestsDispatched']:
                del payload[key]
            payload.update(type='GUEST_READONLY_TERMINAL_PROOF', settlement=self.settlement, mutationRequestsDispatched=0)
        self.terminal_deadline()
        require(time.monotonic_ns() - received < 3_000_000_000, 'original terminal proof deadline')
        envelope = self.handshake.auth.envelope(payload, 'supervisor-to-manager')
        self.journal.append('TERMINAL_PROOF', envelope)
        self.terminal_deadline()
        require(time.monotonic_ns() - received < 3_000_000_000, 'terminal proof persistence deadline')
        self.stream.queue(p.canonical(envelope))
        self.handshake.auth.consume('supervisor-to-manager')
        self.terminal_proved = True

    def unlock_settled_work(self, observation):
        require(time.monotonic_ns() < min(self.lease.expiry_ns, self.lease.overall_ns, self.original_deadline), 'unlock original lease expired')
        require(self.terminal_proved and self.local_release is None and self.release_challenge is not None and
                self.ack is not None and self.worker is None and self.broker is None and not self.replies and
                self.pending is None and self.lease.pending is None, 'physical release phase/settled registry')
        observation = self.verify_history('ACK')
        preunlock_settlement = None
        if self.terminal['outcome'] == 'readonly-observed':
            preunlock_settlement = self.refresh_worker_settlement(observation, self.release_challenge['receivedNs'])
        else:
            require(not self.journal.workers.workers, 'zero-worker release has registered work')
        self.physical_writer_gate(self.release_challenge['receivedNs'])
        self.modules['connection'].require_guardian_flock(os.getpid(), self.lock_fd)
        self.journal.append('UNLOCK_INTENT', {'ackSha256': self.p.digest(self.ack['payload']),
            'terminalSha256': self.p.digest(self.terminal), 'observation': observation,
            'daemonSettlementReceiptSha256': None if preunlock_settlement is None else
                preunlock_settlement['physicalSettlementReceiptSha256']})
        # Sole deliberate unlock: exact same original OFD, after authenticated
        # durable ACK forwarding and full protected worker/daemon or zero-work proof.
        # Session retains unlocked duplicates until fence-retired; it never unlocks.
        # UNLOCK_INTENT fsync and physical observations consume the original
        # budget. Recheck at the irreversible boundary, with no refreshed anchor.
        now = time.monotonic_ns()
        require(now < min(self.lease.expiry_ns, self.lease.overall_ns, self.original_deadline),
                'unlock original lease expired after intent persistence')
        require(0 <= now - self.release_challenge['receivedNs'] < 3_000_000_000,
                'unlock original release challenge expired after intent persistence')
        fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
        self.require_lock_absent()
        proof = self.journal.append('UNLOCK_OBSERVED', {'ackSha256': self.p.digest(self.ack['payload']),
            'lockDevice': str(os.fstat(self.lock_fd).st_dev), 'lockInode': str(os.fstat(self.lock_fd).st_ino)})
        self.local_release = {'nonce': self.request['nonce'], 'requestSha256': self.request['requestSha256'],
            'guardianSessionId': self.epoch['guardianSessionId'], 'ackSha256': self.p.digest(self.ack['payload']),
            'fenceReceiptSha256': proof}
        self.journal.append('LOCAL_RELEASE', self.local_release)
        self.terminal_deadline()
        require(time.monotonic_ns() - self.release_challenge['receivedNs'] < 3_000_000_000, 'local release persistence deadline')
        self.send('custody-released', self.local_release)

    def require_lock_absent(self):
        info = os.fstat(self.lock_fd)
        with open('/proc/locks') as source:
            data = source.read(MAX + 1)
        require(len(data) <= MAX, 'kernel flock observation bound')
        for line in data.splitlines():
            fields = line.split()
            if len(fields) < 6 or fields[1] == '->':
                continue
            numbers = fields[5].split(':')
            require(len(numbers) == 3, 'kernel lock identity grammar')
            if (int(numbers[0], 16), int(numbers[1], 16), int(numbers[2])) == (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino):
                require(fields[1] != 'FLOCK', 'deployment OFD flock remains/reappeared')

    def poll_release(self):
        if self.release_challenge is None:
            return
        require(time.monotonic_ns() < min(self.lease.expiry_ns, self.lease.overall_ns, self.original_deadline), 'release original lease expired')
        received, body = self.release_challenge['receivedNs'], self.release_challenge['body']
        require(time.monotonic_ns() - received < 3_000_000_000, 'original release challenge deadline')
        if self.local_release is None or not self.release_committed:
            return
        self.physical_writer_gate(received)
        self.require_lock_absent()
        observed = self.modules['connection'].unit_snapshot(self.policy['installation']['execStopPost'], self.physical.held['systemctl'])
        require(observed['MainPID'] == os.getpid(), 'release guardian PID1 incarnation differs')
        observation = self.verify_history('GUARDIAN_RELEASE')
        require(observation['guardianReleaseRecord'] == self.local_release, 'release core record differs')
        receipt = self.journal.append('RELEASE_HISTORY_PROOF', observation)
        payload = dict(body, type='GUEST_RELEASE_PROOF', releaseReceipt=self.local_release,
            historyReceiptSha256=receipt, historyVerified=True, admissionFenced=True, writerExclusionRetained=True,
            guardianPid1Verified=True, guardianLockAbsent=True, daemonIpcConfined=True, everDispatched=False,
            pendingRenewal=False, registeredChildren=[], daemonRequestsDispatched=0, unknownRequests=0)
        payload['guestFenceSha256'] = self.fence_identity()['guestFenceSha256']
        if self.terminal['outcome'] == 'readonly-observed':
            current = self.refresh_worker_settlement(observation, received)
            for key in ['everDispatched', 'daemonRequestsDispatched']:
                del payload[key]
            payload.update(type='GUEST_READONLY_RELEASE_PROOF', settlementSha256=self.p.digest(self.settlement),
                           daemonReadSettlement=current['daemonReadSettlement'], mutationRequestsDispatched=0)
        self.terminal_deadline()
        require(time.monotonic_ns() - received < 3_000_000_000, 'release proof original deadline')
        envelope = self.handshake.auth.envelope(payload, 'supervisor-to-manager')
        self.journal.append('RELEASE_PROOF', envelope)
        self.terminal_deadline()
        require(time.monotonic_ns() - received < 3_000_000_000, 'release proof persistence deadline')
        self.stream.queue(self.p.canonical(envelope))
        self.handshake.auth.consume('supervisor-to-manager')
        self.release_challenge = None
        self.release_proof = envelope
        # Keep supervisor and all original deadlines through HOST_CLEARED.

    def admission_request(self, body):
        p = self.p
        p.closed(body, ['payload', 'sentNs'])
        require(self.pending is None and self.phase == 'READY', 'admission signing phase')
        payload = body['payload']; kind = payload.get('type')
        sent = p.local_nanoseconds(body['sentNs']); now = time.monotonic_ns()
        require(self.custody_observed <= sent <= now and now - sent < 5_000_000_000, 'admission original request time')
        if kind == 'REQUEST':
            require(self.request is None, 'one fresh request binding only')
            p.closed(payload, ['type', 'nonce', 'requestSha256', 'guestBootId', 'inputTableSha256'])
            p.sha(payload['nonce'])
            require(all(payload[key] == value for key, value in self.policy['approvedRequestBindings'].items()), 'request independent approval differs')
            # Nonce reservation is independently read from exact protected core
            # history; supervisor cannot obtain a generic signing primitive.
            registered = self.read_core(payload['nonce'], require_event='LEASE_CONTEXT')['last']['details']
            require(registered == {'request': payload, 'epoch': self.epoch, 'policy': self.policy['lease'],
                'requestSentNs': str(sent), 'unitDeadlineNs': str(self.original_deadline)}, 'registered request context differs')
            self.request = p.parse(p.canonical(payload))
            self.lease = p.LeaseProtocol(payload, self.epoch, self.policy['lease'], sent, self.original_deadline)
        elif kind == 'RENEW':
            require(self.request is not None and self.terminal is None, 'renewal phase')
            core = self.read_core(self.request['nonce'])
            require(payload.get('ledgerSha256') == core['sha256'] and payload.get('unresolvedSummarySha256') == p.digest(core['workerPhases']), 'renewal history/worker summary mismatch')
            # Reducer order uses guardian receive time; expiry remains anchored
            # conservatively to the earlier registered supervisor send time.
            self.lease.transition('supervisor-to-manager', payload, now)
            self.lease.renew_sent_ns = sent
        elif kind == 'TERMINAL':
            require(self.request is not None and self.terminal is None and self.worker is None and self.broker is None and
                    not self.replies, 'terminal has unsettled work')
            self.lease.check(now)
            require(self.lease.pending is None, 'terminal with outstanding renewal')
            readonly = self.policy['workflow'] == 'readonly-workers'
            core = self.read_core(self.request['nonce'], require_event='READONLY_TERMINAL' if readonly else 'TERMINAL')
            details = core['last']['details']
            if readonly:
                p.closed(details, ['outcome', 'workerSummarySha256', 'preflightSha256', 'inventorySha256',
                                   'mutationRequestsDispatched', 'authorityRestored', 'fenceClearAuthorized'])
                workers = self.modules['history'].verify_worker_history(p, list(self.worker_records.values()))
                require(workers['settled'] is True and len(workers['workers']) == 2 and
                        set(w['role'] for w in workers['workers'].values()) == {'archive-preflight', 'image-inventory'} and
                        self.preflight is not None and self.inventory is not None and details == {
                            'outcome': 'readonly-observed', 'workerSummarySha256': p.digest(core['workerPhases']),
                            'preflightSha256': p.digest(self.preflight), 'inventorySha256': p.digest(self.inventory),
                            'mutationRequestsDispatched': 0, 'authorityRestored': False, 'fenceClearAuthorized': False},
                        'worker terminal history/results differ')
            else:
                require(not self.journal.workers.workers and details == {'outcome': 'no-execution', 'cliSettled': True,
                        'daemonRequestsDispatched': 0, 'survivors': []}, 'no-execution terminal contains work')
            expected = {'type': 'TERMINAL', 'nonce': self.request['nonce'], 'requestSha256': self.request['requestSha256'],
                'ledgerSha256': core['sha256'], 'outcome': details['outcome'], 'grantId': self.lease.grant['grantId'],
                'managerEpoch': self.epoch['managerEpoch'], 'grantSequence': self.lease.sequence, 'guestBootId': self.boot}
            require(payload == expected, 'terminal physical/history identity differs')
            self.terminal = expected
        else:
            raise RuntimeError('guardian refuses generic signing or mutation admission')
        envelope = self.auth.envelope(payload, 'supervisor-to-manager')
        self.journal.append('OUTGOING_PREPARED', {'envelope': envelope, 'sentNs': str(sent)})
        if kind == 'REQUEST':
            self.native.bind()
        self.pending = {'envelope': envelope, 'sentNs': sent}
        self.send('admission-outgoing', envelope)

    def read_core(self, nonce, require_event=None):
        p = self.p; p.sha(nonce)
        path = Path(self.policy['nonceDirectory']) / nonce
        fd = self.i.controlled(path, True)
        try:
            before = os.fstat(fd)
            data = os.read(fd, 4 * MAX + 1)
            after = os.fstat(fd)
            require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                    0 < len(data) <= 4 * MAX and data.endswith(b'\n'), 'core snapshot partial/changed')
        finally:
            os.close(fd)
        previous = '0' * 64
        worker_phases = {}
        rows = data.splitlines(keepends=True)
        require(len(rows) <= 4096, 'core snapshot row bound')
        for index, raw in enumerate(rows):
            row = p.parse(raw[:-1]); p.closed(row, ['sequence', 'previous', 'event', 'details'])
            require(p.canonical(row) + b'\n' == raw and type(row['sequence']) is int and row['sequence'] == index and row['previous'] == previous, 'core snapshot chain')
            if index == 0:
                require(row['event'] == 'RESERVED' and row['details'] == {'nonce': nonce,
                    'requestSha256': self.policy['approvedRequestBindings']['requestSha256']}, 'core reserved identity')
            if row['event'] == 'WORKER_EVENT':
                detail = row['details']
                event = self.worker_records.get(detail['guardianRecordSha256'])
                require(event is not None and p.digest(event) == detail['eventSha256'] and event['workerNonce'] == detail['workerNonce'] and event['type'] == detail['type'], 'core worker event is not guardian-produced')
                worker_phases[detail['workerNonce']] = detail['phase']
            previous = hashlib.sha256(raw).hexdigest()
        require(require_event is None or row['event'] == require_event, 'core expected durable event')
        return {'sha256': previous, 'last': row, 'bytes': data, 'workerPhases': worker_phases}

    def admission_commit(self, body):
        p = self.p
        p.closed(body, ['envelopeSha256', 'ledgerSha256'])
        require(self.pending is not None and body['envelopeSha256'] == p.digest(self.pending['envelope']) and
                time.monotonic_ns() - self.pending['sentNs'] < 5_000_000_000, 'outgoing commit identity/deadline')
        core = self.read_core(self.request['nonce'])
        require(body['ledgerSha256'] == core['sha256'], 'outgoing commit core link differs')
        exchange_fd = self.i.controlled(Path(self.policy['nonceDirectory']) / (self.request['nonce'] + '.exchange'), True)
        try:
            before = os.fstat(exchange_fd)
            exchange = os.read(exchange_fd, 4 * MAX + 1)
            after = os.fstat(exchange_fd)
            require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                    0 < len(exchange) <= 4 * MAX and exchange.endswith(b'\n'), 'outgoing exchange partial/unstable')
            last = p.parse(exchange.splitlines()[-1])
            require(last == {'direction': 'supervisor', 'message': self.pending['envelope']}, 'outgoing envelope not committed in exchange')
        finally:
            os.close(exchange_fd)
        if self.pending['envelope']['payload']['type'] == 'TERMINAL':
            observation = self.verify_history('READONLY_TERMINAL' if self.terminal['outcome'] == 'readonly-observed' else 'TERMINAL')
            require(observation['terminal'] == self.terminal, 'terminal full ordered history differs before commit')
            self.terminal_deadline()
        self.journal.append('OUTGOING_COMMITTED', body)
        if self.terminal is not None:
            self.terminal_deadline()
        self.stream.queue(p.canonical(self.pending['envelope']))
        self.auth.consume('supervisor-to-manager')
        self.pending = None

    def supervisor_message(self, wire):
        p = self.p
        value = p.parse(wire)
        p.closed(value, ['sequence', 'kind', 'body'])
        p.integer(value['sequence'], self.in_sequence, self.in_sequence)
        self.in_sequence += 1
        kind, body = value['kind'], value['body']
        if kind == 'custody-request':
            require(self.phase == 'WAIT_CUSTODY', 'duplicate custody request')
            self.start_host(body)
        elif kind == 'custody-fd':
            require(self.phase == 'WAIT_CUSTODY_FD', 'unexpected/duplicate custody descriptor adoption')
            p.closed(body, ['supervisorNonce', 'contextSha256', 'supervisorFd', 'guardianLockFd'])
            require(body['supervisorNonce'] == self.custody_request['supervisorNonce'] and
                    body['contextSha256'] == p.digest(self.custody_context) and body['guardianLockFd'] == self.lock_fd,
                    'custody descriptor challenge/context mismatch')
            p.integer(body['supervisorFd'], 0, 2**31 - 1)
            self.supervisor_identity()
            # Privileged actual comparison of the original guardian OFD with
            # the descriptor in this registered child. No inode-only fallback.
            p.require_shared_lock(self.child.pid, body['supervisorFd'], self.lock_fd)
            self.modules['connection'].require_guardian_flock(os.getpid(), self.lock_fd)
            proof = dict(body, guardianPid=os.getpid(), guardianStarttime=starttime(os.getpid()),
                supervisorPid=self.child.pid, supervisorStarttime=self.child_start,
                sameOpenFileDescription=True, guardianLockHeld=True)
            record = self.journal.append('SUPERVISOR_OFD_ADOPTED', proof)
            require(time.monotonic_ns() < min(self.original_deadline, self.custody_observed + 5_000_000_000),
                    'original custody descriptor adoption deadline')
            self.supervisor_identity()
            p.require_shared_lock(self.child.pid, body['supervisorFd'], self.lock_fd)
            require(time.monotonic_ns() < min(self.original_deadline, self.custody_observed + 5_000_000_000),
                    'original custody descriptor deadline after OFD recheck')
            self.supervisor_lock_fd = body['supervisorFd']
            self.send('custody-fd-verified', dict(proof, guardianRecordSha256=record))
            self.phase = 'READY'
        elif kind == 'owner-progress':
            p.closed(body, ['heartbeatSequence'])
            p.integer(body['heartbeatSequence'], self.heartbeat + 1, self.heartbeat + 1)
            self.heartbeat = body['heartbeatSequence']; self.last_owner = time.monotonic_ns()
        elif kind == 'admission-request':
            self.admission_request(body)
        elif kind == 'admission-commit':
            self.admission_commit(body)
        elif kind == 'worker-start':
            self.start_worker(body)
        elif kind == 'terminal-ack':
            self.terminal_deadline()
            require(self.ack is not None and p.canonical(body) == p.canonical(self.ack), 'forwarded terminal ACK differs')
            # Exact host ACK alone is not settlement. Protected full history is
            # verified inside guardian; no key is returned to the supervisor.
            observation = self.verify_history('ACK')
            require(observation['managerAck'] == self.ack['payload'] and self.worker is None and self.broker is None, 'terminal protected history incomplete')
            self.journal.append('TERMINAL_VERIFIED', observation)
            self.forwarded_ack_observation = observation
            if self.release_challenge is not None:
                self.unlock_settled_work(observation)
        elif kind == 'release-commit':
            p.closed(body, ['releaseReceiptSha256', 'ledgerSha256'])
            self.terminal_deadline()
            require(self.local_release is not None and not self.release_committed and
                    body['releaseReceiptSha256'] == p.digest(self.local_release), 'release commit phase/receipt')
            snapshot = self.read_core(self.request['nonce'], require_event='GUARDIAN_RELEASE')
            require(snapshot['sha256'] == body['ledgerSha256'] and snapshot['last']['details'] == self.local_release,
                    'release commit exact durable core differs')
            require(self.verify_history('GUARDIAN_RELEASE')['guardianReleaseRecord'] == self.local_release,
                    'release commit full history differs')
            self.journal.append('RELEASE_COMMITTED', body)
            self.terminal_deadline()
            self.release_committed = True
        elif kind in ('fence', 'retain-unresolved'):
            if kind == 'retain-unresolved' and self.request is not None:
                p.closed(body, ['nonce', 'requestSha256', 'guardianSessionId'])
                require(body == {'nonce': self.request['nonce'], 'requestSha256': self.request['requestSha256'], 'guardianSessionId': self.epoch['guardianSessionId']}, 'unresolved request identity differs')
                # Observation only, through protected actual context/key owner.
                # A partial history fails and remains unresolved; no fallback.
                self.journal.append('HISTORY_OBSERVATION', self.verify_history())
            raise RuntimeError('supervisor requested unresolved custody')
        else:
            raise RuntimeError('unknown supervisor request')

    def require_pilot_custody(self):
        require(os.geteuid() == 0 and not self.failed and not self.released and
                self.request is not None and self.lease is not None and self.terminal is None and
                self.worker is None and self.broker is None and self.pending is None and
                self.lease.pending is None and 'pilotReducer' in self.modules and
                'pilotJournal' in self.modules and 'pilotInputs' in self.policy,
                'pilot requires actual installed settled guardian custody and held roles')
        self.supervisor_identity()
        self.modules['connection'].require_guardian_flock(os.getpid(), self.lock_fd)
        self.fence_identity()
        now = time.monotonic_ns()
        self.lease.check(now)
        require(now + 5_000_000_000 < min(self.lease.overall_ns, self.original_deadline,
                    self.lease.sent_ns + 180_000_000_000), 'pilot original budget/terminal reserve exhausted')

    def read_pinned_pilot_inputs(self):
        self.require_pilot_custody()
        # Root-installed hash+verity pin, never a supervisor path/body/FD.
        fd = self.i.pin(self.policy['pilotInputs'])
        try:
            value = self.p.parse(os.read(fd, MAX + 1))
        finally:
            os.close(fd)
        self.p.closed(value, ['bundle', 'expected'])
        expected = value['expected']
        self.p.closed(expected, ['scopeSha256', 'requestSha256', 'selectionSha256', 'sourceSha', 'treeSha',
            'guestBootId', 'managerEpoch', 'guardianSessionId', 'originalStartNs', 'originalDeadlineNs'])
        actual = {'requestSha256': self.request['requestSha256'],
            'selectionSha256': self.policy['lease']['selectionSha256'],
            'sourceSha': self.approved_request['selection']['sourceSha'],
            'treeSha': self.approved_request['selection']['treeSha'], 'guestBootId': self.boot,
            'managerEpoch': self.epoch['managerEpoch'], 'guardianSessionId': self.epoch['guardianSessionId'],
            'originalStartNs': str(self.lease.sent_ns),
            'originalDeadlineNs': str(min(self.lease.overall_ns, self.original_deadline,
                                         self.lease.sent_ns + 180_000_000_000))}
        require(all(expected[key] == value for key, value in actual.items()), 'pinned pilot context differs from actual owner')
        self.p.sha(expected['scopeSha256'])
        now = time.monotonic_ns()
        for record in value['bundle'].get('records', []):
            require(self.p.local_nanoseconds(record['payload']['observedNs']) <= now, 'future signed observation refused')
        self.require_pilot_custody()
        return value['bundle'], expected

    def require_pilot_truth(self, observation):
        # No caller callback, boolean receipt or selected module can replace
        # independently installed persistent runtime/DB/queue/recovery observers.
        # Existing physical_writer_gate observes the QA engine, not this target.
        raise RuntimeError('persistent engine/resource/quarantine/recovery truth adapters are not installed or implemented')

    def commit_pilot_history(self):
        # Internal pinned owner method; not exposed over supervisor IPC or CLI.
        try:
            self.require_pilot_custody()
            return self.modules['pilotJournal'].append_to_existing_wal(self)
        except BaseException:
            self.fence('pilot history admission/persistence unresolved')
            raise

    def replay_pilot_history(self):
        # Same owner/key and complete protected WAL; historical result never
        # renews a lease, dispatches an effect or accepts a read-only terminal.
        self.require_pilot_custody()
        _, expected = self.read_pinned_pilot_inputs()
        snapshot = self.protected_history()
        previous = None; result = None
        for record in snapshot['rows']:
            if record['row']['kind'] != 'PILOT_HISTORY':
                continue
            body = record['row']['body']
            self.p.closed(body, ['bundle', 'expected', 'receiptTailSha256', 'authorityRestored', 'mutationAuthorized'])
            require(body['expected'] == expected and body['authorityRestored'] is False and
                    body['mutationAuthorized'] is False, 'protected pilot context/authority differs')
            bundle = body['bundle']
            if previous is None:
                require(bundle['records'] == [], 'protected pilot history lacks genesis commit')
            else:
                require(bundle['scope'] == previous['scope'] and bundle['genesis'] == previous['genesis'] and
                        bundle['records'][:-1] == previous['records'] and len(bundle['records']) == len(previous['records']) + 1,
                        'protected pilot WAL omitted/replayed event')
            result = self.modules['pilotJournal'].replay(self.p, self.modules['pilotReducer'], self.key,
                self.a['keyId'], bundle, expected)
            require(body['receiptTailSha256'] == result['receiptTailSha256'], 'protected pilot receipt tail differs')
            previous = bundle
            self.require_pilot_custody()
        require(result is not None, 'no authenticated pilot WAL history')
        return result

    def verify_history(self, last_event=None):
        p = self.p
        protected_snapshot = self.protected_history()
        require(not any(row['row']['kind'] == 'PILOT_HISTORY' for row in protected_snapshot['rows']),
                'pilot history requires separate recovery; cannot qualify read-only terminal')
        snapshot = self.read_core(self.request['nonce'], require_event=last_event)
        expected = {'nonce': self.request['nonce'], 'requestSha256': self.request['requestSha256'],
            'inputTableSha256': self.request['inputTableSha256'], 'epochProofSha256': p.digest(self.epoch), 'policy': self.policy['lease']}
        fd = self.i.controlled(Path(self.policy['nonceDirectory']) / (self.request['nonce'] + '.exchange'), True)
        try:
            before = os.fstat(fd)
            exchange = os.read(fd, 4 * MAX + 1)
            after = os.fstat(fd)
            require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'exchange changed during verification')
        finally:
            os.close(fd)
        protected = [{'guardianRecordSha256': identity, 'event': event}
                     for identity, event in self.worker_records.items()]
        workers = self.modules['history'].verify_worker_history(p, [record['event'] for record in protected])
        observation = self.modules['sessionCustody'].verify_control_history(p, self.key, self.a['keyId'],
            snapshot['bytes'], exchange, expected, worker_records=protected)
        terminal = observation['readonlyTerminal']
        if terminal is not None:
            require(observation['pairedWorkerCoverage']['complete'] is True and workers['settled'] and self.worker is None and self.broker is None and self.preflight is not None and
                    self.inventory is not None and terminal['preflightSha256'] == p.digest(self.preflight) and
                    terminal['inventorySha256'] == p.digest(self.inventory), 'read-only terminal lacks registered physical settlement')
        observation['workerObservation'] = workers
        return observation

    def record_worker(self, kind, nonce, body):
        event = {'type': kind, 'workerNonce': nonce, 'body': body}
        digest = self.journal.append('WORKER', event)
        self.worker_records[digest] = event
        self.send('worker', {'event': event, 'guardianRecordSha256': digest})

    def start_worker(self, body):
        p = self.p
        p.closed(body, ['role'])
        require(body['role'] in ('archive-preflight', 'image-inventory') and self.worker is None and self.terminal is None, 'worker role/phase')
        self.lease.check(time.monotonic_ns())
        role = body['role']
        require(role not in self.journal.workers.operations, 'worker operation already used')
        candidate = self.policy['candidate']
        p.closed(candidate, ['policy', 'inputs', 'inventoryBinding'])
        inputs = {}
        for name, pin in candidate['inputs'].items():
            # Large archive integrity scan belongs to bounded worker, never the
            # guardian event loop. Kernel fs-verity is checked before transfer.
            maximum = 32 * 1024**3 if name.startswith('archive:') else MAX
            inputs[name] = self.i.pin(pin, maximum=maximum, content=False)
        require(sum(os.fstat(fd).st_size for name, fd in inputs.items() if name.startswith('archive:')) <= 64 * 1024**3, 'worker archive aggregate bound')
        inputs['protocol'] = os.dup(self.fds['protocol'])
        table = {}
        for name, fd in inputs.items():
            pin = self.a['roles']['protocol'] if name == 'protocol' else candidate['inputs'][name]
            info = os.fstat(fd)
            table[name] = {key: pin[key] for key in ['bytes', 'sha256', 'veritySha256']}
            table[name].update(device=info.st_dev, inode=info.st_ino)
        if role == 'archive-preflight':
            operation = {'policy': candidate['policy']}
        else:
            require(self.preflight is not None, 'inventory lacks successful archive result')
            operation = {'preflight': self.preflight, 'binding': dict(candidate['inventoryBinding'], preflightSha256=self.preflight['sha256'])}
        now = time.monotonic_ns()
        context = {'role': role, 'workerNonce': os.urandom(32).hex(), 'requestSha256': self.request['requestSha256'],
            'selectionSha256': self.policy['lease']['selectionSha256'], 'grantId': self.lease.grant['grantId'],
            'managerEpoch': self.epoch['managerEpoch'], 'guardianSessionId': self.epoch['guardianSessionId'],
            'originalDeadlineNs': str(min(self.original_deadline, now + (60 if role == 'image-inventory' else 1800) * 1000000000)),
            'inputTable': table, 'operation': operation}
        self.journal.append('WORKER_CONTEXT', context)
        self.worker_contexts[context['workerNonce']] = p.parse(p.canonical(context))
        slot = self.modules['workers'].CgroupSlot(p, self.policy['workerCgroup'])
        self.worker = self.modules['workers'].Worker(p, self.policy['worker'], slot, self.fds['interpreter'],
                          self.fds['workerEntry'], self.lock_fd, context, inputs)
        self.record_worker('prepared', context['workerNonce'], self.worker.registration())
        self.worker_phases[context['workerNonce']] = 'prepared'
        self.worker.launch()
        if role == 'image-inventory':
            broker_slot = self.modules['workers'].CgroupSlot(p, self.policy['brokerCgroup'])
            self.broker = self.modules['broker'].Broker(p, broker_slot, self.fds['docker'], int(context['originalDeadlineNs']), operation['binding']['maxImages'])

    def poll_workers(self):
        if self.worker is None:
            return
        worker = self.worker; nonce = worker.context['workerNonce']
        expiry = self.lease.inventory_deadline(worker.deadline)
        if self.broker is not None and self.broker.state in ('RUNNING', 'STOPPING', 'UNKNOWN'):
            event = self.broker.poll(expiry)
            if event is None and time.monotonic_ns() - self.broker_last_progress >= 1_000_000_000:
                require(time.monotonic_ns() < expiry, 'broker progress after lease expiry')
                self.modules['workers'].packet(worker.parent, self.p, {'type': 'BROKER_WAIT', 'workerNonce': nonce,
                    'expiryNs': str(min(expiry, self.broker.command_deadline))})
                self.broker_last_progress = time.monotonic_ns()
            if event is not None:
                self.record_worker('broker-settled', nonce, event)
                require(event['outcome'] == 'observed', 'broker read failed or unsettled')
                self.capture_broker_response(nonce, event)
                require(self.native_broker_handle is not None, 'broker lacks native registration')
                receipt = self.native.close_read(self.native_broker_handle, min(expiry, self.broker.command_deadline))
                self.native_broker_receipts.append(receipt); self.native_broker_handle = None
                self.replies.extend(self.broker.response(nonce))
                require(len(self.replies) <= 33, 'broker reply queue bound')
                self.broker.reset_settled()
        if self.replies:
            self.modules['workers'].packet(worker.parent, self.p, self.replies.pop(0))
        event = worker.poll(expiry)
        if event is None:
            return
        kind = event['type']
        if kind == 'broker-read':
            require(self.broker is not None and not self.replies, 'broker request overlaps response')
            prepared = self.broker.prepare(event['args'], expiry)
            self.record_worker('broker-prepared', nonce, prepared)
            self.native_broker_handle = self.native.register(kind='broker', command=prepared['command'],
                worker_nonce=nonce, args=prepared['args'], path=None, deadline=int(prepared['originalDeadlineNs']))
            self.broker.launch(self.native_broker_handle['configPath'])
        elif kind == 'result-pending':
            self.record_worker('result', nonce, event['result'])
            self.worker_phases[nonce] = 'result'
            worker.acknowledge_result(expiry)
        elif kind == 'settled':
            self.record_worker('settled', nonce, event)
            self.worker_phases[nonce] = 'settled'
            require(event['outcome'] == 'observed', 'worker failed')
            if worker.context['role'] == 'archive-preflight':
                self.preflight = event['result']
            else:
                self.inventory = event['result']
            worker.close_settled()
            for fd in worker.inputs.values():
                os.close(fd)
            self.worker = None
            if self.broker is not None:
                require(self.broker.state == 'IDLE' and self.broker.slot.empty(), 'broker not recursively settled')
                self.broker.slot.close(); self.broker = None
        elif kind == 'authenticated':
            self.record_worker(kind, nonce, event)
            self.worker_phases[nonce] = 'running'
        elif kind == 'diagnostic':
            self.record_worker(kind, nonce, event['body'])
        else:
            raise RuntimeError('unknown registered worker event')

    def fence_identity(self):
        p = self.p
        directory = Path(self.policy['journalDirectory'])
        for part in [directory, *directory.parents]:
            info = part.lstat()
            require(part.resolve(strict=True) == part and info.st_uid == 0 and not info.st_mode & 0o022,
                    'fence directory custody changed')
        held_dir, named_dir = os.fstat(self.journal.dirfd), directory.lstat()
        require((held_dir.st_dev, held_dir.st_ino) == (named_dir.st_dev, named_dir.st_ino) and
                not named_dir.st_mode & 0o077, 'fence parent replaced or exposed')
        held = os.fstat(self.fence_fd)
        named = os.stat('active.fence', dir_fd=self.journal.dirfd, follow_symlinks=False)
        require(stat.S_ISREG(named.st_mode) and named.st_uid == 0 and named.st_gid == 0 and
                named.st_nlink == held.st_nlink == 1 and not named.st_mode & 0o077 and
                (held.st_dev, held.st_ino) == (named.st_dev, named.st_ino), 'original fence inode/metadata differs')
        raw = self.modules['history'].private_snapshot(p, self.journal.dirfd, 'active.fence')
        require(raw == self.fence_bytes and hashlib.sha256(raw).hexdigest() == self.fence_sha,
                'original fence bytes differ')
        snapshot = self.protected_history()
        custody = [record['row']['body'] for record in snapshot['rows'] if record['row']['kind'] == 'CUSTODY']
        require(len(custody) == 1 and custody[0]['fenceSha256'] == self.fence_sha and
                custody[0]['epoch'] == self.epoch and custody[0]['request'] == self.custody_request,
                'original fence/session custody linkage differs')
        return {'device': str(held.st_dev), 'inode': str(held.st_ino), 'guestFenceSha256': self.fence_sha,
                'localSessionId': self.local_id, 'guardianSessionId': self.epoch['guardianSessionId']}

    def protected_history(self):
        snapshot = self.modules['history'].chain_snapshot(self.p, self.journal.dirfd, self.journal.name)
        require(len(snapshot['rows']) == self.journal.sequence and snapshot['lastSha256'] == self.journal.previous,
                'private journal differs from current owner')
        registered = [(record['recordSha256'], record['row']['body']) for record in snapshot['rows']
                      if record['row']['kind'] == 'WORKER']
        require(registered == list(self.worker_records.items()), 'private ordered worker stream differs')
        return snapshot

    def capture_broker_response(self, nonce, event):
        # Retain complete successful stdout before sending any result chunk to
        # the worker; private evidence, never candidate-selected paths. Existing
        # 16MiB aggregate stream limit remains. Files are not cleanup authority.
        p = self.p
        data = bytes(self.broker.output)
        require(self.broker.state == 'SETTLED' and len(data) == event['stdoutBytes'] < MAX and
                hashlib.sha256(data).hexdigest() == event['stdoutSha256'], 'broker response custody differs')
        self.response_bytes += len(data)
        require(self.response_bytes <= 16 * MAX and len(self.broker_responses) < 259, 'retained response bound')
        name = self.local_id + '.response-' + str(event['command'])
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=self.journal.dirfd)
        try:
            remaining = memoryview(data)
            while remaining:
                count = os.write(fd, remaining)
                require(count > 0, 'broker response short write')
                remaining = remaining[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self.journal.dirfd)
        record = {'workerNonce': nonce, 'command': event['command'], 'name': name,
                  'bytes': len(data), 'sha256': event['stdoutSha256']}
        self.journal.append('BROKER_RESPONSE', record)
        self.broker_responses.append(record)

    def daemon_read_settlement(self, manifest, responses, original_received_ns):
        p = self.p
        self.terminal_deadline()
        end = min(original_received_ns + 2_500_000_000, self.original_deadline,
                  self.lease.expiry_ns, self.lease.overall_ns)
        self.physical.end = min(end, self.physical.owner_deadline)
        self.physical.budget()
        require(time.monotonic_ns() < end and self.native_broker_handle is None and
                len(manifest) == len(responses) == len(self.native_broker_receipts), 'native/broker terminal coverage differs')
        snapshot = self.native.snapshot(end)
        state = snapshot['readState']
        p.closed(state, ['daemonIdentitySha256', 'pendingRequests', 'unknownRequests', 'mutationRequestsDispatched',
                        'activeRequestHandles', 'completedReadCommands', 'completedRecordsSha256', 'authorityRestored', 'automaticRetryAllowed'])
        identity = self.native.bootstrap['identitySha256']
        require(state['daemonIdentitySha256'] == snapshot['identitySha256'] == identity and
                state['activeRequestHandles'] == [] and type(state['completedReadCommands']) is int and
                state['completedReadCommands'] == len(manifest) and state['authorityRestored'] is False and
                state['automaticRetryAllowed'] is False and all(type(state[key]) is int and state[key] == 0 for key in
                ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched']), 'native semantic requests remain pending/unknown')
        history = self.protected_history()
        registered = {}; settled = []
        for record in history['rows']:
            kind, body = record['row']['kind'], record['row']['body']
            if kind == 'NATIVE_READ_REGISTERED':
                require(record['recordSha256'] not in registered, 'duplicate guardian native registration')
                registered[record['recordSha256']] = body
            elif kind == 'NATIVE_READ_SETTLED':
                origin = registered.pop(body['guardianRegistrationRecordSha256'])
                receipt = body['receipt']
                require(all(origin[key] == receipt[key] for key in ['registration', 'registeredRecordSha256', 'daemonIdentitySha256']),
                        'native protected read pair differs')
                settled.append(receipt)
        require(not registered and p.digest(settled) == state['completedRecordsSha256'] and
                [value for value in settled if value['registration']['kind'] == 'broker'] == self.native_broker_receipts,
                'native complete command sequence differs from guardian durable linkage')
        for entry, response, receipt in zip(manifest, responses, self.native_broker_receipts):
            wanted = {'kind': 'broker', 'command': entry['prepared']['command'], 'workerNonce': entry['workerNonce'],
                'args': entry['prepared']['args'], 'path': None, 'originalDeadlineNs': entry['prepared']['originalDeadlineNs'],
                'guardianSessionId': self.epoch['guardianSessionId'], 'requestSha256': self.request['requestSha256']}
            require(receipt['registration'] == wanted and receipt['daemonIdentitySha256'] == identity and
                    receipt['readResponsesVerified'] is True and receipt['activeRequestHandles'] == [] and
                    all(type(receipt[key]) is int and receipt[key] == 0 for key in
                        ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched']), 'native broker receipt context differs')
            primary = [row for row in receipt['records'] if row['target'][0] not in ('ping', 'version')]
            require(len(primary) == 1 and len(receipt['records']) == len(receipt['wireRecords']) and
                    all(row['handlerReturned'] is True and row['mutationRequestDispatched'] is False for row in receipt['records']),
                    'native actual daemon response coverage differs')
            def unique(pairs):
                result = {}
                for key, value in pairs:
                    require(key not in result, 'duplicate broker semantic key'); result[key] = value
                return result
            def decode(data):
                return json.loads(data, object_pairs_hook=unique)
            args = entry['prepared']['args']
            if args == self.modules['broker'].LIST:
                ids = sorted({decode(line)['ID'] for line in response.splitlines()})
                projection = {'retainedImageIds': ids}; target = 'images'
            else:
                projection = decode(response); target = 'info' if args == self.modules['broker'].INFO else 'image'
            require(primary[0]['target'][0] == target and primary[0]['projection'] == projection and
                    hashlib.sha256(response).hexdigest() == entry['settled']['stdoutSha256'],
                    'actual complete daemon response does not match retained CLI semantics')
        proof = self.physical.persist('daemon-read-settlement', {'daemonIdentitySha256': identity,
            'nativeBirthRecordSha256': snapshot['birthRecordSha256'], 'nativeHistorySha256': snapshot['nativeHistorySha256'],
            'nativeReadState': state, 'brokerManifestSha256': p.digest(manifest),
            'protectedBrokerReceiptsSha256': p.digest(self.native_broker_receipts),
            'guardianHistorySha256': history['sha256'], 'originalChallengeNs': str(original_received_ns)})
        self.journal.append('DAEMON_SETTLEMENT_EVIDENCE', {'proof': proof})
        settlement = {'brokerManifestSha256': p.digest(manifest), 'daemonIdentityBeforeSha256': identity,
            'daemonIdentityAfterSha256': snapshot['identitySha256'], 'initialInfoResponseSha256': hashlib.sha256(responses[0]).hexdigest(),
            'finalInfoResponseSha256': hashlib.sha256(responses[-1]).hexdigest(), 'completedReadCommands': len(manifest),
            'readResponsesVerified': True, 'pendingRequests': 0, 'unknownRequests': 0, 'mutationRequestsDispatched': 0,
            'activeRequestHandles': [], 'settlementReceiptSha256': proof['sha256']}
        require(time.monotonic_ns() < end, 'native settlement persistence exceeded original challenge')
        return {'daemonIdentitySha256': identity, 'daemonReadSettlement': settlement,
                'physicalSettlementReceiptSha256': proof['sha256']}

    def worker_settlement(self, observation, original_received_ns):
        p = self.p
        require(observation['pairedWorkerCoverage']['complete'] is True and observation['readonlyTerminal'] is not None and
                self.worker is None and self.broker is None and not self.replies and self.pending is None and
                self.lease.pending is None, 'worker terminal requires complete settled history')
        workers = observation['workerObservation']
        require(workers['settled'] is True and workers['brokerPending'] is False and len(workers['workers']) == 2,
                'worker/broker registry not settled')
        snapshot = self.protected_history()
        contexts = {}
        manifest = []
        prepared = None
        for record in snapshot['rows']:
            row = record['row']
            if row['kind'] == 'WORKER_CONTEXT':
                context = row['body']
                nonce = context['workerNonce']
                require(nonce not in contexts and nonce in workers['workers'], 'duplicate or unknown full worker context')
                registration = workers['workers'][nonce]
                require(p.digest(context) == registration['contextSha256'] and context == self.worker_contexts[nonce],
                        'full registered worker context differs')
                for key, value in {'requestSha256': self.request['requestSha256'],
                        'selectionSha256': self.policy['lease']['selectionSha256'],
                        'grantId': self.lease.grant['grantId'], 'managerEpoch': self.epoch['managerEpoch'],
                        'guardianSessionId': self.epoch['guardianSessionId'],
                        'originalDeadlineNs': registration['originalDeadlineNs'], 'role': registration['role']}.items():
                    require(context[key] == value, 'worker selection/role/context mismatch')
                contexts[nonce] = {key: context[key] for key in ['requestSha256', 'selectionSha256', 'grantId',
                    'managerEpoch', 'guardianSessionId', 'originalDeadlineNs']}
                contexts[nonce].update(contextSha256=p.digest(context), contextVerified=True,
                                       inputTableSha256=self.request['inputTableSha256'])
            if row['kind'] != 'WORKER':
                continue
            event = row['body']
            if event['type'] == 'broker-prepared':
                require(prepared is None, 'broker manifest overlaps')
                prepared = (record['recordSha256'], event)
            elif event['type'] == 'broker-settled':
                require(prepared is not None and event['workerNonce'] == prepared[1]['workerNonce'], 'broker manifest unpaired')
                body = event['body']
                require(body['outcome'] == 'observed' and body['exitCode'] == 0 and body['cgroupEmpty'] is True,
                        'unsuccessful broker manifest')
                settled = {key: value for key, value in body.items() if key != 'stderrPrefixHex'}
                settled['stderrPrefixHexSha256'] = p.digest(body['stderrPrefixHex'])
                manifest.append({'workerNonce': event['workerNonce'], 'prepared': prepared[1]['body'],
                    'settled': settled, 'preparedRecordSha256': prepared[0], 'settledRecordSha256': record['recordSha256']})
                prepared = None
        require(prepared is None and set(contexts) == set(workers['workers']) and len(manifest) == workers['brokerCommands'] and
                len(manifest) == len(self.broker_responses), 'incomplete protected worker/broker projection')
        responses = []
        persisted = [record['row']['body'] for record in snapshot['rows'] if record['row']['kind'] == 'BROKER_RESPONSE']
        require(persisted == self.broker_responses, 'protected response sequence differs')
        for index, (entry, descriptor) in enumerate(zip(manifest, persisted), 1):
            require(entry['prepared']['command'] == entry['settled']['command'] == descriptor['command'] == index and
                    descriptor['workerNonce'] == entry['workerNonce'], 'response order/worker differs')
            data = self.modules['history'].private_snapshot(p, self.journal.dirfd, descriptor['name'])
            require(len(data) == descriptor['bytes'] == entry['settled']['stdoutBytes'] and
                    hashlib.sha256(data).hexdigest() == descriptor['sha256'] == entry['settled']['stdoutSha256'],
                    'complete retained broker response differs')
            responses.append(data)
        def decode(data):
            def unique(pairs):
                value = {}
                for key, item in pairs:
                    require(key not in value, 'duplicate daemon response key')
                    value[key] = item
                return value
            return json.loads(data, object_pairs_hook=unique)
        require(3 <= len(manifest) <= 259 and manifest[0]['prepared']['args'] == self.modules['broker'].INFO and
                manifest[1]['prepared']['args'] == self.modules['broker'].LIST and
                manifest[-1]['prepared']['args'] == self.modules['broker'].INFO, 'broker command grammar differs')
        ids = set()
        for line in responses[1].splitlines():
            image = decode(line)
            require(type(image) is dict and type(image.get('ID')) is str and re.fullmatch('sha256:[a-f0-9]{64}', image['ID']),
                    'protected LIST response ID differs')
            ids.add(image['ID'])
        retained = sorted(ids)
        require(retained == self.inventory['receipt']['retainedImageIds'] and len(manifest) == len(retained) + 3,
                'retained LIST/result/command coverage differs')
        seen = set()
        for entry, response in zip(manifest[2:-1], responses[2:-1]):
            args = entry['prepared']['args']
            require(len(args) == 5 and args[:4] == self.modules['broker'].INSPECT and args[4] in ids and
                    args[4] not in seen, 'inspect coverage differs')
            image = decode(response)
            require(type(image) is dict and set(image) == {'id', 'tags', 'digests'} and image['id'] == args[4],
                    'inspect response identity differs')
            seen.add(args[4])
        require(seen == ids and decode(responses[0]) == decode(responses[-1]) == self.inventory['receipt']['daemon'],
                'daemon INFO/retained inspection identity differs')
        # The native owner observes actual handler and complete-wire settlement.
        physical = self.daemon_read_settlement(manifest, responses, original_received_ns)
        p.closed(physical, ['daemonIdentitySha256', 'daemonReadSettlement', 'physicalSettlementReceiptSha256'])
        settlement = {'workerObservation': workers, 'contextBindings': contexts, 'brokerManifest': manifest,
                      'retainedImageIds': retained, **physical}
        require(len(p.canonical(settlement)) <= 320 * 1024, 'host156 settlement projection bound')
        return settlement

    def host_cleared(self, envelope, received):
        p = self.p
        body = envelope['payload']
        fields = ['type', 'grantId', 'managerEpoch', 'guestBootId', 'requestSha256', 'challengeNonce',
            'guardianSessionId', 'requestNonce', 'terminalSha256', 'inputTableSha256', 'selectionSha256',
            'ackSha256', 'releaseReceiptSha256', 'clearedRecordSha256', 'remainingFencesSha256',
            'guestFenceSha256', 'authorityRestored', 'automaticRetryAllowed']
        p.closed(body, fields)
        self.terminal_deadline()
        require(body['type'] == 'HOST_CLEARED' and self.release_proof is not None and self.release_committed and
                self.retirement is None and self.local_release is not None and self.release_challenge is None and
                self.pending is None and self.lease.pending is None and self.worker is None and self.broker is None and
                not self.replies and body['authorityRestored'] is False and body['automaticRetryAllowed'] is False,
                'host clear before complete local release or duplicate notice')
        expected = self.terminal_bindings()
        expected.update(ackSha256=p.digest(self.ack['payload']), releaseReceiptSha256=p.digest(self.local_release),
                        guestFenceSha256=self.fence_sha)
        require(all(body[key] == value for key, value in expected.items()), 'host clear exact current binding differs')
        for key in ['challengeNonce', 'clearedRecordSha256', 'remainingFencesSha256']:
            p.sha(body[key])
        self.handshake.auth.consume('manager-to-supervisor')
        validated = self.journal.append('HOST_CLEARED_VALIDATED', {'envelope': envelope, 'receivedNs': str(received)})
        observation = self.verify_history('GUARDIAN_RELEASE')
        require(observation['guardianReleaseRecord'] == self.local_release, 'host clear protected release differs')
        physical = self.physical_writer_gate(received)
        require(type(physical) is dict and physical, 'host clear lacks physical receipt')
        clear_settlement = None
        if self.terminal['outcome'] == 'readonly-observed':
            clear_settlement = self.refresh_worker_settlement(observation, received)
        self.supervisor_identity()
        self.require_lock_absent()
        identity = self.fence_identity()
        notice_sha = p.digest(envelope)
        linkage = self.journal.append('HOST_CLEARED_RECEIVED', {'envelope': envelope,
            'protectedHistory': observation, 'physicalReceiptSha256': p.digest(physical), 'guestFenceIdentity': identity,
            'validatedRecordSha256': validated, 'daemonSettlementReceiptSha256': None if clear_settlement is None else
                clear_settlement['physicalSettlementReceiptSha256']})
        intent = {'hostClearedEnvelopeSha256': notice_sha, 'retirementNonce': body['challengeNonce'],
                  'guestFenceIdentity': identity, 'hostClearRecordSha256': linkage}
        self.journal.append('GUEST_RETIRE_INTENT', intent)
        # Fresh exclusion and exact inode after durable intent, followed by the
        # original deadline checks immediately before the sole fixed-name unlink.
        latest_physical = self.physical_writer_gate(received)
        require(type(latest_physical) is dict and latest_physical, 'retire intent lacks refreshed exclusion')
        require(self.fence_identity() == identity, 'retirement target changed after intent')
        self.require_lock_absent()
        now = time.monotonic_ns()
        require(now < min(self.lease.expiry_ns, self.lease.overall_ns, self.original_deadline) and
                0 <= now - received < 3_000_000_000, 'retirement original deadline after intent')
        os.unlink('active.fence', dir_fd=self.journal.dirfd)
        os.fsync(self.journal.dirfd)
        try:
            os.stat('active.fence', dir_fd=self.journal.dirfd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError('fence reappeared after exact retirement')
        self.terminal_deadline()
        require(time.monotonic_ns() - received < 3_000_000_000, 'retirement parent persistence deadline')
        record_sha = self.journal.append('GUEST_RETIRED', dict(intent, guestFenceAbsent=True,
            finalPhysicalReceiptSha256=p.digest(latest_physical), authorityRestored=False, automaticRetryAllowed=False))
        os.close(self.fence_fd); self.fence_fd = None
        receipt = {key: body[key] for key in ['grantId', 'managerEpoch', 'guestBootId', 'requestSha256',
            'guardianSessionId', 'terminalSha256', 'ackSha256', 'releaseReceiptSha256', 'clearedRecordSha256', 'guestFenceSha256']}
        receipt.update(nonce=body['requestNonce'], hostClearedEnvelopeSha256=notice_sha,
            retirementNonce=body['challengeNonce'], retirementRecordSha256=record_sha,
            guestFenceAbsent=True, authorityRestored=False, automaticRetryAllowed=False)
        reply = self.handshake.auth.envelope(dict(body, type='GUEST_FENCE_RETIRED', retirementReceipt=receipt), 'supervisor-to-manager')
        self.journal.append('RETIREMENT_REPLY', reply)
        self.terminal_deadline()
        require(time.monotonic_ns() - received < 3_000_000_000, 'retirement reply persistence deadline')
        self.retirement = {'receipt': receipt, 'receivedNs': received, 'notified': False}
        self.stream.queue(p.canonical(reply))
        self.handshake.auth.consume('supervisor-to-manager')

    def terminal_bindings(self):
        return {'grantId': self.lease.grant['grantId'], 'managerEpoch': self.epoch['managerEpoch'],
            'guestBootId': self.boot, 'requestSha256': self.request['requestSha256'],
            'guardianSessionId': self.epoch['guardianSessionId'], 'requestNonce': self.request['nonce'],
            'terminalSha256': self.p.digest(self.terminal), 'inputTableSha256': self.request['inputTableSha256'],
            'selectionSha256': self.policy['lease']['selectionSha256']}

    def refresh_worker_settlement(self, observation, received):
        current = self.worker_settlement(observation, received)
        require(self.settlement is not None, 'missing original terminal settlement')
        for key in current:
            if key not in ('daemonReadSettlement', 'physicalSettlementReceiptSha256'):
                require(current[key] == self.settlement[key], 'worker settlement changed after proof')
        old, new = self.settlement['daemonReadSettlement'], current['daemonReadSettlement']
        require({key: value for key, value in old.items() if key != 'settlementReceiptSha256'} ==
                {key: value for key, value in new.items() if key != 'settlementReceiptSha256'},
                'fresh daemon settlement identity/completion changed')
        return current

    def poll_retirement(self):
        if self.retirement is None:
            return
        self.terminal_deadline()
        require(time.monotonic_ns() - self.retirement['receivedNs'] < 3_000_000_000, 'retirement transport/finalization deadline')
        if self.stream.pending:
            return
        if not self.retirement['notified']:
            self.supervisor_identity()
            self.send('fence-retired', self.retirement['receipt'])
            self.retirement['notified'] = True
            return
        # Only this exact registered child may exit at this phase. poll reaps
        # the owned Popen incarnation; no vanished PID or unrelated label waiver.
        code = self.child.poll()
        if code is None:
            return
        require(code == 0, 'supervisor failed after retirement notice')
        self.journal.append('SUPERVISOR_REAPED', {'pid': self.child.pid, 'starttime': str(self.peer.starttime),
            'exitCode': code, 'retirementRecordSha256': self.retirement['receipt']['retirementRecordSha256']})
        self.released = True
        # Writer-owner registry, all journals and response files are retained.
        # No new admission/retry follows local retirement or transport flush.

    def recovery_observation(self):
        """Pinned owner-only evidence projection, never an IPC/CLI request.

        Requires this current custodian and independently fresh physical evidence.
        Dead-owner/offline recovery cannot instantiate a new Guardian over old
        WAL: startup refuses. A separately installed read-only recovery custodian
        is still required for that case; no path/key/fake callback is accepted.
        """
        require(os.geteuid() == 0 and self.request is not None and self.terminal is not None and
                self.ack is not None and self.worker is None and self.broker is None and not self.replies and
                self.pending is None and self.lease.pending is None, 'recovery observation has unknown work/custody')
        received = time.monotonic_ns()
        self.terminal_deadline()
        physical = self.physical_writer_gate(received)
        require(type(physical) is dict and physical, 'recovery lacks independent physical evidence')
        observation = self.verify_history()
        require(observation['terminal'] == self.terminal and observation['managerAck'] == self.ack['payload'],
                'recovery history differs')
        snapshot = self.protected_history()
        notices = [record for record in snapshot['rows'] if record['row']['kind'] == 'HOST_CLEARED_RECEIVED']
        intents = [record for record in snapshot['rows'] if record['row']['kind'] == 'GUEST_RETIRE_INTENT']
        retired = [record for record in snapshot['rows'] if record['row']['kind'] == 'GUEST_RETIRED']
        require(len(notices) <= 1 and len(intents) <= 1 and len(retired) <= 1 and
                len(retired) <= len(intents) <= len(notices), 'retirement recovery history order/uniqueness')
        notice = notices[0]['row']['body']['envelope'] if notices else None
        if intents:
            require(intents[0]['row']['body']['hostClearedEnvelopeSha256'] == self.p.digest(notice) and
                    intents[0]['row']['sequence'] > notices[0]['row']['sequence'], 'retirement intent/notice differs')
        if retired:
            require(retired[0]['row']['body']['hostClearedEnvelopeSha256'] == self.p.digest(notice) and
                    retired[0]['row']['body']['guestFenceAbsent'] is True and
                    retired[0]['row']['sequence'] > intents[0]['row']['sequence'], 'retired record/intent differs')
        try:
            os.stat('active.fence', dir_fd=self.journal.dirfd, follow_symlinks=False)
        except FileNotFoundError:
            present = False
            require(intents, 'absent fence without protected retirement intent')
        else:
            present = True
            self.fence_identity()
            require(not retired, 'retired history with present fence')
        # RETIRE_INTENT+absent stays unresolved; no inference of success, fresh
        # channel, retry or authority restoration is made from this projection.
        return {'version': 1, 'guardianSessionId': self.epoch['guardianSessionId'], 'localSessionId': self.local_id,
            'requestNonce': self.request['nonce'], 'requestSha256': self.request['requestSha256'], 'guestBootId': self.boot,
            'terminalSha256': self.p.digest(self.terminal), 'ackSha256': self.p.digest(self.ack['payload']),
            'hostClearedEnvelopeSha256': self.p.digest(notice) if notice else None,
            'retirementNonce': notice['payload']['challengeNonce'] if notice else None,
            'guestFencePresent': present, 'guestFenceSha256': self.fence_sha,
            'guestRetirementStage': 'GUEST_RETIRED' if retired else 'GUEST_RETIRE_INTENT' if intents else
                'HOST_CLEARED_RECEIVED' if notices else 'LOCAL_RELEASE' if self.local_release else 'ACK',
            'guestRetirementRecordSha256': retired[0]['recordSha256'] if retired else None,
            'protectedHistorySha256': snapshot['sha256'], 'authorityRestored': False, 'fenceClearAuthorized': False,
            'automaticRetryAllowed': False, 'requiresSeparateOwnerRecovery': True}

    def run(self):
        notify('READY=1\nWATCHDOG=1')
        observed = self.modules['connection'].unit_snapshot(self.policy['installation']['execStopPost'], self.physical.held['systemctl'])
        require(observed['MainPID'] == os.getpid(), 'guardian is not PID1 MainPID')
        self.original_deadline = min(self.original_deadline, observed['deadlineNs'])
        self.launch_supervisor()
        while not self.failed and not self.released:
            now = time.monotonic_ns()
            require(now < self.original_deadline, 'guardian original lifetime deadline')
            if self.phase == 'READY' and self.retirement is None:
                require(now - self.last_owner < 5_000_000_000, 'guardian owner progress deadline')
            elif self.phase != 'READY':
                require(now - self.started_ns < 10_000_000_000, 'guardian bootstrap progress deadline')
            if self.retirement is None or not self.retirement['notified']:
                self.supervisor_identity()
            if self.pending is not None:
                require(now - self.pending['sentNs'] < 5_000_000_000, 'admission fsync/commit timeout')
            if self.phase in ('WAIT_HOST_HELLO', 'WAIT_HOST_LIFETIME', 'WAIT_CUSTODY_FD'):
                require(now - self.custody_observed < 5_000_000_000, 'host handshake timeout')
            if self.terminal is not None:
                self.terminal_deadline()
            if self.lease is not None and self.terminal is None:
                if self.lease.state == 'BOUND':
                    self.lease.check(now)
                else:
                    require(now - self.lease.sent_ns < 5_000_000_000, 'initial admission deadline')
            if self.host is not None:
                require(self.host.poll() is None or self.retirement is not None, 'host transport exited before retirement')
                self.stream.flush()
                if self.retirement is None:
                    wire = self.stream.receive()
                    if wire is not None:
                        self.host_message(wire)
            if self.retirement is None or not self.retirement['notified']:
                wire = self.peer.receive()
                if wire is not None:
                    self.supervisor_message(wire)
            self.poll_workers()
            self.poll_release()
            self.poll_retirement()
            if self.terminal is not None:
                self.terminal_deadline()
            # Keep the non-renewing original limits through authenticated host
            # clear, durable retirement, reply transport and exact child reaping.
            # Only real serialized progress feeds PID1, never another thread.
            notify('WATCHDOG=1')
            select.select([self.endpoint], [], [], 0.02)

    def fence(self, reason):
        self.failed = True
        try:
            self.journal.append('UNRESOLVED', {'reason': str(reason)[:256], 'authorityRestored': False})
        finally:
            for owned in [self.worker, self.broker]:
                if owned is not None:
                    try:
                        owned.stop()
                    except BaseException:
                        pass
        # PID1 control-group/finalizer owns terminal cleanup. Original lock is
        # not manually unlocked, fence is never deleted on this failure path.


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 1, 'fixed guardian entry only')
    os.lseek(5, 0, os.SEEK_SET)
    source = os.read(5, MAX + 1)
    require(0 < len(source) <= MAX, 'inherited installation library bound')
    # Reserve fixed control slot before installation opens any input descriptor.
    reserved = os.open('/dev/null', os.O_RDONLY | os.O_CLOEXEC)
    if reserved != 3:
        os.dup2(reserved, 3, inheritable=False)
        os.close(reserved)
    installation = types.ModuleType('fixed_guardian_installation')
    exec(compile(source, '<inherited-installation>', 'exec'), installation.__dict__)
    guardian = None
    try:
        guardian = Guardian(installation, installation.anchor())
        guardian.run()
    except BaseException as error:
        if guardian is not None:
            guardian.fence(type(error).__name__ + ': ' + str(error))
        raise


if __name__ == '__main__':
    main()
