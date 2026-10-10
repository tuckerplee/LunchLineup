#!/usr/bin/env python3
"""Fixed guardian-owned read-only workers; no arbitrary command/job dispatch.

Loaded from an independent installed pin by the guardian. Child code runs with
an explicitly installed non-root UID/GID, in an empty admitted bounded cgroup,
with only control/immutable descriptors. No Manager/HMAC/SSH key is transferred.
"""
import array
import ctypes
import grp
import hashlib
import os
from pathlib import Path
import resource
import select
import signal
import socket
import stat
import struct
import subprocess
import time

MAX = 1048576
ROLES = ('archive-preflight', 'image-inventory')


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def packet(endpoint, p, value, descriptors=()):
    body = p.canonical(value)
    require(0 < len(body) <= MAX, 'worker packet bound')
    ancillary = []
    if descriptors:
        require(len(descriptors) <= 68, 'worker descriptor bound')
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', descriptors))]
    require(endpoint.sendmsg([body], ancillary, socket.MSG_NOSIGNAL) == len(body), 'worker packet short send')


def receive(endpoint, p, expected_credentials, allow_rights=0):
    """All rejected delivered rights are closed, including truncated packets."""
    body, ancillary, flags, _ = endpoint.recvmsg(MAX + 1, socket.CMSG_SPACE(12) + socket.CMSG_SPACE(256 * 4), socket.MSG_CMSG_CLOEXEC)
    descriptors = []; credentials = []; invalid = False
    try:
        for level, kind, data in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array('i')
                values.frombytes(data[:len(data) - len(data) % values.itemsize])
                descriptors.extend(values)
                invalid |= bool(len(data) % values.itemsize)
            elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(data) == 12:
                credentials.append(struct.unpack('3i', data))
            else:
                invalid = True
        require(body and not invalid and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) and
                credentials == [expected_credentials] and len(descriptors) == allow_rights,
                'worker peer/ancillary/descriptor mismatch')
        return p.parse(body), descriptors
    except BaseException:
        for fd in descriptors:
            try:
                os.close(fd)
            except OSError:
                pass
        raise


class CgroupSlot:
    """One preinstalled PID1-owned empty slot; never creates/deletes cgroups.

    Policy must name its real root-owned cgroup and exact installed kernel
    limits. This does not substitute for Manager physical storage/writer proof.
    """
    def __init__(self, p, policy):
        p.closed(policy, ['path', 'memoryMax', 'pidsMax', 'cpuMax', 'ioMax'])
        path = Path(policy['path'])
        require(path.is_absolute() and str(path).startswith('/sys/fs/cgroup/') and
                path.resolve(strict=True) == path, 'worker cgroup path')
        for parent in [path, *path.parents]:
            info = parent.lstat()
            require(info.st_uid == 0 and not info.st_mode & 0o022, 'worker cgroup custody')
        p.integer(policy['memoryMax'], 16 * MAX, 512 * MAX)
        p.integer(policy['pidsMax'], 2, 32)
        cpu = policy['cpuMax'].split()
        require(len(cpu) == 2 and all(x.isascii() and x.isdigit() for x in cpu) and
                1000 <= int(cpu[0]) <= int(cpu[1]) <= 1000000, 'finite worker CPU limit')
        require(type(policy['ioMax']) is str and 0 < len(policy['ioMax']) <= 4096 and
                'max' not in policy['ioMax'] and '\n\n' not in policy['ioMax'], 'finite installed worker IO limit')
        for name, expected in [('memory.max', str(policy['memoryMax'])), ('pids.max', str(policy['pidsMax'])),
                               ('cpu.max', policy['cpuMax']), ('io.max', policy['ioMax'])]:
            require((path / name).read_text().strip() == expected.strip(), 'worker cgroup limit differs')
        self.path = path
        info = path.stat()
        self.identity = (info.st_dev, info.st_ino)
        require(self.empty(), 'worker slot is not empty')
        self.procs_fd = os.open(path / 'cgroup.procs', os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW)

    def empty(self):
        info = self.path.stat()
        require((info.st_dev, info.st_ino) == self.identity, 'worker cgroup replaced')
        pending = [self.path]; count = 0
        while pending:
            path = pending.pop(); count += 1
            require(count <= 16, 'worker cgroup subtree bound')
            info = path.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'worker subtree custody')
            text = (path / 'cgroup.events').read_text()
            if 'populated 0\n' not in text or (path / 'cgroup.procs').read_text().strip():
                return False
            for child in path.iterdir():
                if child.is_dir():
                    require(not child.is_symlink(), 'worker cgroup symlink')
                    pending.append(child)
        return True

    def kill(self):
        # Kernel cgroup.kill recursively targets this exact registered slot.
        # Permission/kernel failure leaves UNKNOWN; never guess settlement.
        info = self.path.stat()
        require((info.st_dev, info.st_ino) == self.identity, 'worker cgroup replaced')
        with (self.path / 'cgroup.kill').open('w') as output:
            output.write('1\n')

    def close(self):
        fd, self.procs_fd = self.procs_fd, None
        if fd is not None:
            os.close(fd)


