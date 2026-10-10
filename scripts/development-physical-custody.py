#!/usr/bin/env python3
"""Guardian-private physical custody collector. No CLI, installer or mutation.

Approved compiled LSM bytes are compared with live kernel exports; service,
process, socket, config, owner and original OFD observations must all agree.
Unknown/replaced/unreadable state fails. Trusted root ownership is explicit;
this does not claim protection from a hostile unrestricted root operator.
"""
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import socket
import stat
import struct
import subprocess
import time

MAX = 1048576
LABELS = {role: 'lunchlineup-development-' + role for role in
          ['guardian', 'supervisor', 'worker', 'broker', 'daemon', 'containerd']}
LABELS.update(native='lunchlineup-development-engine-custodian', recovery='lunchlineup-development-recovery')
AA = Path('/sys/kernel/security/apparmor')


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


class Collector:
    def __init__(self, guardian):
        self.g, self.p, self.i = guardian, guardian.p, guardian.i
        self.end = None
        admission = guardian.policy['physicalWriterProof']
        require(admission is not None, 'physical exclusion policy not installed')
        # This is an independently pinned policy, never a request or saved proof.
        fd = self.i.pin(admission, True, MAX)
        try:
            self.policy = self.p.parse(os.read(fd, MAX + 1))
        finally:
            os.close(fd)
        q = self.policy
        require(guardian.a['managerKey']['path'].startswith('/etc/lunchlineup/private/') and
                guardian.policy['ssh']['identity']['path'].startswith('/etc/lunchlineup/private/'), 'private credential paths outside enforcing deny boundary')
        self.p.closed(q, ['version', 'bootId', 'machineId', 'lsm', 'engines', 'maintenance',
                          'ownerAuthorization', 'trustedRootProcesses', 'proofDirectory', 'systemctl',
                          'containerLimit', 'store', 'runtimeSocket', 'runtimeDirectories', 'kernelFeatures'])
        require(type(q['version']) is int and q['version'] == 1 and q['bootId'] == guardian.boot and
                q['machineId'] == '80a9dfd43bbc6a074cf9148daa5335c2', 'physical policy target/boot')
        require(type(q['runtimeDirectories']) is list and 1 <= len(q['runtimeDirectories']) <= 8 and
                type(q['kernelFeatures']) is dict and 1 <= len(q['kernelFeatures']) <= 32, 'complete runtime/kernel feature inventory')
        require(set(q['lsm']) == set(LABELS) and set(q['engines']) == {'daemon', 'containerd'}, 'complete fixed confinement roles required')
        require(type(q['maintenance']) is list and 1 <= len(q['maintenance']) <= 64 and
                type(q['trustedRootProcesses']) is list and len(q['trustedRootProcesses']) <= 256, 'physical inventory bound')
        self.p.integer(q['containerLimit'], 0, 128)
        self.held = {}; self.sequence = self.proof_bytes = 0
        for role, entry in q['lsm'].items():
            self.p.closed(entry, ['profileDirectory', 'profileSha256', 'compiled', 'source', 'abi'])
            self.p.sha(entry['profileSha256'])
            # Source + pinned ABI + compiled bytes are owner-approved together;
            # the collector does not invent a compiler provenance attestation.
            for item in ['compiled', 'source', 'abi']:
                self.held[role + ':' + item] = self.i.pin(entry[item], maximum=4 * MAX)
        for role, entry in q['engines'].items():
            self.p.closed(entry, ['unit', 'executable', 'config', 'argv', 'cgroup', 'unitFile', 'dropIns'])
            require(type(entry['argv']) is list and all(type(arg) is str for arg in entry['argv']), 'exact engine argv required')
            for item in ['executable', 'config', 'unitFile']:
                self.held[role + ':' + item] = self.i.pin(entry[item])
            require(type(entry['dropIns']) is list and len(entry['dropIns']) <= 16, 'engine drop-in bound')
            for index, pin in enumerate(entry['dropIns']):
                self.held[role + ':dropIn:' + str(index)] = self.i.pin(pin)
        self.held['systemctl'] = self.i.pin(q['systemctl'])
        self.root_pins = {}
        root_bytes = 0
        for entry in q['trustedRootProcesses']:
            self.p.closed(entry, ['pid', 'starttime', 'cgroup', 'executable', 'purpose'])
            identity = self.p.digest(entry['executable'])
            if identity not in self.root_pins:
                root_bytes += entry['executable']['bytes']
                require(root_bytes <= 256 * MAX, 'trusted root immutable input bound')
                self.root_pins[identity] = self.i.pin(entry['executable'])
        auth_fd = self.i.pin(q['ownerAuthorization'], True)
        try:
            self.authorization = self.p.parse(os.read(auth_fd, MAX + 1))
        finally:
            os.close(auth_fd)
        self.p.closed(self.authorization, ['bootId', 'requestSha256', 'installationSha256', 'policySha256',
            'operatorOwner', 'approvalReference', 'notAfterBootNs', 'rootWriterRule', 'maintenanceInventorySha256',
            'trustedRootInventorySha256', 'registryPath'])
        auth = self.authorization
        require(auth['bootId'] == guardian.boot and auth['requestSha256'] == guardian.policy['approvedRequestBindings']['requestSha256'] and
                auth['installationSha256'] == guardian.policy['installation']['guardianInstallationSha256'] and
                auth['policySha256'] == self.p.digest({key: value for key, value in q.items() if key != 'ownerAuthorization'}) and auth['maintenanceInventorySha256'] == self.p.digest(q['maintenance']) and
                auth['trustedRootInventorySha256'] == self.p.digest(q['trustedRootProcesses']) and
                auth['rootWriterRule'] == 'only-this-guardian-and-its-fixed-broker;no-concurrent-root-maintenance', 'owner authorization differs')
        require(all(type(auth[k]) is str and 1 <= len(auth[k]) <= 256 for k in ['operatorOwner', 'approvalReference']), 'named outside owner/approval required')
        self.owner_deadline = self.p.local_nanoseconds(auth['notAfterBootNs'])
        self.require_prior_clients_excluded()
        # Separate from deployment OFD: registry custody survives its controlled
        # terminal unlock. Existing owner or stale record is never overwritten.
        registry = Path(auth['registryPath'])
        require(registry == Path('/run/lunchlineup/development-writer.owner'), 'fixed writer registry path')
        self.directory_custody(registry.parent)
        self.owner_fd = os.open(registry, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        fcntl.flock(self.owner_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        owner = {'bootId': guardian.boot, 'guardianPid': os.getpid(), 'guardianStarttime': self.proc_start(os.getpid()),
                 'localSessionId': guardian.local_id, 'requestSha256': auth['requestSha256'],
                 'authorizationSha256': q['ownerAuthorization']['sha256']}
        self.owner_bytes = self.p.canonical(owner)
        self.write_all(self.owner_fd, self.owner_bytes); os.fsync(self.owner_fd)
        self.fsync_dir(registry.parent)
        self.owner_path = registry
        self.proof_dir = Path(q['proofDirectory']); self.directory_custody(self.proof_dir, private=True)
        self.proof_dir_fd = os.open(self.proof_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        self.end = None; self.retained_cache = None

    def require_prior_clients_excluded(self):
        # Fresh native birth plus actual peer/entry/LSM custody, not chmod/census.
        self.g.native.assert_identity()
        value = self.g.native.bootstrap['identity']
        require(value['privateFromBirth'] is True and value['inheritedClientsExcluded'] is True and
                value['rawRoutes'] == 'native-to-docker;docker-to-containerd' and
                value['clientRoute'] == 'fixed-finite-read-proxy-with-authz-and-complete-wire-match' and
                set(value['engines']) == {'daemon', 'containerd'}, 'concrete native engine custody missing')
        require(self.p.digest(value) == self.g.native.bootstrap['identitySha256'], 'native birth identity digest')
        return value

    def directory_custody(self, path, private=False):
        require(path.is_absolute() and path.resolve(strict=True) == path, 'physical directory canonical custody')
        for part in [path, *path.parents]:
            info = part.lstat()
            require(info.st_uid == 0 and not info.st_mode & 0o022, 'physical directory writable by another actor')
        require(stat.S_ISDIR(path.stat().st_mode) and (not private or not path.stat().st_mode & 0o077), 'physical directory privacy')

    def fsync_dir(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    @staticmethod
    def write_all(fd, data):
        remaining = memoryview(data)
        while remaining:
            count = os.write(fd, remaining)
            require(count > 0, 'physical evidence short write')
            remaining = remaining[count:]

    def budget(self):
        require(self.end is not None and time.monotonic_ns() < self.end, 'physical collection original deadline elapsed')

    def read(self, path, maximum=16384):
        if self.end is not None:
            self.budget()
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        try:
            raw = bytearray()
            while len(raw) <= maximum:
                block = os.read(fd, min(65536, maximum + 1 - len(raw)))
                if not block:
                    break
                raw.extend(block)
            require(len(raw) <= maximum, 'physical observation size bound')
            return bytes(raw)
        finally:
            os.close(fd)
            if self.end is not None:
                self.budget()

    def proc_start(self, pid):
        text = self.read(Path('/proc', str(pid), 'stat'), 8192).decode()
        return text[text.rfind(')') + 2:].split()[19]

    def kernel_policy(self):
        require(self.read('/sys/module/apparmor/parameters/enabled', 16).strip() == b'Y' and
                self.read('/sys/module/apparmor/parameters/mode', 32).strip() == b'enforce', 'global AppArmor enforcement unavailable')
        mounts = self.read('/proc/self/mountinfo', MAX).decode().splitlines()
        require(any(' /sys/kernel/security ' in row and ' - securityfs ' in row for row in mounts), 'actual securityfs required')
        features = {}
        for relative, expected in self.policy['kernelFeatures'].items():
            require(type(relative) is str and re.fullmatch('[a-zA-Z0-9_/-]+', relative) and not relative.startswith('/') and '..' not in relative.split('/') and
                    type(expected) is str and 0 < len(expected) <= 4096, 'bounded exact kernel feature ABI')
            observed = self.read(AA / 'features' / relative, 4096).decode()
            require(observed == expected, 'running kernel mediation feature differs')
            features[relative] = observed
        require({'network/af_unix', 'ptrace/mask', 'domain/change_onexec', 'domain/change_profile', 'file/mask', 'namespaces/mask'} <= set(features), 'required Unix/ptrace/domain/userns feature coverage absent')
        require(all(features[key].strip() == 'yes' for key in ['network/af_unix', 'domain/change_onexec', 'domain/change_profile']) and
                {'read', 'trace'} <= set(features['ptrace/mask'].split()) and
                {'read', 'write', 'exec', 'lock'} <= set(features['file/mask'].split()) and
                'userns_create' in features['namespaces/mask'].split(), 'required kernel mediation disabled')
        perf = int(self.read('/proc/sys/kernel/perf_event_paranoid', 32).strip())
        require(perf >= 3, 'unprivileged perf access must be disabled')
        revision = self.read(AA / '.revision', 64).strip()
        require(re.fullmatch(b'[0-9]+', revision) is not None, 'kernel policy revision unavailable')
        records = {}
        for role, entry in self.policy['lsm'].items():
            path = Path(entry['profileDirectory'])
            require(str(path).startswith(str(AA / 'policy/profiles') + '/') and path.resolve(strict=True) == path, 'kernel profile directory differs')
            require(self.read(path / 'name', 256).strip().decode() == LABELS[role] and
                    self.read(path / 'mode', 32).strip() == b'enforce' and
                    self.read(path / 'sha256', 128).strip().decode() == entry['profileSha256'], 'live profile name/mode/hash differs')
            exported = (path / 'raw_data').resolve(strict=True)
            require(str(exported).startswith(str(AA / 'policy/raw_data') + '/'), 'kernel raw policy export escaped namespace')
            binary = self.read(exported, 4 * MAX)
            require(len(binary) == entry['compiled']['bytes'] and hashlib.sha256(binary).hexdigest() == entry['compiled']['sha256'], 'live kernel compiled policy differs from independently admitted bytes')
            records[role] = {'profile': LABELS[role], 'profileSha256': entry['profileSha256'],
                'compiledSha256': entry['compiled']['sha256'], 'sourceSha256': entry['source']['sha256'], 'abiSha256': entry['abi']['sha256']}
        require(self.read(AA / '.revision', 64).strip() == revision, 'LSM policy changed during observation')
        return {'revision': revision.decode(), 'profiles': records, 'featuresSha256': self.p.digest(features), 'perfEventParanoid': perf}

    def show_units(self, names):
        require(1 <= len(names) <= 67 and len(set(names)) == len(names) and
                all(type(name) is str and re.fullmatch('[a-zA-Z0-9_.@:-]+\\.(service|socket|timer|path)', name) for name in names), 'bounded exact maintenance units')
        fields = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'UnitFileState',
                  'FragmentPath', 'DropInPaths', 'AppArmorProfile', 'Delegate', 'ExecMainStartTimestampMonotonic']
        fd = self.held['systemctl']
        child = subprocess.Popen(['/usr/bin/systemctl', 'show', '--no-pager', '--property=' + ','.join(fields), '--', *names],
            executable='/proc/self/fd/' + str(fd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, close_fds=True, pass_fds=(fd,), env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        data = bytearray()
        try:
            os.set_blocking(child.stdout.fileno(), False)
            while True:
                self.budget()
                ready = select.select([child.stdout], [], [], min(0.05, max(0, (self.end - time.monotonic_ns()) / 1e9)))[0]
                if not ready:
                    continue
                chunk = os.read(child.stdout.fileno(), min(65536, 131073 - len(data)))
                if not chunk:
                    break
                data.extend(chunk); require(len(data) <= 131072, 'PID1 policy observation size')
            self.budget()
            require(child.wait(timeout=max(0.001, (self.end - time.monotonic_ns()) / 1e9)) == 0, 'PID1 policy observation failed')
        finally:
            if child.poll() is None:
                child.kill()
                # A cleanup timeout is unresolved; never a success observation.
                child.wait(timeout=0.1)
            child.stdout.close()
        result = {}
        for paragraph in data.decode().strip().split('\n\n'):
            item = {}
            for line in paragraph.splitlines():
                key, sep, value = line.partition('=')
                require(sep and key not in item, 'ambiguous PID1 properties')
                item[key] = value
            require(set(item) == set(fields) and item['Id'] not in result, 'incomplete PID1 properties')
            result[item['Id']] = item
        require(set(result) == set(names), 'PID1 unit aliases/unexpected units')
        self.budget()
        return result

    def process(self, pid, role, expected_start, executable_fd, cgroup):
        self.p.integer(pid, 1, 2**31 - 1)
        proc = Path('/proc', str(pid))
        before = self.proc_start(pid)
        require(before == expected_start and self.read(proc / 'attr/current', 256).decode().strip() == LABELS[role] + ' (enforce)', 'actor incarnation/profile differs')
        require(self.read(proc / 'cgroup', 4096).decode() == '0::' + cgroup + '\n', 'actor cgroup differs')
        actual, expected = (proc / 'exe').stat(), os.fstat(executable_fd)
        require((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), 'actor executable pin differs')
        if role not in ('daemon', 'containerd', 'native'):
            require((proc / 'ns/mnt').stat().st_ino == Path('/proc/self/ns/mnt').stat().st_ino, 'unapproved actor mount namespace')
        status = dict(line.split(':', 1) for line in self.read(proc / 'status').decode().splitlines() if ':' in line)
        if role in ('supervisor', 'worker', 'broker'):
            require(status['NoNewPrivs'].strip() == '1' and all(int(status[k].strip(), 16) == 0 for k in ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']), 'untrusted actor privileges')
        if role == 'worker':
            require(all(int(n) == self.g.policy['worker']['uid'] for n in status['Uid'].split()) and
                    status['Groups'].strip() == '' and (proc / 'ns/net').stat().st_ino != Path('/proc/self/ns/net').stat().st_ino, 'worker UID/group/network differs')
        require(self.proc_start(pid) == before, 'actor replaced during observation')
        return {'pid': pid, 'starttime': before, 'role': role, 'cgroup': cgroup,
                'exeDevice': str(actual.st_dev), 'exeInode': str(actual.st_ino)}

    def kcmp(self, pid, remote, local):
        require(os.uname().machine == 'x86_64', 'physical OFD proof architecture unsupported')
        libc = ctypes.CDLL(None, use_errno=True)
        return libc.syscall(ctypes.c_long(312), ctypes.c_int(os.getpid()), ctypes.c_int(pid),
                            ctypes.c_int(0), ctypes.c_ulong(local), ctypes.c_ulong(remote)) == 0

    def actor_descriptors(self, pid, control_fd):
        entries = list(Path('/proc', str(pid), 'fd').iterdir())
        require(len(entries) <= 128, 'actor descriptor census bound')
        locks = []
        for path in entries:
            info = path.stat()
            if stat.S_ISSOCK(info.st_mode):
                require(self.kcmp(pid, int(path.name), control_fd), 'actor inherited/opened a foreign IPC descriptor')
            lock = os.fstat(self.g.lock_fd)
            if (info.st_dev, info.st_ino) == (lock.st_dev, lock.st_ino):
                require(self.kcmp(pid, int(path.name), self.g.lock_fd), 'actor lock inode is not original OFD')
                locks.append(int(path.name))
        require(locks, 'actor does not hold original deployment OFD')
        return {'pid': pid, 'originalLockFds': sorted(locks), 'socketFdsAllRegistered': True}

    def engines(self, units):
        observed = {}
        for role, entry in self.policy['engines'].items():
            actual_birth = self.native_snapshot['identity']['engines'][role]
            unit = units[entry['unit']]
            require(unit['LoadState'] == 'loaded' and unit['ActiveState'] == 'active' and unit['SubState'] == 'running' and
                    unit['MainPID'] == str(actual_birth['pid']) and unit['ControlGroup'] == entry['cgroup'] and
                    unit['AppArmorProfile'] == 'lunchlineup-development-engine-launcher' and unit['Delegate'] == 'no' and
                    unit['FragmentPath'] == entry['unitFile']['path'] and
                    unit['DropInPaths'].split() == [pin['path'] for pin in entry['dropIns']], 'engine PID1/config custody differs')
            require(entry['unit'] == ('lunchlineup-development-docker.service' if role == 'daemon' else
                    'lunchlineup-development-containerd.service'), 'fresh engine fixed service differs')
            observed[role] = self.process(actual_birth['pid'], role, actual_birth['starttime'], self.held[role + ':executable'], entry['cgroup'])
            require(self.read(Path('/proc', str(actual_birth['pid']), 'cmdline'), 16384) == b'\0'.join(arg.encode() for arg in entry['argv']) + b'\0', 'engine argv differs')
            # Configuration pathname must still be the pinned immutable inode.
            current, admitted = Path(entry['config']['path']).stat(), os.fstat(self.held[role + ':config'])
            require((current.st_dev, current.st_ino) == (admitted.st_dev, admitted.st_ino), 'engine config replaced')
            tcp = set()
            for name in ['tcp', 'tcp6', 'udp', 'udp6']:
                rows = self.read(Path('/proc', str(actual_birth['pid']), 'net', name), MAX).decode().splitlines()[1:]
                for row in rows:
                    parts = row.split(); require(len(parts) >= 10, 'engine IP endpoint census grammar')
                    tcp.add(parts[9])
            descriptors = list(Path('/proc', str(actual_birth['pid']), 'fd').iterdir())
            require(len(descriptors) <= 512, 'engine FD census bound')
            for path in descriptors:
                target = os.readlink(path)
                if target.startswith('socket:['):
                    require(target[8:-1] not in tcp, 'engine has a TCP/UDP endpoint')
        return observed

    def engine_get(self, path):
        require(path in ('/info', '/containers/json?all=1') or re.fullmatch('/containers/[a-f0-9]{64}/json', path), 'non-readonly engine endpoint')
        self.budget()
        native = self.g.native
        native.physical_command += 1
        handle = native.register(kind='physical', command=native.physical_command, worker_nonce=None,
                                 args=None, path=path, deadline=self.end)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as endpoint:
            endpoint.settimeout(max(0.001, (self.end - time.monotonic_ns()) / 1e9))
            endpoint.connect('/run/lunchlineup/engine-custody/client.sock')
            require(struct.unpack('3i', endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) ==
                    (native.pid, 0, 0) and endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 4096).rstrip(b'\0').decode() ==
                    'lunchlineup-development-engine-custodian (enforce)', 'physical finite proxy peer differs')
            endpoint.sendall(('GET ' + path + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n' +
                'X-Lunchlineup-Read-Token: ' + handle['token'] + '\r\n\r\n').encode())
            data = bytearray()
            while True:
                self.budget()
                endpoint.settimeout(max(0.001, (self.end - time.monotonic_ns()) / 1e9))
                block = endpoint.recv(min(65536, MAX + 16385 - len(data)))
                if not block: break
                data.extend(block); require(len(data) <= MAX + 16384, 'physical finite response bound')
        header, sep, body = bytes(data).partition(b'\r\n\r\n')
        require(sep and len(header) <= 16384 and len(body) < MAX, 'physical proxy response framing')
        lines = header.split(b'\r\n'); require(lines[0] == b'HTTP/1.1 200 OK', 'physical proxy response status')
        fields = {}
        for line in lines[1:]:
            key, separator, value = line.partition(b':'); key = key.lower()
            require(separator and key not in fields, 'physical proxy duplicate header'); fields[key] = value.strip()
        require(b'transfer-encoding' not in fields and fields.get(b'content-length') == str(len(body)).encode(), 'physical proxy complete response length')
        receipt = native.close_read(handle, self.end)
        primary = [row for row in receipt['records'] if row['target'][0] not in ('ping', 'version')]
        require(len(primary) == 1 and primary[0]['responseBytes'] == len(body) and
                primary[0]['responseBodySha256'] == hashlib.sha256(body).hexdigest(), 'physical body differs from actual complete daemon response')
        self.api_bytes += len(data); require(self.api_bytes <= 4 * MAX, 'physical aggregate response bound')
        self.budget()
        def pairs(items):
            result = {}
            for key, value in items:
                require(key not in result, 'duplicate physical JSON key'); result[key] = value
            return result
        return json.loads(body, object_pairs_hook=pairs)

    def retained_state(self):
        info = self.engine_get('/info')
        binding = self.g.policy['candidate']['inventoryBinding']
        require(info['ID'] == binding['daemonId'] and info['DockerRootDir'] == binding['dockerRootDir'] == self.policy['store']['path'] and
                info['ServerVersion'] == binding['serverVersion'] and type(info['ContainersRunning']) is int and info['ContainersRunning'] == 0,
                'daemon/store identity differs or persistent workload running')
        containers = self.engine_get('/containers/json?all=1')
        require(type(containers) is list and len(containers) <= self.policy['containerLimit'], 'retained container bound')
        records = []
        for entry in containers:
            identity = entry.get('Id'); require(type(identity) is str and re.fullmatch('[a-f0-9]{64}', identity), 'retained identity')
            item = self.engine_get('/containers/' + identity + '/json')
            require(item['Id'] == identity and item['State']['Running'] is False and item['State']['Restarting'] is False and
                    item['HostConfig']['RestartPolicy']['Name'] in ('no', '') and item['HostConfig']['AutoRemove'] is False,
                    'retained automatic writer/workload policy enabled')
            # Retained configurations are not rewritten. Unsafe configurations
            # require separately approved owner handling; collector only refuses.
            hc = item['HostConfig']
            require(hc['Privileged'] is False and not hc.get('CapAdd') and not hc.get('Devices') and
                    hc.get('PidMode', '') != 'host' and hc.get('NetworkMode', '') != 'host' and
                    not any(m.get('Type') == 'bind' for m in item['Mounts']), 'retained raw host access configuration')
            records.append({'containerId': identity, 'stopped': True, 'restartPolicy': 'no', 'rawHostAccess': False})
        return records

    def root_census(self, owned):
        expected = {}
        for entry in self.policy['trustedRootProcesses']:
            self.p.closed(entry, ['pid', 'starttime', 'cgroup', 'executable', 'purpose'])
            require(type(entry['purpose']) is str and 1 <= len(entry['purpose']) <= 256, 'trusted root purpose required')
            require(entry['pid'] not in expected and entry['pid'] not in owned, 'duplicate trusted process ownership')
            expected[entry['pid']] = entry
        seen = set(); records = []
        paths = [path for path in Path('/proc').iterdir() if path.name.isascii() and path.name.isdigit()]
        require(len(paths) <= 4096, 'process census bound')
        for path in paths:
            self.budget()
            pid = int(path.name)
            status = dict(line.split(':', 1) for line in self.read(path / 'status').decode().splitlines() if ':' in line)
            label = self.read(path / 'attr/current', 256).decode().strip()
            require(not label.startswith(tuple(LABELS.values())) or pid in owned, 'foreign process adopted privileged control profile')
            if 0 not in [int(n) for n in status['Uid'].split()] or pid in owned:
                continue
            # Kernel threads have no userspace mm/executable; require explicit
            # kernel-thread flag from proc status, never a failed exe read guess.
            if status.get('Kthread', '').strip() == '1':
                continue
            entry = expected.get(pid)
            require(entry is not None and self.proc_start(pid) == entry['starttime'] and
                    self.read(path / 'cgroup', 4096).decode() == '0::' + entry['cgroup'] + '\n', 'unregistered trusted root actor')
            fd = self.root_pins[self.p.digest(entry['executable'])]
            a, b = (path / 'exe').stat(), os.fstat(fd)
            require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino), 'trusted root executable changed')
            seen.add(pid); records.append({'pid': pid, 'starttime': entry['starttime'], 'cgroup': entry['cgroup']})
        require(seen == set(expected), 'trusted root inventory changed')
        return sorted(records, key=lambda row: row['pid'])

    def persist(self, kind, body):
        self.budget()
        raw = self.p.canonical({'kind': kind, 'localSessionId': self.g.local_id,
            'requestSha256': self.g.request['requestSha256'], 'guardianSessionId': self.g.epoch['guardianSessionId'],
            'observedNs': str(time.monotonic_ns()), 'body': body})
        require(len(raw) <= 16384 and self.sequence < 1200 and self.proof_bytes + len(raw) <= 32 * MAX, 'private physical proof budget')
        actual_dir, held_dir = self.proof_dir.stat(), os.fstat(self.proof_dir_fd)
        require((actual_dir.st_dev, actual_dir.st_ino) == (held_dir.st_dev, held_dir.st_ino), 'physical evidence directory replaced')
        name = self.g.local_id + '.physical.' + str(self.sequence) + '.' + kind + '.json'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.proof_dir_fd)
        try:
            self.write_all(fd, raw); os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self.proof_dir_fd)
        self.sequence += 1; self.proof_bytes += len(raw)
        self.budget()
        return {'path': str(self.proof_dir / name), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}

    def collect(self, original_challenge_ns):
        g, q = self.g, self.policy
        self.require_prior_clients_excluded()
        start = time.monotonic_ns()
        self.api_bytes = 0
        self.p.integer(original_challenge_ns, 0, start)
        # Charge the caller's original challenge, not a fresh allowance after IO.
        self.end = min(original_challenge_ns + 2_500_000_000, g.original_deadline, self.owner_deadline)
        if g.lease is not None:
            self.end = min(self.end, g.lease.overall_ns, g.lease.expiry_ns if g.lease.state == 'BOUND' else g.lease.sent_ns + 5_000_000_000)
        self.budget()
        self.native_snapshot = g.native.snapshot(self.end)
        require(self.native_snapshot['readState']['unknownRequests'] == 0 and
                self.native_snapshot['readState']['mutationRequestsDispatched'] == 0, 'native current request state unresolved')
        require(self.read('/proc/sys/kernel/random/boot_id', 64).decode().strip() == g.boot and
                self.read('/etc/machine-id', 64).decode().strip() == q['machineId'], 'physical target changed')
        lsm = self.kernel_policy()
        guardian_pid1 = g.modules['connection'].unit_snapshot(g.policy['installation']['execStopPost'], self.held['systemctl'])
        self.budget()
        require(guardian_pid1['MainPID'] == os.getpid(), 'guardian PID1 identity changed')
        actors = [self.process(os.getpid(), 'guardian', self.proc_start(os.getpid()), g.fds['interpreter'], '/system.slice/lunchlineup-development-guardian.service')]
        for role in ['guardian', 'interpreter', 'finalizer', 'unitFile']:
            pin = g.policy['installation'][role]
            a, b = Path(pin['path']).stat(), os.fstat(g.fds[role])
            require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino), 'guardian installation pathname changed')
        a, b = os.fstat(4), os.fstat(g.fds['guardian'])
        require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino), 'guardian FD4 changed')
        descriptor_proofs = []
        # KPT163 keeps the exact supervisor and its descriptors through host
        # clear/retirement. Local deployment unlock does not change ownership.
        # Collection is unavailable during descriptor closure/reap; that phase
        # is observed only by the exact guardian Popen child poll/reap protocol.
        require(g.retirement is None, 'normal physical collection after retirement requires separate recovery custodian')
        g.supervisor_identity()
        actors.append(self.process(g.child.pid, 'supervisor', g.child_start, g.fds['interpreter'], '/system.slice/lunchlineup-development-guardian.service'))
        descriptor_proofs.append(self.actor_descriptors(g.child.pid, g.child_control_fd))
        require(self.kcmp(g.child.pid, g.supervisor_lock_fd, g.lock_fd), 'current adopted supervisor OFD differs')
        if g.local_release is None:
            g.modules['connection'].require_guardian_flock(os.getpid(), g.lock_fd)
        else:
            g.require_lock_absent()
        for slot, policy in [(g.worker.slot, g.policy['workerCgroup'])] if g.worker is not None else []:
            for name, expected in [('memory.max', str(policy['memoryMax'])), ('pids.max', str(policy['pidsMax'])), ('cpu.max', policy['cpuMax']), ('io.max', policy['ioMax'])]:
                require(self.read(slot.path / name, 4096).decode().strip() == expected.strip(), 'worker current resource limit changed')
        if g.broker is not None:
            policy = g.policy['brokerCgroup']
            for name, expected in [('memory.max', str(policy['memoryMax'])), ('pids.max', str(policy['pidsMax'])), ('cpu.max', policy['cpuMax']), ('io.max', policy['ioMax'])]:
                require(self.read(g.broker.slot.path / name, 4096).decode().strip() == expected.strip(), 'broker current resource limit changed')
        if g.worker is not None:
            require(g.worker.state in ('RUNNING', 'RESULT_PENDING', 'RESULT'), 'worker physical identity not yet admitted/settled')
            g.worker._identity()
            actors.append(self.process(g.worker.process.pid, 'worker', g.worker.starttime, g.fds['interpreter'], str(g.worker.slot.path)[len('/sys/fs/cgroup'):]))
            descriptor_proofs.append(self.actor_descriptors(g.worker.process.pid, g.worker.child_endpoint.fileno()))
        if g.broker is not None and g.broker.process is not None:
            require(g.broker.state == 'RUNNING', 'broker physical state unresolved')
            actors.append(self.process(g.broker.process.pid, 'broker', g.broker.starttime, g.fds['docker'], str(g.broker.slot.path)[len('/sys/fs/cgroup'):]))
        names = [entry['unit'] for entry in q['engines'].values()] + [entry['unit'] for entry in q['maintenance']]
        units = self.show_units(names)
        maintenance = {}
        for entry in q['maintenance']:
            self.p.closed(entry, ['unit', 'reason', 'category'])
            require(entry['category'] in ('autoheal', 'scheduler', 'backup', 'ci', 'lifecycle'), 'maintenance category unknown')
            require(type(entry['reason']) is str and 1 <= len(entry['reason']) <= 256, 'maintenance scope reason')
            value = units[entry['unit']]
            require(value['LoadState'] == 'masked' and value['UnitFileState'] == 'masked' and value['ActiveState'] == 'inactive' and value['MainPID'] == '0', 'competing service/timer/CI writer not excluded')
            mask = Path('/etc/systemd/system') / entry['unit']
            require(mask.is_symlink() and os.readlink(mask) == '/dev/null' and mask.lstat().st_uid == 0, 'persistent maintenance mask absent')
            maintenance[entry['unit']] = {'masked': True, 'inactive': True}
        require({entry['category'] for entry in q['maintenance']} == {'autoheal', 'scheduler', 'backup', 'ci', 'lifecycle'}, 'complete maintenance categories required')
        engine = self.engines(units)
        socket_path = self.native_snapshot['identity']['sockets']['docker.sock']['path']
        socket_stat = Path(socket_path).lstat()
        require(stat.S_ISSOCK(socket_stat.st_mode) and socket_stat.st_uid == socket_stat.st_gid == 0 and
                (str(socket_stat.st_dev), str(socket_stat.st_ino)) ==
                (self.native_snapshot['identity']['sockets']['docker.sock']['device'], self.native_snapshot['identity']['sockets']['docker.sock']['inode']),
                'actual native fresh daemon socket differs')
        self.p.closed(q['store'], ['path', 'device', 'inode'])
        store = Path(q['store']['path']); info = store.lstat()
        require(store.resolve(strict=True) == store and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077 and
                (info.st_dev, info.st_ino) == (q['store']['device'], q['store']['inode']), 'daemon backing/store custody differs')
        self.p.closed(q['runtimeSocket'], ['path'])
        require(q['runtimeSocket']['path'] == self.native_snapshot['identity']['sockets']['containerd.sock']['path'],
                'native alternate runtime route differs')
        require(q['runtimeDirectories'] == ['/run/lunchlineup/engine-custody', '/run/lunchlineup/engine-custody/raw'],
                'fixed native private runtime parents required')
        for key in ['root', 'raw']:
            directory = self.native_snapshot['identity'][key]
            path = Path(directory['path']); self.directory_custody(path, private=True); info = path.stat()
            require((str(info.st_dev), str(info.st_ino)) == (directory['device'], directory['inode']), 'native private parent replaced')
        if self.native_snapshot['readState']['pendingRequests'] == 0:
            retained = self.retained_state()
            if self.retained_cache is not None:
                require(retained == self.retained_cache, 'retained state changed under read-only custody')
            self.retained_cache = retained
        else:
            # A live bounded inventory GET may overlap a renewal observation.
            # No second daemon read is dispatched. Initial actual retained state
            # remains protected by unchanged fresh engine + deny-all-write route.
            require(self.retained_cache is not None and g.broker is not None and g.native_broker_handle is not None and
                    self.native_snapshot['readState']['activeRequestHandles'] ==
                    [g.native_broker_handle['registeredRecordSha256']], 'pending native read is not the registered current broker')
            retained = self.retained_cache
        owner_before = os.fstat(self.owner_fd)
        require(owner_before.st_uid == 0 and stat.S_IMODE(owner_before.st_mode) == 0o600, 'writer registry lost private custody')
        require(self.owner_path.stat().st_ino == owner_before.st_ino and self.owner_path.stat().st_dev == owner_before.st_dev and
                self.read(self.owner_path) == self.owner_bytes, 'writer owner registry replaced')
        g.modules['connection'].require_guardian_flock(os.getpid(), self.owner_fd)
        fence_path = Path(g.policy['journalDirectory']) / 'active.fence'
        actual, held = fence_path.stat(), os.fstat(g.fence_fd)
        require((actual.st_dev, actual.st_ino) == (held.st_dev, held.st_ino) and
                hashlib.sha256(self.read(fence_path)).hexdigest() == g.fence_sha, 'request fence identity/content changed')
        # The fence FD is write-only in the existing guardian: compare its inode
        # and previously committed content hash, not a caller-authored flag.
        native_process = self.native_snapshot['identity']['nativeProcess']
        actors.append(self.process(native_process['pid'], 'native', native_process['starttime'], g.native.fds['interpreter'], native_process['cgroup']))
        owned = {row['pid'] for row in actors} | {row['pid'] for row in engine.values()}
        if g.host is not None:
            require(g.host.poll() is None, 'host channel process lost')
            actors.append(self.process(g.host.pid, 'guardian', g.host_start, g.fds['ssh'], '/system.slice/lunchlineup-development-guardian.service'))
            owned.add(g.host.pid)
        roots = self.root_census(owned)
        require(self.kernel_policy() == lsm, 'kernel confinement replaced during collection')
        require(self.root_census(owned) == roots and self.show_units(names) == units, 'ownership/maintenance changed during collection')
        require(Path(socket_path).lstat() == socket_stat, 'daemon socket changed during collection')
        require(g.native.snapshot(self.end)['identity'] == self.native_snapshot['identity'], 'native engine custody changed during collection')
        self.budget()
        lock_info = os.fstat(g.lock_fd)
        current_lock = Path('/run/lock/lunchlineup-deploy.lock').lstat()
        require(stat.S_ISREG(current_lock.st_mode) and current_lock.st_uid == 0 and not current_lock.st_mode & 0o022 and
                (current_lock.st_dev, current_lock.st_ino) == (lock_info.st_dev, lock_info.st_ino), 'original deployment lock pathname replaced')
        lock_proof = self.persist('ofd', {'guardianPid': os.getpid(), 'guardianStarttime': actors[0]['starttime'],
            'device': str(lock_info.st_dev), 'inode': str(lock_info.st_ino), 'held': g.local_release is None,
            'descriptorProofs': descriptor_proofs})
        confinement = self.persist('confinement', {'kernel': lsm, 'actors': actors, 'engines': engine,
            'guardianPid1': {key: str(value) for key, value in guardian_pid1.items()},
            'engineUnits': {role: units[entry['unit']] for role, entry in q['engines'].items()},
            'daemonSocketDevice': str(socket_stat.st_dev), 'daemonSocketInode': str(socket_stat.st_ino),
            'runtimeSocket': q['runtimeSocket'], 'store': q['store'],
            'nativeIdentitySha256': self.native_snapshot['identitySha256'], 'nativeBirthRecordSha256': self.native_snapshot['birthRecordSha256']})
        writers = self.persist('writers', {'authorizationSha256': q['ownerAuthorization']['sha256'],
            'ownerRegistrySha256': hashlib.sha256(self.owner_bytes).hexdigest(), 'maintenance': maintenance,
            'trustedRootActors': roots, 'retainedContainers': retained})
        receipt = {'guardianPid': os.getpid(), 'daemonPid': engine['daemon']['pid'], 'guardianStarttime': actors[0]['starttime'],
            'lockDevice': str(lock_info.st_dev), 'lockInode': str(lock_info.st_ino), 'daemonStarttime': engine['daemon']['starttime'],
            'daemonSocketDevice': str(socket_stat.st_dev), 'daemonSocketInode': str(socket_stat.st_ino),
            'guardianCgroup': actors[0]['cgroup'], 'guardianUnitSha256': g.a['roles']['unitFile']['sha256'],
            'lockOfdSha256': lock_proof['sha256'], 'daemonExeSha256': q['engines']['daemon']['executable']['sha256'],
            'daemonConfigSha256': q['engines']['daemon']['config']['sha256'], 'confinementReceiptSha256': confinement['sha256'],
            'writerPolicyReceiptSha256': writers['sha256']}
        require(len(self.p.canonical(receipt)) <= 16384, 'physical receipt wire bound')
        g.journal.append('PHYSICAL_EVIDENCE', {'receipt': receipt, 'proofs': [lock_proof, confinement, writers], 'collectionStartedNs': str(start)})
        self.budget()
        return receipt


if __name__ == '__main__':
    raise SystemExit('Physical custody collector is guardian-private; no CLI or mutation.')
