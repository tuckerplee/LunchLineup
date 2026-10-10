#!/usr/bin/env python3
"""Private fixed native-engine custody observations shared by owner/launcher.

No start/stop or recovery override in this module. All values are independently
pinned installation inputs or actual bounded kernel/PID1/file observations.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import time
import tomllib

MAX = 1048576
ROOT = '/run/lunchlineup/engine-custody'
RAW = ROOT + '/raw'
UNITS = {'native': 'lunchlineup-development-engines.service',
         'daemon': 'lunchlineup-development-docker.service',
         'containerd': 'lunchlineup-development-containerd.service',
         'guardian': 'lunchlineup-development-guardian.service',
         'recovery': 'lunchlineup-development-recovery.service'}
OLD = ('docker.service', 'docker.socket', 'containerd.service')
FIELDS = ('Id', 'MainPID', 'LoadState', 'ActiveState', 'SubState', 'ControlGroup', 'FragmentPath', 'DropInPaths',
          'AppArmorProfile', 'Delegate', 'PrivateNetwork', 'JoinsNamespaceOf', 'Restart', 'KillMode', 'Type',
          'NotifyAccess', 'WatchdogUSec', 'RuntimeMaxUSec', 'TimeoutStopUSec', 'ExecStart', 'ExecStopPost',
          'ActiveEnterTimestampMonotonic', 'ExecMainStartTimestampMonotonic', 'Job', 'BindsTo')


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def read(path, limit=MAX):
    with open(path, 'rb') as source:
        value = source.read(limit + 1)
    require(len(value) <= limit, 'native observation bound')
    return value


def starttime(pid):
    value = read(Path('/proc', str(pid), 'stat'), 8192).decode()
    return value[value.rfind(')') + 2:].split()[19]


def private_directory(path):
    path = Path(path)
    require(path.resolve(strict=True) == path, 'native private directory canonical identity')
    for item in [path, *path.parents]:
        info = item.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'native directory parent custody')
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
            stat.S_IMODE(info.st_mode) == 0o700, 'native directory privacy')
    return {'path': str(path), 'device': str(info.st_dev), 'inode': str(info.st_ino), 'mode': 0o700}


def pinned_process(pid, expected_start, entry_fd, profile, cgroup):
    proc = Path('/proc', str(pid))
    require(starttime(pid) == expected_start and read(proc / 'attr/current', 256).decode().strip() == profile + ' (enforce)' and
            read(proc / 'cgroup', 4096).decode() == '0::' + cgroup + '\n', 'native process incarnation/profile/cgroup')
    actual, pinned = (proc / 'exe').stat(), os.fstat(entry_fd)
    require((actual.st_dev, actual.st_ino) == (pinned.st_dev, pinned.st_ino), 'native process executable inode')
    require(starttime(pid) == expected_start, 'native process changed during observation')
    return {'pid': pid, 'starttime': expected_start, 'cgroup': cgroup, 'profile': profile,
            'executableDevice': str(actual.st_dev), 'executableInode': str(actual.st_ino),
            'networkNamespaceInode': str((proc / 'ns/net').stat().st_ino)}


def unit_views(systemctl_fd, names, deadline, fields=FIELDS):
    require(type(names) is list and names and len(names) <= 8 and len(set(names)) == len(names) and
            set(names) <= set(UNITS.values()) | set(OLD), 'fixed native unit observation only')
    require(type(fields) is tuple and set(fields) <= set(FIELDS) and 'Id' in fields, 'fixed unit field projection')
    args = ['/usr/bin/systemctl', 'show', '--all', '--no-pager', '--property=' + ','.join(fields), '--', *names]
    child = subprocess.Popen(args, executable='/proc/self/fd/' + str(systemctl_fd), pass_fds=(systemctl_fd,),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, cwd='/', close_fds=True)
    output = bytearray()
    try:
        os.set_blocking(child.stdout.fileno(), False)
        while True:
            left = deadline - time.monotonic_ns()
            require(left > 0 and select.select([child.stdout], [], [], left / 1000000000)[0], 'native PID1 observation timeout')
            data = os.read(child.stdout.fileno(), min(65536, 131073 - len(output)))
            if not data:
                break
            output.extend(data)
            require(len(output) <= 131072, 'native PID1 output bound')
        require(child.wait(timeout=max(0.001, (deadline - time.monotonic_ns()) / 1000000000)) == 0,
                'native PID1 observation failed')
    finally:
        if child.poll() is None:
            child.kill(); child.wait(timeout=1)
        child.stdout.close()
    result = {}
    for block in bytes(output).decode().strip().split('\n\n'):
        value = {}
        for line in block.splitlines():
            key, sep, item = line.partition('=')
            require(sep and key not in value, 'ambiguous native PID1 field')
            value[key] = item
        require(set(value) == set(fields) and value['Id'] not in result, 'incomplete native PID1 unit')
        result[value['Id']] = value
    require(set(result) == set(names), 'native PID1 unit aliases/selection differs')
    require(time.monotonic_ns() < deadline, 'native PID1 persistence/identity deadline')
    return result


def cgroup_empty(path):
    path = Path(path)
    if not path.exists():
        return True
    require(path.resolve(strict=True) == path and str(path).startswith('/sys/fs/cgroup/'), 'native cgroup canonical path')
    visited = 0
    for root, dirs, files in os.walk(path, followlinks=False):
        visited += 1
        require(visited <= 256 and not any(Path(root, name).is_symlink() for name in dirs), 'native recursive cgroup bound/link')
        values = dict(line.split() for line in read(Path(root, 'cgroup.events'), 4096).decode().splitlines())
        if values.get('populated') != '0' or read(Path(root, 'cgroup.procs'), 65536).strip():
            return False
    return True


def old_units_stopped(systemctl_fd, deadline):
    common = ('Id', 'LoadState', 'ActiveState', 'SubState', 'ControlGroup', 'FragmentPath', 'DropInPaths', 'Job')
    view = unit_views(systemctl_fd, ['docker.service', 'containerd.service'], deadline, common + ('MainPID',))
    view.update(unit_views(systemctl_fd, ['docker.socket'], deadline, common))
    for name, fields in view.items():
        mask = Path('/etc/systemd/system', name)
        require(mask.is_symlink() and os.readlink(mask) == '/dev/null' and mask.lstat().st_uid == 0 and
                fields['LoadState'] == 'masked' and fields.get('MainPID', '0') == '0' and fields['ActiveState'] in ('inactive', 'failed') and
                fields['Job'] == '', 'old engine/socket unit not persistently excluded or has pending job')
        if fields['ControlGroup']:
            require(cgroup_empty('/sys/fs/cgroup' + fields['ControlGroup']), 'old engine cgroup still populated')
    return view


def finite_limits(p, path, values):
    p.closed(values, ['memoryMax', 'pidsMax', 'cpuMax', 'ioMax'])
    p.integer(values['memoryMax'], 64 * MAX, 4 * 1024**3)
    p.integer(values['pidsMax'], 4, 256)
    require(type(values['cpuMax']) is str and re.fullmatch('[1-9][0-9]{0,7} [1-9][0-9]{0,6}', values['cpuMax']), 'finite native CPU policy')
    require(type(values['ioMax']) is str and 0 < len(values['ioMax']) <= 4096 and 'max' not in values['ioMax'], 'finite native IO policy')
    for name, wanted in [('memory.max', str(values['memoryMax'])), ('pids.max', str(values['pidsMax'])),
                         ('cpu.max', values['cpuMax']), ('io.max', values['ioMax'])]:
        require(read(Path(path, name), 4096).decode().strip() == wanted.strip(), 'actual native resource control differs')


def validate_configs(p, policy, daemon_bytes, runtime_bytes, plugin_spec):
    docker = p.parse(daemon_bytes)
    wanted = {'data-root': policy['stores']['daemon']['path'], 'exec-root': RAW + '/docker-exec', 'pidfile': RAW + '/docker.pid',
        'hosts': ['unix://' + RAW + '/docker.sock'], 'containerd': RAW + '/containerd.sock',
        'authorization-plugins': ['lunchlineup-readonly'], 'group': 'root', 'bridge': 'none',
        'iptables': False, 'ip6tables': False, 'ip-forward': False, 'ip-masq': False,
        'live-restore': False, 'storage-driver': policy['storageDriver'], 'builder': {'gc': {'enabled': False}}}
    require(policy['storageDriver'] in ('overlay2', 'vfs') and docker == wanted, 'closed inspection-only daemon configuration differs')
    runtime = tomllib.loads(runtime_bytes.decode())
    expected = {'version': 2, 'root': policy['stores']['containerd']['path'], 'state': RAW + '/containerd-state',
        'disabled_plugins': ['io.containerd.grpc.v1.cri', 'io.containerd.gc.v1.scheduler'],
        'grpc': {'address': RAW + '/containerd.sock', 'uid': 0, 'gid': 0},
        'ttrpc': {'address': RAW + '/containerd.sock.ttrpc', 'uid': 0, 'gid': 0},
        'metrics': {'address': ''}}
    require(runtime == expected, 'closed native runtime configuration differs; no imports/TCP/default listener fallback')
    require(plugin_spec == ('unix://' + ROOT + '/plugin.sock\n').encode(), 'fixed AuthZ plugin discovery endpoint differs')
    # Exact pinned engine versions/config support must be qualified separately.
    # Disabling a required plugin may refuse startup; never silently remove this
    # restriction or allow automatic GC/config migration to obtain a green check.


def retained_store_check(p, policy, installation):
    records = []
    for role, entry in policy['stores'].items():
        p.closed(entry, ['path', 'device', 'inode'])
        observed = private_directory(entry['path'])
        require(observed['device'] == str(entry['device']) and observed['inode'] == str(entry['inode']), 'native retained store inode differs')
    root = Path(policy['stores']['daemon']['path'])
    containers = root / 'containers'
    require(containers.resolve(strict=True) == containers, 'retained container directory custody')
    names = list(containers.iterdir())
    require(len(names) <= 128, 'offline retained container inventory bound')
    for entry in sorted(names):
        require(re.fullmatch('[a-f0-9]{64}', entry.name) and entry.is_dir() and not entry.is_symlink(), 'unknown retained container entry')
        values = {}; hashes = {}
        for name in ['hostconfig.json', 'config.v2.json']:
            fd = installation.controlled(entry / name)
            try:
                before = os.fstat(fd); data = os.read(fd, MAX + 1); after = os.fstat(fd)
                require(len(data) <= MAX and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                        (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'retained configuration changed/bound')
                values[name] = installation.parse(data)
                hashes[name] = hashlib.sha256(data).hexdigest()
            finally:
                os.close(fd)
        host, config = values['hostconfig.json'], values['config.v2.json']
        require(config['ID'] == entry.name and all(config['State'].get(key) is False for key in ['Running', 'Paused', 'Restarting']) and
                host['RestartPolicy']['Name'] in ('no', '') and host['AutoRemove'] is False and host['Privileged'] is False and
                not host.get('CapAdd') and not host.get('Devices') and not host.get('DeviceRequests') and not host.get('Binds') and
                host.get('PidMode') != 'host' and host.get('NetworkMode') != 'host' and
                not any(item.get('Type') == 'bind' for item in host.get('Mounts', [])), 'retained workload could restore/run or access raw host')
        records.append({'containerId': entry.name, 'configurationSha256': hashes, 'restartDisabled': True, 'stopped': True})
    plugins = root / 'plugins'
    if plugins.exists():
        for entry in plugins.iterdir():
            require(entry.name in ('tmp', 'storage') and entry.is_dir() and not entry.is_symlink() and not any(entry.iterdir()),
                    'managed plugin restoration not admitted for inspection incarnation')
    return records



PROFILES = {'native': 'lunchlineup-development-engine-custodian',
            'daemon': 'lunchlineup-development-daemon',
            'containerd': 'lunchlineup-development-containerd',
            'guardian': 'lunchlineup-development-guardian',
            'broker': 'lunchlineup-development-broker',
            'recovery': 'lunchlineup-development-recovery',
            'launcher': 'lunchlineup-development-engine-launcher'}


class Settings:
    """Independent fixed installation, actual policy and finite unit constraints."""
    def __init__(self, installation, authority):
        self.i, self.a = installation, authority
        self.fds = {role: installation.pin(pin) for role, pin in authority['roles'].items()}
        self.modules = {role: installation.load_module(role, self.fds[role]) for role in
                        ['protocol', 'authz', 'http', 'history']}
        self.p = self.modules['protocol']
        fd = installation.pin(authority['policy'], True)
        try:
            self.policy = self.p.parse(os.read(fd, MAX + 1))
        finally:
            os.close(fd)
        p, q = self.p, self.policy
        p.closed(q, ['version', 'bootId', 'machineId', 'requestSha256', 'originalDeadlineNs',
                     'approval', 'stores', 'storageDriver', 'configs', 'units', 'lsm', 'kernelFeatures', 'peers'])
        require(type(q['version']) is int and q['version'] == 1 and
                q['bootId'] == read('/proc/sys/kernel/random/boot_id', 128).decode().strip() and
                q['machineId'] == read('/etc/machine-id', 128).decode().strip() == '80a9dfd43bbc6a074cf9148daa5335c2',
                'native target/boot/version differs')
        p.sha(q['requestSha256']); self.deadline = p.local_nanoseconds(q['originalDeadlineNs'])
        p.closed(q['approval'], ['owner', 'reference', 'operation', 'rootWriterRule'])
        require(all(type(q['approval'][key]) is str and 1 <= len(q['approval'][key]) <= 256 for key in ['owner', 'reference']) and
                q['approval']['operation'] == 'fresh-private-readonly-engine-incarnation' and
                q['approval']['rootWriterRule'] == 'only-fixed-native-owner;no-concurrent-root-maintenance',
                'separate explicit fresh-engine deployment approval missing/different')
        require(set(q['stores']) == set(q['configs']) == {'daemon', 'containerd'} and
                set(q['units']) == {'native', 'daemon', 'containerd', 'recovery'} and set(q['lsm']) == set(PROFILES) and
                set(q['peers']) == {'guardian', 'broker', 'recovery'}, 'complete native role inventory')
        for role, pin in q['configs'].items():
            require(pin['path'] == '/etc/lunchlineup/native/' + ('daemon.json' if role == 'daemon' else 'containerd.toml'),
                    'fixed native engine configuration')
            self.fds[role + ':config'] = installation.pin(pin)
        for role, entry in q['lsm'].items():
            p.closed(entry, ['profileDirectory', 'profileSha256', 'compiled', 'source', 'abi'])
            p.sha(entry['profileSha256'])
            for name in ['compiled', 'source', 'abi']:
                require(type(entry[name]['path']) is str and entry[name]['path'].startswith('/etc/lunchlineup/lsm/') and
                        '..' not in entry[name]['path'].split('/'), 'fixed native readable LSM input root')
                self.fds[role + ':' + name] = installation.pin(entry[name], maximum=4 * MAX)
        for role, entry in q['peers'].items():
            p.closed(entry, ['entry', 'executable', 'cgroup'])
            require(entry['cgroup'] == ('/system.slice/' + UNITS[role] if role != 'broker' else
                    '/system.slice/' + UNITS['guardian'] + '/broker'), 'fixed native peer cgroup')
            expected_entry = {'guardian': '/usr/local/libexec/lunchlineup/development-guardian',
                              'recovery': '/usr/local/libexec/lunchlineup/development-engine-recovery',
                              'broker': '/usr/bin/docker'}[role]
            require(entry['entry']['path'] == expected_entry and
                    entry['executable'] == authority['roles']['docker' if role == 'broker' else 'interpreter'],
                    'fixed native peer entry/interpreter role differs')
            for name in ['entry', 'executable']:
                self.fds[role + ':' + name] = installation.pin(entry[name])
        for role, entry in q['units'].items():
            p.closed(entry, ['properties', 'limits'])
            props = entry['properties']
            require(type(props) is dict and set(props) == {'ExecStart', 'ExecStopPost', 'WatchdogUSec',
                    'RuntimeMaxUSec', 'TimeoutStopUSec', 'Type', 'NotifyAccess'}, 'exact admitted PID1 serialization required')
            require(all(type(value) is str and len(value) <= 8192 for value in props.values()), 'native unit property bounds')
            require(props['RuntimeMaxUSec'] == ('20s' if role == 'recovery' else '3min') and
                    props['TimeoutStopUSec'] == '5s' and props['WatchdogUSec'] == ('5s' if role == 'native' else '0') and
                    props['Type'] == ('notify' if role == 'native' else 'exec') and
                    props['NotifyAccess'] == ('main' if role == 'native' else 'none'), 'native finite fixed PID1 lifetime differs')
        validate_configs(p, q, self.read_pin('daemon:config'), self.read_pin('containerd:config'), self.read_pin('pluginSpec'))

    def read_pin(self, role):
        fd = self.fds[role]; os.lseek(fd, 0, os.SEEK_SET)
        value = os.read(fd, MAX + 1); os.lseek(fd, 0, os.SEEK_SET)
        require(len(value) <= MAX, 'native pinned input bound')
        return value

    def kernel_policy(self):
        aa = Path('/sys/kernel/security/apparmor')
        require(read('/sys/module/apparmor/parameters/enabled', 16).strip() == b'Y' and
                read('/sys/module/apparmor/parameters/mode', 32).strip() == b'enforce', 'global native AppArmor enforcement absent')
        revision = read(aa / '.revision', 64).strip()
        require(re.fullmatch(b'[0-9]+', revision), 'native LSM revision unavailable')
        features = self.policy['kernelFeatures']
        require(type(features) is dict and 6 <= len(features) <= 32 and
                {'network/af_unix', 'ptrace/mask', 'domain/change_onexec', 'domain/change_profile',
                 'file/mask', 'namespaces/mask'} <= set(features), 'native mediation ABI incomplete')
        for name, expected in features.items():
            require(type(name) is str and re.fullmatch('[a-zA-Z0-9_/-]+', name) and not name.startswith('/') and
                    '..' not in name.split('/') and type(expected) is str and len(expected) <= 4096 and
                    read(aa / 'features' / name, 4096).decode() == expected, 'native mediation feature differs')
        require(all(features[key].strip() == 'yes' for key in ['network/af_unix', 'domain/change_onexec', 'domain/change_profile']) and
                {'read', 'trace'} <= set(features['ptrace/mask'].split()) and
                {'read', 'write', 'exec', 'lock'} <= set(features['file/mask'].split()) and
                'userns_create' in features['namespaces/mask'].split(), 'native mandatory kernel mediation disabled')
        records = {}
        for role, entry in self.policy['lsm'].items():
            path = Path(entry['profileDirectory'])
            require(str(path).startswith(str(aa / 'policy/profiles') + '/') and path.resolve(strict=True) == path and
                    read(path / 'name', 256).strip().decode() == PROFILES[role] and read(path / 'mode', 32).strip() == b'enforce' and
                    read(path / 'sha256', 128).strip().decode() == entry['profileSha256'], 'native loaded profile differs')
            raw_path = (path / 'raw_data').resolve(strict=True)
            require(str(raw_path).startswith(str(aa / 'policy/raw_data') + '/'), 'native kernel policy export escaped namespace')
            raw = read(raw_path, 4 * MAX)
            require(len(raw) == entry['compiled']['bytes'] and hashlib.sha256(raw).hexdigest() == entry['compiled']['sha256'],
                    'native running compiled profile differs from pinned enforcement')
            records[role] = {'profile': PROFILES[role], 'profileSha256': entry['profileSha256'],
                             'compiledSha256': entry['compiled']['sha256']}
        require(read(aa / '.revision', 64).strip() == revision, 'native kernel policy changed')
        return {'revision': revision.decode(), 'profiles': records, 'featuresSha256': self.p.digest(features)}

    def unit(self, role, deadline, pid=None, inactive=False):
        fields = unit_views(self.fds['systemctl'], [UNITS[role]], deadline)[UNITS[role]]
        unit_role = {'native': 'nativeUnit', 'daemon': 'daemonUnit', 'containerd': 'runtimeUnit', 'recovery': 'recoveryUnit'}[role]
        pin = self.a['roles'][unit_role]
        current, held = Path(pin['path']).stat(), os.fstat(self.fds[unit_role])
        require((current.st_dev, current.st_ino) == (held.st_dev, held.st_ino) and fields['FragmentPath'] == pin['path'] and
                fields['LoadState'] == 'loaded' and not fields['DropInPaths'] and fields['Delegate'] == 'no' and
                fields['AppArmorProfile'] == PROFILES['launcher' if role in ('daemon', 'containerd') else role] and fields['Restart'] == 'no' and
                fields['KillMode'] == 'control-group' and fields['PrivateNetwork'] == 'yes' and
                fields['JoinsNamespaceOf'].split() == ([UNITS['native']] if role in ('daemon', 'containerd') else []),
                'native fixed service identity/compartment differs')
        expected_binds = {'lunchlineup-development-engines.service'} if role in ('daemon', 'containerd') else set()
        if role == 'daemon': expected_binds.add('lunchlineup-development-containerd.service')
        require(set(fields['BindsTo'].split()) == expected_binds, 'native actual fixed owner binding differs')
        require(all(fields[key] == value for key, value in self.policy['units'][role]['properties'].items()),
                'native exact admitted PID1 command/lifetime serialization differs')
        if inactive:
            require(fields['MainPID'] == '0' and fields['ActiveState'] in ('inactive', 'failed') and fields['Job'] == '' and
                    cgroup_empty('/sys/fs/cgroup/system.slice/' + UNITS[role]), 'native fixed service not actually dead/quiescent')
        else:
            require(fields['MainPID'] == str(pid) and fields['ActiveState'] in ('activating', 'active') and
                    fields['ControlGroup'] == '/system.slice/' + UNITS[role], 'native PID1 owner differs')
            finite_limits(self.p, '/sys/fs/cgroup' + fields['ControlGroup'], self.policy['units'][role]['limits'])
        return fields

    def engine_argv(self, role):
        require(role in ('daemon', 'containerd'), 'fixed engine role')
        return [self.a['roles'][role]['path'], '--config-file' if role == 'daemon' else '--config', self.policy['configs'][role]['path']]


if __name__ == '__main__':
    raise SystemExit('Native custody common code has no public command interface.')
