#!/usr/bin/env python3
"""Guardian-private fixed read-only Docker broker; no public dispatch interface.

Every process occupies an independently admitted empty bounded cgroup. Its
original command/inventory deadlines cannot be extended by another heartbeat.
The guardian polls bounded pipe reads and still handles Manager/owner traffic.
"""
import base64
import ctypes
import hashlib
import os
import re
import select
import signal
import subprocess
import time

MAX = 1048576
INFO = ['info', '--format', '{"id":{{json .ID}},"dockerRootDir":{{json .DockerRootDir}},"serverVersion":{{json .ServerVersion}}}']
LIST = ['image', 'ls', '--no-trunc', '--format', '{{json .}}']
INSPECT = ['image', 'inspect', '--format', '{"id":{{json .Id}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}}}']


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


class Broker:
    def __init__(self, p, slot, executable_fd, original_inventory_deadline_ns, max_images):
        self.p, self.slot, self.executable_fd = p, slot, executable_fd
        self.deadline = original_inventory_deadline_ns
        p.integer(max_images, 1, 256)
        self.max_images = max_images
        self.count = self.total = 0
        self.process = self.pidfd = None
        self.state = 'IDLE'
        self.output = bytearray(); self.error = bytearray()
        self.eof = set(); self.stop_started = None
        self.command_deadline = None
        self.seen = set()
        self.retained = None
        self.final_identity = False

    def prepare(self, args, parent_expiry_ns):
        require(self.state == 'IDLE' and self.slot.empty() and not self.final_identity, 'broker occupied, unsettled or already final')
        require(type(args) is list and all(type(arg) is str for arg in args), 'broker argument types')
        if self.count == 0:
            require(args == INFO, 'broker requires initial daemon identity')
        elif self.count == 1:
            require(args == LIST, 'broker requires retained image list')
        elif args == INFO:
            require(self.count >= 2 and self.retained is not None and self.seen == self.retained, 'broker final identity before complete inventory')
            self.final_identity = True
        else:
            require(len(args) == 5 and args[:4] == INSPECT and re.fullmatch('sha256:[a-f0-9]{64}', args[4]) and
                    args[4] not in self.seen and self.retained is not None and args[4] in self.retained, 'broker admits only unique retained image ID inspect')
            self.seen.add(args[4])
        require(self.count < self.max_images + 3, 'broker command count')
        now = time.monotonic_ns()
        self.command_deadline = min(now + 30_000_000_000, self.deadline)
        require(now < min(self.command_deadline, parent_expiry_ns), 'broker deadline expired')
        self.args = list(args)
        self.count += 1; self.state = 'PREPARED'
        return {'command': self.count, 'args': self.args, 'originalDeadlineNs': str(self.command_deadline),
                'cgroup': str(self.slot.path), 'cgroupDevice': self.slot.identity[0], 'cgroupInode': self.slot.identity[1]}

    def launch(self, native_config):
        # Called only after PREPARED is durably registered in guardian history.
        require(self.state == 'PREPARED' and self.slot.empty() and time.monotonic_ns() < self.command_deadline,
                'broker release before registration/deadline')
        require(type(native_config) is str and native_config.startswith('/run/lunchlineup/engine-custody/clients/'), 'fixed native broker config')
        self.p.sha(native_config.split('/')[-1])
        executable, slot_fd = self.executable_fd, self.slot.procs_fd
        def enter_slot():
            os.write(slot_fd, (str(os.getpid()) + '\n').encode())
            os.close(slot_fd)
            libc = ctypes.CDLL(None, use_errno=True)
            require(libc.prctl(38, 1, 0, 0, 0) == 0, 'broker no-new-privileges')
            for capability in range(41):
                require(libc.prctl(24, capability, 0, 0, 0) == 0, 'broker bounding set drop')
            require(libc.prctl(28, 15, 0, 0, 0) == 0, 'broker no-root securebits')
            class Header(ctypes.Structure):
                _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
            class Data(ctypes.Structure):
                _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
            header, caps = Header(0x20080522, 0), (Data * 2)()
            require(libc.capset(ctypes.byref(header), ctypes.byref(caps)) == 0, 'broker capability clear')
            with open('/proc/self/attr/exec', 'w') as profile:
                profile.write('exec lunchlineup-development-broker')
        try:
            self.process = subprocess.Popen(['/usr/bin/docker', '--host', 'unix:///run/lunchlineup/engine-custody/client.sock',
                '--config', native_config, *self.args], executable='/proc/self/fd/' + str(executable),
                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, cwd='/', stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
                pass_fds=(executable, slot_fd), start_new_session=True, preexec_fn=enter_slot)
            self.pidfd = os.pidfd_open(self.process.pid, 0)
            self.starttime = self._starttime()
            os.set_blocking(self.process.stdout.fileno(), False)
            os.set_blocking(self.process.stderr.fileno(), False)
            self.state = 'RUNNING'
        except BaseException:
            self.state = 'UNKNOWN'
            self.stop_started = time.monotonic_ns()
            raise

    def _starttime(self):
        with open('/proc/' + str(self.process.pid) + '/stat') as source:
            text = source.read(8193)
        require(len(text) <= 8192, 'broker proc bound')
        return text[text.rfind(')') + 2:].split()[19]

    def poll(self, parent_expiry_ns):
        require(self.state in ('RUNNING', 'STOPPING', 'UNKNOWN'), 'broker poll phase')
        now = time.monotonic_ns()
        if self.state == 'RUNNING' and now >= min(self.command_deadline, self.deadline, parent_expiry_ns):
            self.stop()
        if self.process is None:
            return None  # failed spawn is unresolved, never guessed successful
        if self.process.poll() is None:
            require(self._starttime() == self.starttime, 'broker process identity changed')
        # Two reads of at most64KiB per iteration, irrespective of producer speed.
        for name, stream, target in [('out', self.process.stdout, self.output), ('err', self.process.stderr, self.error)]:
            if name in self.eof:
                continue
            try:
                chunk = os.read(stream.fileno(), 65536)
            except BlockingIOError:
                continue
            if not chunk:
                self.eof.add(name)
                continue
            target.extend(chunk)
            if len(target) >= MAX or self.total + len(self.output) + len(self.error) > 16 * MAX:
                self.stop()
                # Retain bounded prefixes only, signal failure; no success packet.
                del target[MAX:]
        code = self.process.poll()
        if code is not None and self.slot.empty() and self.eof == {'out', 'err'}:
            success = self.state == 'RUNNING' and code == 0 and time.monotonic_ns() < min(self.command_deadline, self.deadline, parent_expiry_ns)
            if success and self.args == LIST:
                identities = set()
                for line in self.output.splitlines():
                    value = self.p.parse(bytes(line))
                    require(type(value) is dict and type(value.get('ID')) is str and re.fullmatch('sha256:[a-f0-9]{64}', value['ID']), 'broker retained list identity')
                    identities.add(value['ID'])
                    require(len(identities) <= self.max_images, 'broker retained image count')
                self.retained = identities
            self.state = 'SETTLED'
            self.total += len(self.output) + len(self.error)
            return {'command': self.count, 'exitCode': code, 'cgroupEmpty': True,
                    'stdoutBytes': len(self.output), 'stderrBytes': len(self.error),
                    'stdoutSha256': hashlib.sha256(self.output).hexdigest(),
                    'stderrPrefixHex': self.error[:4096].hex(), 'outcome': 'observed' if success else 'failed'}
        if self.stop_started is not None and now - self.stop_started >= 10_000_000_000:
            self.slot.kill()
            self.state = 'UNKNOWN'
        return None

    def response(self, worker_nonce):
        # Called only after guardian fsyncs the matching successful settlement.
        require(self.state == 'SETTLED' and self.process.returncode == 0 and self.slot.empty(), 'broker response before settlement')
        chunks = [bytes(self.output[index:index + 32768]) for index in range(0, len(self.output), 32768)]
        return [{'type': 'BROKER_BEGIN', 'workerNonce': worker_nonce, 'stdoutBytes': len(self.output),
                 'stderrBytes': len(self.error), 'stderrPrefixHex': self.error[:4096].hex(), 'returncode': 0,
                 'stdoutSha256': hashlib.sha256(self.output).hexdigest(), 'chunks': len(chunks)},
                *({'type': 'BROKER_CHUNK', 'workerNonce': worker_nonce, 'index': index,
                   'base64': base64.b64encode(chunk).decode('ascii')} for index, chunk in enumerate(chunks))]

    def reset_settled(self):
        require(self.state == 'SETTLED' and self.slot.empty(), 'broker cleanup before settlement')
        for stream in [self.process.stdout, self.process.stderr]:
            stream.close()
        if self.pidfd is not None:
            os.close(self.pidfd)
        self.pidfd = self.process = None
        self.output.clear(); self.error.clear(); self.eof.clear()
        self.stop_started = None; self.state = 'IDLE'

    def stop(self):
        if self.state not in ('STOPPING', 'UNKNOWN', 'SETTLED'):
            self.state = 'STOPPING'; self.stop_started = time.monotonic_ns()
            if self.pidfd is not None:
                try:
                    signal.pidfd_send_signal(self.pidfd, signal.SIGTERM)
                except ProcessLookupError:
                    pass


if __name__ == '__main__':
    raise SystemExit('Guardian-private broker has no public command interface.')