class Worker:
    """Two-phase prepare/release, one guardian-owned child and immutable plan.

    Constructor creates only private endpoints/registration data. launch happens
    only AFTER the guardian fsyncs the exact registration. No path/argv/role from
    an application is executed; role and descriptor pins come from installed
    selection. stdin/stdout/stderr expose no privileged inherited stream.
    """
    def __init__(self, p, policy, slot, interpreter_fd, entry_fd, lock_fd, context, input_fds):
        p.closed(policy, ['uid', 'gid', 'groups', 'fileBytes', 'openFiles', 'cpuSeconds', 'apparmorProfile'])
        p.integer(policy['uid'], 1, 2**31 - 1); p.integer(policy['gid'], 1, 2**31 - 1)
        require(policy['groups'] == [] and policy['apparmorProfile'] == 'lunchlineup-development-worker', 'worker has no supplementary groups and requires fixed confinement')
        try:
            docker_gid = grp.getgrnam('docker').gr_gid
        except KeyError:
            docker_gid = None
        require(policy['gid'] != docker_gid, 'worker cannot join Docker group')
        p.integer(policy['fileBytes'], MAX, 2 * MAX)
        p.integer(policy['openFiles'], 80, 128); p.integer(policy['cpuSeconds'], 1, 1800)
        p.closed(context, ['role', 'workerNonce', 'requestSha256', 'selectionSha256', 'grantId', 'managerEpoch',
                           'guardianSessionId', 'originalDeadlineNs', 'inputTable', 'operation'])
        require(context['role'] in ROLES and type(input_fds) is dict and set(input_fds) == set(context['inputTable']) and
                1 <= len(input_fds) <= 66, 'fixed worker role/input set')
        for name in ['workerNonce', 'requestSha256', 'selectionSha256', 'managerEpoch', 'guardianSessionId']:
            p.sha(context[name])
        deadline = p.local_nanoseconds(context['originalDeadlineNs'])
        now = time.monotonic_ns()
        cap = 60 if context['role'] == 'image-inventory' else 1800
        require(now < deadline <= now + cap * 1000000000, 'original worker deadline bound')
        for role, fd in input_fds.items():
            pin = context['inputTable'][role]
            p.closed(pin, ['bytes', 'sha256', 'veritySha256', 'device', 'inode'])
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino, info.st_size) ==
                    (pin['device'], pin['inode'], pin['bytes']), 'worker pinned descriptor identity')
        self.p, self.policy, self.slot = p, policy, slot
        self.interpreter_fd, self.entry_fd, self.lock_fd = interpreter_fd, entry_fd, lock_fd
        self.context = p.parse(p.canonical(context)); self.inputs = dict(input_fds)
        self.deadline, self.state = deadline, 'PREPARED'
        self.parent, self.child_endpoint = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.parent.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        self.parent.setblocking(False)
        self.process = None; self.pidfd = None; self.result = None
        self.sequence = 0; self.diagnostic_count = 0; self.diagnostic_bytes = 0
        self.stop_started = None
        self.guardian_pid = os.getpid()

    def registration(self):
        return {'workerNonce': self.context['workerNonce'], 'role': self.context['role'],
                'contextSha256': self.p.digest(self.context), 'cgroup': str(self.slot.path),
                'cgroupDevice': self.slot.identity[0], 'cgroupInode': self.slot.identity[1],
                'originalDeadlineNs': str(self.deadline), 'state': 'PREPARED'}

    def launch(self):
        require(self.state == 'PREPARED' and self.slot.empty() and time.monotonic_ns() < self.deadline,
                'worker release phase/deadline')
        import fcntl
        # Duplicate sources away from the fixed ABI slots before fork. Parent
        # owns valid FD3 (supervisor endpoint) and FD4 (guardian script).
        control_fd = fcntl.fcntl(self.child_endpoint.fileno(), fcntl.F_DUPFD_CLOEXEC, 16)
        script_fd = fcntl.fcntl(self.entry_fd, fcntl.F_DUPFD_CLOEXEC, 16)
        exec_fd = fcntl.fcntl(self.interpreter_fd, fcntl.F_DUPFD_CLOEXEC, 16)
        slot_fd = fcntl.fcntl(self.slot.procs_fd, fcntl.F_DUPFD_CLOEXEC, 16)
        policy = self.policy
        def before_exec():
            # Fixed trusted pre-exec instructions only; guardian is single-threaded.
            os.write(slot_fd, (str(os.getpid()) + '\n').encode())
            os.close(slot_fd)
            os.dup2(control_fd, 3, inheritable=True)
            os.dup2(script_fd, 4, inheritable=True)
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_FSIZE, (policy['fileBytes'], policy['fileBytes']))
            resource.setrlimit(resource.RLIMIT_NOFILE, (policy['openFiles'], policy['openFiles']))
            resource.setrlimit(resource.RLIMIT_CPU, (policy['cpuSeconds'], policy['cpuSeconds']))
            # No raw daemon network, privilege escalation, or unconfined exec.
            # Missing namespace/LSM support fails before executing worker code.
            libc = ctypes.CDLL(None, use_errno=True)
            require(libc.unshare(ctypes.c_int(0x40000000)) == 0, 'worker network namespace unavailable')
            require(libc.prctl(38, 1, 0, 0, 0) == 0, 'worker no-new-privileges unavailable')
            with open('/proc/self/attr/exec', 'w') as profile:
                profile.write('exec ' + policy['apparmorProfile'])
            os.setgroups([]); os.setgid(policy['gid']); os.setuid(policy['uid'])
        try:
            self.process = subprocess.Popen(['/proc/self/fd/' + str(exec_fd), '-I', '/proc/self/fd/4', self.context['workerNonce']],
                executable='/proc/self/fd/' + str(exec_fd), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, cwd='/', close_fds=True,
                pass_fds=(3, 4, control_fd, script_fd, exec_fd, slot_fd), start_new_session=True, preexec_fn=before_exec)
            self.pidfd = os.pidfd_open(self.process.pid, 0)
            self.starttime = self._proc_start()
            self.state = 'STARTED'
        except BaseException:
            self.state = 'UNKNOWN'
            raise
        finally:
            for fd in [control_fd, script_fd, exec_fd, slot_fd]:
                os.close(fd)
            # Retain this private endpoint solely for physical kcmp identity.
            # pidfd/process state, never socket EOF alone, determines settlement.

    def _proc_start(self):
        text = Path('/proc', str(self.process.pid), 'stat').read_text()
        return text[text.rfind(')') + 2:].split()[19]

    def _identity(self):
        require(self.pidfd is not None and not select.select([self.pidfd], [], [], 0)[0] and
                self._proc_start() == self.starttime, 'worker PID identity changed/exited')
        proc = Path('/proc') / str(self.process.pid)
        status = (proc / 'status').read_text()
        values = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
        require(values['NoNewPrivs'].strip() == '1' and int(values['CapEff'].strip(), 16) == 0 and
                int(values['CapPrm'].strip(), 16) == 0 and int(values['CapAmb'].strip(), 16) == 0 and
                values['Groups'].strip() == '', 'worker capability/group confinement differs')
        require((proc / 'attr/current').read_text().strip() == self.policy['apparmorProfile'] + ' (enforce)', 'worker AppArmor not enforcing')
        require((proc / 'ns/net').stat().st_ino != Path('/proc/self/ns/net').stat().st_ino, 'worker shares guardian network namespace')
        relative = str(self.slot.path)[len('/sys/fs/cgroup'):]
        require((proc / 'cgroup').read_text() == '0::' + relative + '\n', 'worker left registered cgroup')
        for name, fd in [('exe', self.interpreter_fd), ('fd/4', self.entry_fd)]:
            observed = (proc / name).stat(); expected = os.fstat(fd)
            require((observed.st_dev, observed.st_ino) == (expected.st_dev, expected.st_ino), 'worker executable/script pin differs')

    def poll(self, current_parent_expiry_ns):
        """Returns at most one diagnostic/result event; never waits for a child."""
        require(self.state in ('STARTED', 'CONTEXT_SENT', 'RUNNING', 'RESULT_PENDING', 'RESULT', 'STOPPING', 'UNKNOWN'), 'worker poll phase')
        now = time.monotonic_ns()
        if now >= min(self.deadline, current_parent_expiry_ns) and self.state not in ('STOPPING', 'UNKNOWN'):
            self.stop()
        if self.state in ('STOPPING', 'UNKNOWN'):
            return self._settle(now)
        if self.process.poll() is not None:
            return self._settle(now)
        self._identity()
        try:
            message, _ = receive(self.parent, self.p, (self.process.pid, self.policy['uid'], self.policy['gid']))
        except BlockingIOError:
            return None
        self.p.closed(message, ['sequence', 'workerNonce', 'type', 'body'])
        self.p.integer(message['sequence'], self.sequence, self.sequence)
        require(message['workerNonce'] == self.context['workerNonce'], 'worker nonce differs')
        self.sequence += 1
        if message['type'] == 'HELLO':
            require(self.state == 'STARTED' and message['body'] == {'guardianPid': self.guardian_pid}, 'worker HELLO phase/parent')
            descriptors = [self.lock_fd] + [self.inputs[k] for k in sorted(self.inputs)]
            packet(self.parent, self.p, {'type': 'CONTEXT', 'context': self.context, 'inputRoles': sorted(self.inputs),
                                         'guardianPid': self.guardian_pid, 'guardianLockFd': self.lock_fd}, descriptors)
            self.state = 'CONTEXT_SENT'
            return None
        if message['type'] == 'FD_ACK':
            require(self.state == 'CONTEXT_SENT', 'worker descriptor acknowledgement phase')
            body = message['body']
            self.p.closed(body, ['contextSha256', 'lockFd', 'inputFds'])
            require(body['contextSha256'] == self.p.digest(self.context) and type(body['inputFds']) is dict and
                    set(body['inputFds']) == set(self.inputs), 'worker descriptor acknowledgement binding')
            pairs = [(self.lock_fd, body['lockFd'])] + [(fd, body['inputFds'][role]) for role, fd in self.inputs.items()]
            remote_fds = [remote for _, remote in pairs]
            require(len(set(remote_fds)) == len(remote_fds), 'worker descriptor aliases')
            require(os.uname().machine == 'x86_64', 'worker OFD proof unsupported architecture')
            libc = ctypes.CDLL(None, use_errno=True)
            for local, remote in pairs:
                self.p.integer(remote, 5, self.policy['openFiles'] - 1)
                require(libc.syscall(ctypes.c_long(312), ctypes.c_int(os.getpid()), ctypes.c_int(self.process.pid),
                                    ctypes.c_int(0), ctypes.c_ulong(local), ctypes.c_ulong(remote)) == 0,
                        'worker did not inherit the registered open file description')
            self._identity()
            require(time.monotonic_ns() < min(self.deadline, current_parent_expiry_ns), 'worker entry deadline elapsed')
            packet(self.parent, self.p, {'type': 'ENTER', 'workerNonce': self.context['workerNonce'],
                                         'contextSha256': self.p.digest(self.context)})
            self.state = 'RUNNING'
            return {'type': 'authenticated', 'workerNonce': self.context['workerNonce'], 'pid': self.process.pid,
                    'starttime': self.starttime, 'contextSha256': self.p.digest(self.context)}
        if message['type'] == 'BROKER_READ':
            require(self.state == 'RUNNING' and self.context['role'] == 'image-inventory', 'worker broker phase/role')
            self.p.closed(message['body'], ['args'])
            return {'type': 'broker-read', 'workerNonce': self.context['workerNonce'], 'args': message['body']['args']}
        if message['type'] == 'DIAGNOSTIC':
            require(self.state == 'RUNNING', 'worker diagnostic phase')
            size = len(self.p.canonical(message['body']))
            self.diagnostic_count += 1; self.diagnostic_bytes += size
            require(size <= 16384 and self.diagnostic_count <= 259 and self.diagnostic_bytes <= 259 * 16384, 'worker diagnostic bound')
            return {'type': 'diagnostic', 'workerNonce': self.context['workerNonce'], 'body': message['body']}
        if message['type'] == 'RESULT':
            require(self.state == 'RUNNING', 'worker result phase')
            self.result = message['body']; self.state = 'RESULT_PENDING'
            return {'type': 'result-pending', 'workerNonce': self.context['workerNonce'], 'result': self.result}
        if message['type'] == 'LEASE_CHECK':
            require(self.state == 'RUNNING' and message['body'] == {}, 'worker lease request phase')
            expiry = min(self.deadline, current_parent_expiry_ns)
            require(now < expiry, 'worker lease unavailable')
            packet(self.parent, self.p, {'type': 'LEASE', 'workerNonce': self.context['workerNonce'], 'expiryNs': str(expiry)})
            return None
        raise RuntimeError('unknown worker packet')

    def acknowledge_result(self, current_parent_expiry_ns):
        # Guardian calls only after fsync of result and its identity link.
        require(self.state == 'RESULT_PENDING' and time.monotonic_ns() < min(self.deadline, current_parent_expiry_ns), 'worker result acknowledgement phase/deadline')
        packet(self.parent, self.p, {'type': 'RESULT_ACK', 'workerNonce': self.context['workerNonce'],
                                     'resultSha256': self.p.digest(self.result)})
        self.state = 'RESULT'

    def stop(self):
        if self.state not in ('STOPPING', 'UNKNOWN', 'SETTLED'):
            self.state = 'STOPPING'; self.stop_started = time.monotonic_ns()
            if self.pidfd is not None:
                signal.pidfd_send_signal(self.pidfd, signal.SIGTERM)

    def _settle(self, now):
        code = self.process.poll() if self.process is not None else None
        if code is not None and self.slot.empty():
            success = self.state == 'RESULT' and code == 0 and self.result is not None
            self.state = 'SETTLED'
            return {'type': 'settled', 'workerNonce': self.context['workerNonce'], 'exitCode': code,
                    'cgroupEmpty': True, 'outcome': 'observed' if success else 'failed',
                    'result': self.result if success else None}
        if self.stop_started is not None and now - self.stop_started >= 10_000_000_000:
            self.slot.kill()
            self.state = 'UNKNOWN'
        return None

    def close_settled(self):
        require(self.state == 'SETTLED' and self.slot.empty(), 'cannot release unsettled worker')
        self.parent.close()
        self.child_endpoint.close()
        if self.pidfd is not None:
            os.close(self.pidfd); self.pidfd = None
        self.slot.close()


if __name__ == '__main__':
    raise SystemExit('Worker registry is guardian-internal; no public command dispatch.')
