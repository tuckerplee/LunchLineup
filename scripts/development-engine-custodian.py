#!/usr/bin/env python3
"""Fixed native read custodian: private socket birth, exact engines, finite proxy.

Future deployment requires independently pinned approval. No Manager key,
existing-service stop, stale-state reuse, container action, repair or cleanup.
"""
import hashlib
import hmac
import os
from pathlib import Path
import select
import socket
import stat
import struct
import subprocess
import sys
import time
import types

MAX = 1048576
ROOT = '/run/lunchlineup/engine-custody'


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def notify(value):
    address = os.environ['NOTIFY_SOCKET']
    if address.startswith('@'):
        address = '\0' + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as endpoint:
        endpoint.connect(address)
        require(endpoint.send(value.encode()) == len(value), 'native PID1 notify short send')


class Control:
    def __init__(self, owner, endpoint):
        self.owner, self.endpoint = owner, endpoint
        endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        endpoint.setblocking(False)
        self.identity = owner.control_peer(endpoint)
        self.peer = owner.p.CredentialPeer(endpoint, self.identity['pid'], 0, 0, self.identity['starttime'],
            self.identity['cgroup'], self.identity['executableSha256'])
        self.sequence = 0; self.output = None; self.closed = False
        self.last = time.monotonic_ns(); self.closing_since = None
        self.waiting_bootstrap = None; self.reply_deadline = None

    def sockets(self):
        if self.waiting_bootstrap is not None:
            return [], []
        return ([self.endpoint], []) if self.output is None else ([], [self.endpoint])

    def poll(self, readable, writable):
        if self.identity['role'] == 'guardian' and select.select([self.peer.pidfd], [], [], 0)[0]:
            self.owner.guardian_exited(self.identity)
            self.close()
            return
        if self.identity['role'] == 'guardian':
            poller = select.poll(); poller.register(self.endpoint, select.POLLHUP)
            if any(flags & select.POLLHUP for _, flags in poller.poll(0)):
                if self.closing_since is None: self.closing_since = time.monotonic_ns()
                require(time.monotonic_ns() - self.closing_since < 500_000_000, 'guardian closed control but remains live')
                return
        self.peer.assert_identity()
        require(self.owner.control_peer(self.endpoint) == self.identity, 'native control peer changed')
        if self.waiting_bootstrap is not None:
            require(time.monotonic_ns() < self.reply_deadline, 'native bootstrap original startup deadline')
            if self.owner.identity is not None:
                self.prepare_reply(self.waiting_bootstrap)
                self.waiting_bootstrap = None
            return
        if self.output is None and self.endpoint in readable:
            wire = self.peer.receive()
            if wire is None:
                return
            value = self.owner.p.parse(wire)
            self.owner.p.closed(value, ['sequence', 'op', 'nonce', 'body'])
            require(type(value['sequence']) is int and value['sequence'] == self.sequence, 'native control sequence')
            self.owner.p.sha(value['nonce'])
            self.last = time.monotonic_ns()
            self.reply_deadline = min(self.owner.deadline, self.last + 500_000_000)
            if self.identity['role'] == 'guardian' and value['op'] == 'BOOTSTRAP':
                self.owner.validate_bootstrap(self, value['body'])
                self.reply_deadline = min(self.owner.deadline, self.owner.bootstrap_deadline)
                if self.owner.identity is None:
                    self.waiting_bootstrap = value
                    return
            self.prepare_reply(value)
        if self.output is not None and self.endpoint in writable:
            require(time.monotonic_ns() < self.reply_deadline and
                    self.endpoint.send(self.output, socket.MSG_NOSIGNAL) == len(self.output), 'native control reply deadline/short send')
            self.output = None; self.sequence += 1
            if self.identity['role'] in ('daemon', 'containerd', 'recovery'):
                self.close()

    def prepare_reply(self, value):
        require(time.monotonic_ns() < self.reply_deadline, 'native reply original deadline')
        result = self.owner.dispatch(self, value['op'], value['body'])
        self.output = self.owner.p.canonical(dict(value, body=result))
        require(len(self.output) <= MAX and time.monotonic_ns() < self.reply_deadline, 'native reply bound/original budget')

    def close(self):
        if not self.closed:
            self.endpoint.close(); self.peer.close(); self.closed = True


class Owner:
    def __init__(self, installation, authority):
        self.i, self.a = installation, authority
        common_fd = installation.pin(authority['roles']['common'])
        self.c = installation.load_module('common', common_fd)
        self.settings = self.c.Settings(installation, authority)
        self.p = self.settings.p; self.q = self.settings.policy; self.fds = self.settings.fds
        self.authz_module = self.settings.modules['authz']
        self.http = self.settings.modules['http']; self.history = self.settings.modules['history']
        now = time.monotonic_ns()
        self.deadline = self.settings.deadline
        require(now < self.deadline <= now + 180_000_000_000, 'native original deployment lifetime must be finite <=180 seconds')
        require(os.geteuid() == 0 and len(sys.argv) == 1, 'fixed native owner invocation')
        for number, role in [(4, 'custodian'), (5, 'installation')]:
            actual, held = os.fstat(number), os.fstat(self.fds[role])
            require((actual.st_dev, actual.st_ino) == (held.st_dev, held.st_ino), 'native inherited entry/library differs')
        self.pid, self.start = os.getpid(), self.c.starttime(os.getpid())
        self.process = self.c.pinned_process(self.pid, self.start, self.fds['interpreter'], self.c.PROFILES['native'],
                                             '/system.slice/' + self.c.UNITS['native'])
        require(self.process['networkNamespaceInode'] != str(Path('/proc/1/ns/net').stat().st_ino),
                'native engine namespace must be fresh and isolated from host')
        unit = self.settings.unit('native', min(self.deadline, now + 500_000_000), self.pid)
        started_us = unit['ExecMainStartTimestampMonotonic']
        require(started_us.isdigit() and int(started_us) > 0 and self.deadline <= int(started_us) * 1000 + 180_000_000_000,
                'native original deadline exceeds PID1 start budget')
        self.c.old_units_stopped(self.fds['systemctl'], min(self.deadline, time.monotonic_ns() + 500_000_000))
        for role in ('daemon', 'containerd'):
            self.settings.unit(role, min(self.deadline, time.monotonic_ns() + 500_000_000), inactive=True)
        self.kernel = self.settings.kernel_policy()
        self.retained = self.c.retained_store_check(self.p, self.q, self.i)
        self.generation = os.urandom(32).hex()
        fence = {'version': 1, 'generation': self.generation, 'guestBootId': self.q['bootId'],
            'requestSha256': self.q['requestSha256'], 'nativePid': self.pid, 'nativeStarttime': self.start,
            'nativePolicySha256': self.a['policy']['sha256'], 'deadlineNs': str(self.deadline)}
        self.journal = self.history.Journal(self.p, self.generation, fence)
        parent = Path(ROOT).parent
        for path in [parent, *parent.parents]:
            info = path.lstat()
            require(path.resolve(strict=True) == path and info.st_uid == 0 and not info.st_mode & 0o022,
                    'native runtime ancestor custody')
        os.mkdir(ROOT, 0o700)  # EEXIST is unresolved, never unlink/chmod/reuse.
        self.root = self.c.private_directory(ROOT)
        self.rootfd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        import fcntl
        fcntl.flock(self.rootfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.mkdir(ROOT + '/raw', 0o700); os.mkdir(ROOT + '/clients', 0o700)
        self.raw = self.c.private_directory(ROOT + '/raw')
        self.clients = self.c.private_directory(ROOT + '/clients')
        os.fsync(self.rootfd)
        parentfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(parentfd)
        finally:
            os.close(parentfd)
        self.journal.append('PRIVATE_PARENT_CREATED', {'root': self.root, 'raw': self.raw, 'clients': self.clients,
            'nativeProcess': self.process, 'kernelPolicy': self.kernel, 'retainedConfigurations': self.retained})
        self.listeners = {}
        old_mask = os.umask(0o177)
        try:
            for kind, socktype in [('control', socket.SOCK_SEQPACKET), ('plugin', socket.SOCK_STREAM), ('client', socket.SOCK_STREAM)]:
                endpoint = socket.socket(socket.AF_UNIX, socktype)
                endpoint.bind(ROOT + '/' + kind + '.sock'); endpoint.listen(8); endpoint.setblocking(False)
                self.listeners[kind] = endpoint
        finally:
            os.umask(old_mask)
        self.journal.append('NATIVE_LISTENERS_CREATED', {kind: self.socket_identity(kind + '.sock') for kind in self.listeners})
        self.connections = []; self.launches = {}; self.start_jobs = {}; self.engines = {}
        self.binding = self.bootstrap_binding = self.guardian_identity = None
        self.plugin_inflight = self.proxy_inflight = 0; self.proxies = {}; self.activated = False; self.guardian_gone = False
        self.identity = self.birth_sha = None; self.failed = False
        self.authorizer = self.authz_module.Authorizer(self)
        self.raw_docker_socket = ROOT + '/raw/docker.sock'
        self.command_counts = {'physical': 0, 'broker': 0}
        self.bootstrap_deadline = min(self.deadline, int(started_us) * 1000 + 10_000_000_000)

    def socket_identity(self, relative):
        path = Path(ROOT, relative)
        info = path.lstat()
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o007 and
                not info.st_mode & 0o110, 'native private Unix socket metadata')
        return {'path': str(path), 'device': str(info.st_dev), 'inode': str(info.st_ino), 'mode': stat.S_IMODE(info.st_mode)}

    def endpoint_credentials(self, endpoint):
        pid, uid, gid = struct.unpack('3i', endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require((uid, gid) == (0, 0) and pid > 1, 'native endpoint requires actual root peer')
        return pid, endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 4096).rstrip(b'\0').decode()

    def control_peer(self, endpoint):
        pid, label = self.endpoint_credentials(endpoint)
        if label == self.c.PROFILES['launcher'] + ' (enforce)':
            argv = self.c.read(Path('/proc', str(pid), 'cmdline'), 16384).split(b'\0')
            roles = [role for role in ('daemon', 'containerd') if len(argv) == 5 and argv[-2] == role.encode()]
        else:
            roles = [role for role in ('guardian', 'recovery') if label == self.c.PROFILES[role] + ' (enforce)']
        require(len(roles) == 1, 'native control peer confinement')
        role = roles[0]; proc = Path('/proc', str(pid)); start = self.c.starttime(pid)
        entry_role = 'launcher' if role in ('daemon', 'containerd') else None
        executable = self.fds['interpreter'] if entry_role else self.fds[role + ':executable']
        entry_fd = self.fds[entry_role] if entry_role else self.fds[role + ':entry']
        cgroup = '/system.slice/' + self.c.UNITS[role]
        value = self.c.pinned_process(pid, start, executable, self.c.PROFILES['launcher' if entry_role else role], cgroup)
        actual, held = (proc / 'fd/4').stat(), os.fstat(entry_fd)
        require((actual.st_dev, actual.st_ino) == (held.st_dev, held.st_ino), 'native control immutable entry differs')
        python_path = self.a['roles']['interpreter']['path'] if entry_role else self.q['peers'][role]['executable']['path']
        argv = [python_path, '-I', '/proc/self/fd/4', *([role] if entry_role else [])]
        require(self.c.read(proc / 'cmdline', 16384) == b'\0'.join(arg.encode() for arg in argv) + b'\0', 'native control exact fixed invocation')
        if entry_role:
            require(value['networkNamespaceInode'] == self.process['networkNamespaceInode'], 'launcher outside native namespace')
            self.settings.unit(role, min(self.deadline, time.monotonic_ns() + 500_000_000), pid)
        return dict(value, role=role, executableSha256=(self.a['roles']['interpreter'] if entry_role else
                    self.q['peers'][role]['executable'])['sha256'])

    def assert_daemon_peer(self, endpoint):
        pid, label = self.endpoint_credentials(endpoint)
        require('daemon' in self.launches and pid == self.launches['daemon']['pid'] and
                label == self.c.PROFILES['daemon'] + ' (enforce)', 'AuthZ/raw socket peer is not fresh authorized daemon')
        value = self.engine_process('daemon')
        require(value['pid'] == pid, 'daemon peer incarnation differs')
        return value

    def engine_process(self, role):
        launch = self.launches[role]
        value = self.c.pinned_process(launch['pid'], launch['starttime'], self.fds[role], self.c.PROFILES[role],
                                      '/system.slice/' + self.c.UNITS[role])
        require(value['networkNamespaceInode'] == self.process['networkNamespaceInode'] and
                self.c.read(Path('/proc', str(launch['pid']), 'cmdline'), 16384) ==
                b'\0'.join(arg.encode() for arg in self.settings.engine_argv(role)) + b'\0', 'fresh engine namespace/argv differs')
        return value

    def assert_client_peer(self, endpoint, expected=None):
        require(self.identity is not None and self.binding is not None, 'client before fresh engine/request binding')
        pid, label = self.endpoint_credentials(endpoint)
        if label == self.c.PROFILES['guardian'] + ' (enforce)':
            value = self.control_peer(endpoint)
            require(value == self.guardian_identity, 'proxy guardian not original control owner')
        else:
            require(label == self.c.PROFILES['broker'] + ' (enforce)' and self.authorizer.live is not None and
                    self.authorizer.live['registration']['kind'] == 'broker', 'unregistered proxy client')
            value = self.c.pinned_process(pid, self.c.starttime(pid), self.fds['docker'], self.c.PROFILES['broker'],
                                         self.q['peers']['broker']['cgroup'])
            status = dict(line.split(':', 1) for line in self.c.read(Path('/proc', str(pid), 'status'), 16384).decode().splitlines() if ':' in line)
            require(status['NoNewPrivs'].strip() == '1' and all(int(status[key].strip(), 16) == 0 for key in
                    ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']), 'proxy broker privileges')
            argv = ['/usr/bin/docker', '--host', 'unix://' + ROOT + '/client.sock', '--config',
                    self.authorizer.live['configPath'], *self.authorizer.live['registration']['args']]
            require(self.c.read(Path('/proc', str(pid), 'cmdline'), 16384) == b'\0'.join(arg.encode() for arg in argv) + b'\0',
                    'proxy broker exact fixed command differs')
            value = dict(value, role='broker')
        require(expected is None or expected == value, 'proxy client process incarnation changed')
        return value

    def request_start(self, role):
        require(role in ('containerd', 'daemon') and role not in self.start_jobs, 'native startup duplicate/unknown role')
        self.settings.unit(role, min(self.deadline, time.monotonic_ns() + 500_000_000), inactive=True)
        self.journal.append('ENGINE_START_INTENT', {'role': role, 'unit': self.c.UNITS[role],
            'generation': self.generation, 'deadlineNs': str(self.deadline)})
        child = subprocess.Popen(['/usr/bin/systemctl', 'start', '--no-block', '--', self.c.UNITS[role]],
            executable='/proc/self/fd/' + str(self.fds['systemctl']), pass_fds=(self.fds['systemctl'],),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, cwd='/')
        self.start_jobs[role] = child

    def launch_authorize(self, control, body):
        role = control.identity['role']
        self.p.closed(body, ['role', 'nativePolicySha256'])
        require(body == {'role': role, 'nativePolicySha256': self.a['policy']['sha256']} and role in self.start_jobs and
                role not in self.launches and self.identity is None and time.monotonic_ns() < self.bootstrap_deadline,
                'native engine launch outside original one-shot startup')
        self.c.old_units_stopped(self.fds['systemctl'], min(self.deadline, time.monotonic_ns() + 500_000_000))
        require(self.settings.kernel_policy() == self.kernel and self.c.private_directory(ROOT) == self.root and
                self.c.private_directory(ROOT + '/raw') == self.raw, 'native birth custody changed before engine launch')
        record = {'role': role, 'pid': control.identity['pid'], 'starttime': control.identity['starttime'],
            'generation': self.generation, 'guestBootId': self.q['bootId'], 'requestSha256': self.q['requestSha256'],
            'nativePolicySha256': self.a['policy']['sha256'], 'deadlineNs': str(self.deadline),
            'argv': self.settings.engine_argv(role), 'configSha256': self.q['configs'][role]['sha256'],
            'executableSha256': self.a['roles'][role]['sha256'], 'nativePid': self.pid, 'nativeStarttime': self.start,
            'rawDirectory': self.raw, 'inheritedClientDescriptorsAllowed': False}
        self.launches[role] = record
        sha = self.journal.append('ENGINE_LAUNCH_AUTHORIZED', record)
        return dict(record, launchRecordSha256=sha)

    def activation_delivered(self):
        require(not self.activated and self.identity is None and 'daemon' in self.launches, 'duplicate/late plugin activation')
        self.journal.append('AUTHZ_ACTIVATED', {'daemon': self.engine_process('daemon'), 'generation': self.generation})
        self.activated = True

    def advance_startup(self):
        for role, child in self.start_jobs.items():
            code = child.poll()
            require(code is None or code == 0, 'fixed engine PID1 start request failed')
        if self.identity is not None:
            return
        require(time.monotonic_ns() < self.bootstrap_deadline, 'fresh engine startup original budget exhausted')
        if 'containerd' not in self.start_jobs:
            self.request_start('containerd')
            return
        if 'containerd' not in self.launches or not Path(ROOT + '/raw/containerd.sock').exists():
            return
        self.engine_process('containerd')
        if 'daemon' not in self.start_jobs:
            self.request_start('daemon')
            return
        if not self.activated or not Path(self.raw_docker_socket).exists():
            return
        require(all(child.poll() == 0 for child in self.start_jobs.values()), 'engine start request still unresolved')
        engines = {role: self.engine_process(role) for role in ('daemon', 'containerd')}
        for role, process in engines.items():
            self.settings.unit(role, min(self.deadline, time.monotonic_ns() + 500_000_000), process['pid'])
        sockets = {name: self.socket_identity('raw/' + name) for name in ['docker.sock', 'containerd.sock', 'containerd.sock.ttrpc']}
        require(self.plugin_inflight == self.proxy_inflight == 0, 'native birth with pending plugin/proxy')
        self.identity = {'version': 1, 'generation': self.generation, 'guestBootId': self.q['bootId'],
            'requestSha256': self.q['requestSha256'], 'nativePolicySha256': self.a['policy']['sha256'],
            'nativeProcess': self.process, 'engines': engines, 'root': self.root, 'raw': self.raw,
            'sockets': sockets, 'kernelPolicy': self.kernel,
            'configSha256': {role: self.q['configs'][role]['sha256'] for role in ('daemon', 'containerd')},
            'retainedConfigurationsSha256': self.p.digest(self.retained), 'privateFromBirth': True,
            'inheritedClientsExcluded': True, 'rawRoutes': 'native-to-docker;docker-to-containerd',
            'clientRoute': 'fixed-finite-read-proxy-with-authz-and-complete-wire-match'}
        self.birth_sha = self.journal.append('ENGINE_BIRTH', {'identity': self.identity, 'identitySha256': self.p.digest(self.identity)})

    def engine_identity_sha(self):
        require(self.identity is not None and not self.failed, 'native engines not admitted/failed')
        require(self.c.private_directory(ROOT) == self.root and self.c.private_directory(ROOT + '/raw') == self.raw and
                self.c.private_directory(ROOT + '/clients') == self.clients, 'native private birth directories replaced')
        for name, original in self.identity['sockets'].items():
            require(self.socket_identity('raw/' + name) == original, 'native raw socket incarnation changed')
        for role, original in self.identity['engines'].items():
            require(self.engine_process(role) == original, 'native engine process changed')
        return self.p.digest(self.identity)

    def fresh_snapshot(self):
        identity_sha = self.engine_identity_sha()
        require(self.settings.kernel_policy() == self.kernel, 'native loaded confinement changed')
        for role in ('native', 'daemon', 'containerd'):
            pid = self.pid if role == 'native' else self.launches[role]['pid']
            self.settings.unit(role, min(self.deadline, time.monotonic_ns() + 500_000_000), pid)
        self.c.old_units_stopped(self.fds['systemctl'], min(self.deadline, time.monotonic_ns() + 500_000_000))
        state = self.authorizer.snapshot()
        return {'identity': self.identity, 'identitySha256': identity_sha, 'birthRecordSha256': self.birth_sha,
            'nativeHistorySha256': self.journal.snapshot()['sha256'], 'readState': state, 'binding': self.binding,
            'deadlineNs': str(self.deadline), 'authorityRestored': False, 'automaticRetryAllowed': False}

    def validate_bootstrap(self, control, body):
        self.p.closed(body, ['requestSha256', 'guestBootId', 'localSessionId'])
        self.p.sha(body['localSessionId'])
        require(control.identity['role'] == 'guardian' and control.sequence == 0 and self.bootstrap_binding is None and
                time.monotonic_ns() < self.bootstrap_deadline and body['requestSha256'] == self.q['requestSha256'] and
                body['guestBootId'] == self.q['bootId'], 'native bootstrap target/phase/original startup budget')

    def dispatch(self, control, op, body):
        require(type(op) is str and type(body) is dict and time.monotonic_ns() < self.deadline, 'native control original budget')
        role = control.identity['role']
        if role in ('daemon', 'containerd'):
            require(op == 'AUTHORIZE_LAUNCH' and control.sequence == 0, 'launcher cannot invoke read/recovery APIs')
            return self.launch_authorize(control, body)
        require(self.identity is not None, 'native control admission before complete fresh engine birth')
        if role == 'recovery':
            require(op == 'RECOVERY_SNAPSHOT' and control.sequence == 0 and self.binding is not None, 'recovery API is observation-only')
            self.p.closed(body, ['binding'])
            require(body['binding'] == {key: self.binding[key] for key in body['binding']} and
                    set(body['binding']) == {'guestBootId', 'requestSha256', 'requestNonce', 'guardianSessionId', 'localSessionId'},
                    'native recovery original binding differs')
            # Dead guardian is observed now, never attested by a historical owner.
            guardian_unit = self.c.unit_views(self.fds['systemctl'], [self.c.UNITS['guardian']],
                min(self.deadline, time.monotonic_ns() + 500_000_000))[self.c.UNITS['guardian']]
            require(guardian_unit['MainPID'] == '0' and guardian_unit['ActiveState'] in ('inactive', 'failed') and
                    guardian_unit['Job'] == '' and self.c.cgroup_empty('/sys/fs/cgroup/system.slice/' + self.c.UNITS['guardian']),
                    'native recovery cannot overlap live guardian')
            result = self.fresh_snapshot()
            require(result['readState']['pendingRequests'] == 0 and result['readState']['activeRequestHandles'] == [],
                    'native recovery snapshot has pending requests')
            return result
        require(role == 'guardian', 'native control unknown owner role')
        if op == 'BOOTSTRAP':
            self.validate_bootstrap(control, body)
            self.p.closed(body, ['requestSha256', 'guestBootId', 'localSessionId'])
            self.p.sha(body['localSessionId'])
            require(self.bootstrap_binding is None and control.sequence == 0 and body['requestSha256'] == self.q['requestSha256'] and
                    body['guestBootId'] == self.q['bootId'], 'native bootstrap cannot reconnect/rebind')
            self.fresh_snapshot()
            self.bootstrap_binding = body; self.guardian_identity = control.identity
            self.journal.append('GUARDIAN_BOOTSTRAP', {'binding': body, 'guardian': control.identity})
            return dict(body, nativePolicySha256=self.a['policy']['sha256'], nativePid=self.pid, nativeStarttime=self.start,
                deadlineNs=str(self.deadline), birthRecordSha256=self.birth_sha, identity=self.identity, identitySha256=self.engine_identity_sha())
        require(control.identity == self.guardian_identity and self.bootstrap_binding is not None, 'native owner control identity differs')
        if op == 'BIND':
            self.p.closed(body, ['guardianSessionId', 'requestSha256', 'requestNonce', 'inputTableSha256', 'guestBootId', 'localSessionId'])
            require(self.binding is None and all(body[key] == value for key, value in self.bootstrap_binding.items()), 'native request binding replacement')
            for key in ['guardianSessionId', 'requestNonce', 'inputTableSha256']:
                self.p.sha(body[key])
            self.journal.append('GUARDIAN_BOUND', {'binding': body, 'guardian': control.identity})
            self.binding = body
            return dict(body, authorityRestored=False, automaticRetryAllowed=False)
        require(self.binding is not None, 'native operation before committed request binding')
        if op == 'REGISTER_READ':
            require(body.get('kind') in self.command_counts and body.get('command') == self.command_counts[body['kind']] + 1,
                    'native command sequence differs')
            result = self.authorizer.register(body)
            self.command_counts[body['kind']] += 1
            config = None; token = result['token']
            if body['kind'] == 'broker':
                config = ROOT + '/clients/' + result['registeredRecordSha256']
                os.mkdir(config, 0o700)
                path = Path(config, 'config.json')
                data = self.p.canonical({'HttpHeaders': {self.authz_module.TOKEN_HEADER: token}}) + b'\n'
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                try:
                    self.history.Journal.write_all(fd, data); os.fsync(fd)
                finally:
                    os.close(fd)
                dirfd = os.open(config, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                try:
                    os.fsync(dirfd)
                finally:
                    os.close(dirfd)
                self.authorizer.live['configPath'] = config
                token = None
            return dict(result, token=token, configPath=config, registration=body)
        if op == 'CLOSE_READ':
            self.p.closed(body, ['registeredRecordSha256'])
            return self.authorizer.close_read(body['registeredRecordSha256'])
        if op == 'SNAPSHOT':
            require(body == {}, 'native snapshot does not accept evidence')
            return self.fresh_snapshot()
        raise RuntimeError('unknown native operation; no mutation/retry/clear dispatch exists')

    def guardian_exited(self, identity):
        require(identity == self.guardian_identity and not self.guardian_gone and self.binding is not None and
                self.authorizer.live is None and self.plugin_inflight == self.proxy_inflight == 0,
                'guardian exit with unknown or pending native reads')
        self.journal.append('GUARDIAN_PEER_EXITED', {'guardian': identity, 'binding': self.binding,
            'pendingReadHandles': [], 'authorityRestored': False, 'automaticRetryAllowed': False})
        self.guardian_gone = True

    def decode_plugin(self, data):
        # Plugin JSON can exceed one MiB through bounded base64 response expansion.
        require(len(data) <= 2 * MAX, 'plugin JSON bound')
        def pairs(items):
            value = {}
            for key, item in items:
                require(key not in value, 'duplicate plugin JSON key')
                value[key] = item
            return value
        import json
        def invalid(_):
            raise RuntimeError('noninteger plugin JSON number')
        return json.loads(data, object_pairs_hook=pairs, parse_float=invalid, parse_constant=invalid)

    def retain_response(self, number, data):
        return self.journal.retain_response(number, data)

    def open_proxy_request(self, client, token, method, uri, target):
        entry = self.authorizer.live
        require(entry is not None and not self.authorizer.failed and type(token) is str and
                hmac.compare_digest(token, entry['token']) and time.monotonic_ns() < entry['deadline'] and
                entry['active'] is None and len(self.proxies) < 8192 and self.proxy_inflight == 1 and
                ((entry['registration']['kind'] == 'physical' and client['role'] == 'guardian') or
                 (entry['registration']['kind'] == 'broker' and client['role'] == 'broker')) and
                (target == entry['target'] or target[0] in ('ping', 'version')), 'native proxy registration/role/target differs')
        self.engine_identity_sha()
        proxy_id = os.urandom(32).hex()
        record = {'proxyId': proxy_id, 'registeredRecordSha256': entry['registeredSha256'],
                  'method': method, 'uri': uri, 'client': client}
        sha = self.journal.append('PROXY_REQUEST', record)
        self.proxies[proxy_id] = dict(record, requestRecordSha256=sha, delivered=False,
            callbackRecordSha256=None, wireRecordSha256=None, deliveredRecordSha256=None)
        return {'proxyId': proxy_id, 'deadlineNs': entry['deadline']}

    def assert_proxy_hook(self, proxy_id, entry, method, uri):
        value = self.proxies.get(proxy_id)
        require(value is not None and value['registeredRecordSha256'] == entry['registeredSha256'] and
                value['method'] == method and value['uri'] == uri and value['wireRecordSha256'] is None and
                value['delivered'] is False, 'AuthZ callback is not current proxy request')

    def verify_proxy_response(self, proxy_id, fields, body, head_only):
        entry = self.authorizer.live; value = self.proxies[proxy_id]
        require(entry is not None and not self.authorizer.failed and time.monotonic_ns() < entry['deadline'] and
                value['wireRecordSha256'] is None, 'wire response outside registered read')
        records = [row for row in entry['records'] if row['proxyId'] == proxy_id]
        require(len(records) == 1, 'complete wire response without exact completed AuthZ handler')
        callback = records[0]
        require(callback['responseBytes'] == len(body) and callback['responseBodySha256'] == hashlib.sha256(body).hexdigest() and
                callback['handlerReturned'] is True and callback['mutationRequestDispatched'] is False and
                (not head_only or callback['target'][0] == 'ping'), 'complete actual wire differs from AuthZ response body')
        record = {'proxyId': proxy_id, 'registeredRecordSha256': entry['registeredSha256'],
            'callbackRecordSha256': callback['responseRecordSha256'], 'responseBytes': len(body),
            'responseBodySha256': hashlib.sha256(body).hexdigest(), 'headOnly': head_only, 'completeWireMatched': True}
        value['wireRecordSha256'] = self.journal.append('PROXY_WIRE_VERIFIED', record)
        value['callbackRecordSha256'] = callback['responseRecordSha256']

    def proxy_delivered(self, proxy_id):
        value = self.proxies[proxy_id]
        require(value['wireRecordSha256'] is not None and not value['delivered'], 'proxy delivery before complete response verification')
        value['deliveredRecordSha256'] = self.journal.append('PROXY_DELIVERED', {'proxyId': proxy_id,
            'wireRecordSha256': value['wireRecordSha256'], 'registeredRecordSha256': value['registeredRecordSha256']})
        value['delivered'] = True

    def run(self):
        notify('READY=1\nWATCHDOG=1')
        last_notify = time.monotonic_ns()
        while True:
            now = time.monotonic_ns()
            if now >= self.deadline:
                require(not self.failed and self.identity is not None and self.binding is not None and
                        self.authorizer.live is None and self.plugin_inflight == self.proxy_inflight == 0,
                        'native original deadline with unresolved state')
                self.journal.append('NATIVE_OWNER_STOPPED', {'generation': self.generation,
                    'binding': self.binding, 'reason': 'original-deadline', 'pendingRequests': 0,
                    'authorityRestored': False, 'automaticRetryAllowed': False})
                return
            require(not self.failed, 'native custody failed')
            self.advance_startup()
            if now - last_notify >= 500_000_000:
                notify('WATCHDOG=1'); last_notify = now
            readers = list(self.listeners.values()); writers = []
            for connection in self.connections:
                r, w = connection.sockets(); readers.extend(r); writers.extend(w)
            readable, writable, _ = select.select(readers, writers, [], min(0.025, max(0, (self.deadline - now) / 1e9)))
            for kind, endpoint in self.listeners.items():
                if endpoint in readable:
                    client, _ = endpoint.accept()
                    require(len(self.connections) < 12, 'native aggregate connection bound')
                    try:
                        connection = Control(self, client) if kind == 'control' else self.http.PluginConnection(self, client) if kind == 'plugin' else self.http.ProxyConnection(self, client)
                    except BaseException:
                        client.close(); raise
                    self.connections.append(connection)
            for connection in list(self.connections):
                connection.poll(readable, writable)
                if connection.closed:
                    self.connections.remove(connection)
            require(time.monotonic_ns() < self.deadline, 'native owner processing exceeded original deadline')

    def unresolved(self, error):
        self.failed = True
        self.journal.append('NATIVE_UNRESOLVED', {'reason': type(error).__name__ + ': ' + str(error)[:192],
            'authorityRestored': False, 'fenceClearAuthorized': False, 'automaticRetryAllowed': False})
        # PID1 BindsTo/KillMode/watchdogs contain only the fixed owned services.
        # No unlink, old-service stop, volume/image cleanup or success receipt.


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 1, 'fixed native custodian entry')
    os.lseek(5, 0, os.SEEK_SET); source = os.read(5, MAX + 1)
    require(0 < len(source) <= MAX, 'native inherited installation bound')
    installation = types.ModuleType('native_installed_bootstrap')
    exec(compile(source, '<installed-native-library>', 'exec'), installation.__dict__)
    owner = None
    try:
        owner = Owner(installation, installation.anchor()); owner.run()
    except BaseException as error:
        if owner is not None:
            owner.unresolved(error)
        raise


if __name__ == '__main__':
    main()
