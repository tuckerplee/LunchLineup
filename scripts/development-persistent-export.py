#!/usr/bin/env python3
"""Fixed, independently installed one-job export owner/recovery; not native QA.

No command, key-signing or target-selection endpoint. Installation is deliberately
not supplied. The existing protected Journal owns intent ordering and lock custody.
"""
import fcntl
import hashlib
import hmac
import json
import os
import re
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
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

POLICY = '/etc/lunchlineup/trust/persistent-export.json'
SOCKET = '/run/lunchlineup-persistent-export/owner.sock'
OWNER = 'lunchlineup-persistent-export-owner.service'
APP = 'lunchlineup-persistent-export-consumer.service'
RECOVERY = 'lunchlineup-persistent-export-recovery.service'
MAX = 16384
CONTROL_DEADLINE = None
LOADED_FIELDS = ('ExecStart', 'ExecStopPost', 'Requires', 'After', 'BindsTo',
    'TimeoutStartUSec', 'TimeoutStopUSec', 'RuntimeMaxUSec', 'KillMode',
    'MemoryMax', 'TasksMax', 'CPUQuotaPerSecUSec', 'IOReadBandwidthMax', 'IOWriteBandwidthMax',
    'User', 'Group', 'NoNewPrivileges', 'ProtectSystem', 'PrivateNetwork', 'ReadWritePaths',
    'Type', 'NotifyAccess', 'Delegate', 'Restart', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload')


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('ascii')


def parse(raw):
    require(0 < len(raw) <= MAX, 'record bound')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate field')
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=pairs)
    require(canonical(value) == raw, 'canonical record required')
    return value


def closed(value, fields):
    require(type(value) is dict and set(value) == set(fields), 'closed fields')


def controlled(path, maximum, private=True):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'canonical protected input')
    for part in [path, *path.parents]:
        info = part.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'root-controlled input')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                (not private or not before.st_mode & 0o077) and 0 < before.st_size <= maximum, 'input type/privacy/size')
        raw = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                len(raw) == before.st_size, 'input changed')
        return raw
    finally:
        os.close(fd)


def pinned(pin, private=True):
    closed(pin, ['path', 'sha256'])
    raw = controlled(pin['path'], 2 * 1048576, private)
    require(hashlib.sha256(raw).hexdigest() == pin['sha256'], 'input pin differs')
    return raw


def module(pin):
    value = types.ModuleType('persistent_export_' + Path(pin['path']).stem)
    exec(compile(pinned(pin, False), '<pinned-persistent-dependency>', 'exec'), value.__dict__)
    return value



def duration_seconds(value):
    require(type(value) is str and value, 'explicit finite loaded duration')
    parts = re.findall(r'([0-9]+)(us|ms|min|s|h|d)', value)
    require(parts and ' '.join(number + unit for number, unit in parts) == value,
            'unsupported/infinite loaded duration')
    scales = {'us': 1, 'ms': 1000, 's': 1000000, 'min': 60000000, 'h': 3600000000, 'd': 86400000000}
    total = sum(int(number) * scales[unit] for number, unit in parts)
    require(0 < total <= 2**53, 'finite positive loaded duration bound')
    return total / 1000000


def policy():
    q = parse(controlled(POLICY, MAX))
    closed(q, ['version', 'scopeSha256', 'approvalReference', 'jobId', 'tenantId', 'sourceSha',
        'notBeforeMs', 'expiresMs', 'operationMs', 'recoveryMs', 'heartbeatMs', 'lossMs',
        'appUid', 'appGid', 'appExeSha256', 'appCmdline', 'ownerExeSha256', 'journalDirectory',
        'history', 'protocol', 'ownerPrivateKey', 'ownerPublicKey', 'recoveryPrivateKey',
        'recoveryPublicKey', 'appKey', 'units', 'systemctl', 'entry', 'appEntry', 'appEnvironment', 'loadedUnits', 'queryMs', 'queryKillMs', 'terminalReserveMs'])
    require(q['entry']['path'] == '/usr/local/libexec/lunchlineup/development-persistent-export.py', 'fixed persistent entry')
    pinned(q['entry'], False)
    require(Path(__file__).resolve() == Path(q['entry']['path']), 'installed entry required')
    require(q['version'] == 1 and type(q['approvalReference']) is str and
            q['approvalReference'] and q['approvalReference'] != 'UNFILLED', 'explicit installed scope')
    require(type(q['scopeSha256']) is str and re.fullmatch('[a-f0-9]{64}', q['scopeSha256']) and
            type(q['sourceSha']) is str and re.fullmatch('[a-f0-9]{40}', q['sourceSha']), 'scope/source identity')
    for name in ['notBeforeMs', 'expiresMs', 'operationMs', 'recoveryMs', 'heartbeatMs', 'lossMs', 'appUid', 'appGid']:
        require(type(q[name]) is int and q[name] > 0, 'explicit numeric policy')
    require(q['notBeforeMs'] < q['expiresMs'] and 100 <= q['heartbeatMs'] < q['lossMs'] <= 10000 and
            1000 <= q['operationMs'] <= 3600000 and 1000 <= q['recoveryMs'] <= 300000, 'bounded independent owner policy')
    for name in ['jobId', 'tenantId']:
        require(type(q[name]) is str and 1 <= len(q[name]) <= 128 and q[name].isascii(), 'exact selected job/tenant')
    require(type(q['appCmdline']) is list and len(q['appCmdline']) == 2 and
            all(type(x) is str and x.startswith('/') for x in q['appCmdline']), 'fixed node/entry argv')
    require(q['appEntry']['path'] == q['appCmdline'][1], 'consumer entry pin/argv')
    pinned(q['appEntry'], False)
    require(set(q['units']) == {OWNER, APP, RECOVERY}, 'exact independent units')
    for pin in q['units'].values():
        pinned(pin, False)
    pinned(q['systemctl'], False)
    require(type(q['loadedUnits']) is dict and set(q['loadedUnits']) == {OWNER, APP, RECOVERY}, 'all loaded unit contracts required')
    for unit, values in q['loadedUnits'].items():
        closed(values, LOADED_FIELDS)
        for field in ('TimeoutStartUSec', 'TimeoutStopUSec', 'RuntimeMaxUSec', 'CPUQuotaPerSecUSec'):
            duration_seconds(values[field])
        for field in ('MemoryMax', 'TasksMax'):
            require(type(values[field]) is str and values[field].isdigit() and int(values[field]) > 0, 'finite selected resource limit')
        require(values['NeedDaemonReload'] == 'no' and values['KillMode'] == 'control-group' and
                values['Restart'] == 'no' and values['DropInPaths'] == '' and
                values['FragmentPath'] == q['units'][unit]['path'], 'fixed loaded unit safety constraints')
    for name in ['queryMs', 'queryKillMs', 'terminalReserveMs']:
        require(type(q[name]) is int and q[name] > 0, 'explicit query/termination/terminal reservations')
    require(q['queryMs'] <= 2000 and q['queryMs'] + q['queryKillMs'] + q['terminalReserveMs'] < q['recoveryMs'],
            'original recovery budget must cover acquisition, termination and terminal reserve')
    require(q['ownerPublicKey']['sha256'] != q['recoveryPublicKey']['sha256'] and
            q['ownerPrivateKey']['path'] != q['recoveryPrivateKey']['path'], 'distinct recovery signing role')
    return q


def starttime(pid):
    return Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()[19]


def incarnation(pid, uid, gid, exe, unit, argv=None):
    root = Path('/proc') / str(pid)
    before = starttime(pid)
    status = (root / 'status').read_text()
    wanted = {'Uid:': uid, 'Gid:': gid}
    for line in status.splitlines():
        fields = line.split()
        if fields and fields[0] in wanted:
            require(all(int(x) == wanted[fields[0]] for x in fields[1:]), 'process credentials')
            del wanted[fields[0]]
    require(not wanted and (root / 'cgroup').read_text() == '0::/system.slice/' + unit + '\n', 'process cgroup')
    with (root / 'exe').open('rb') as stream:
        require(hashlib.file_digest(stream, 'sha256').hexdigest() == exe, 'process executable')
    if argv is not None:
        require((root / 'cmdline').read_bytes() == b'\0'.join(x.encode() for x in argv) + b'\0', 'process argv')
    require(starttime(pid) == before, 'process incarnation changed')
    return {'pid': pid, 'starttime': before, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'unit': unit}



def app_incarnation(q, pid):
    identity = incarnation(pid, q['appUid'], q['appGid'], q['appExeSha256'], APP, q['appCmdline'])
    expected = parse(pinned(q['appEnvironment']))
    closed(expected, ['DATABASE_URL', 'PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'TENANT_EXPORT_PILOT_MODE',
        'TENANT_EXPORT_ARTIFACT_DIRECTORY', 'TENANT_EXPORT_SHARED_STORAGE', 'TENANT_EXPORT_MAX_ARTIFACT_BYTES',
        'TENANT_EXPORT_GLOBAL_QUOTA_BYTES', 'TENANT_EXPORT_PER_TENANT_QUOTA_BYTES'])
    require(expected['TENANT_EXPORT_PILOT_MODE'] == 'true' and
            all(type(value) is str and value for value in expected.values()), 'explicit closed consumer environment')
    with open('/proc/' + str(pid) + '/environ', 'rb') as stream:
        raw = stream.read(1048577)
    require(len(raw) <= 1048576, 'consumer environment bound')
    actual = {}
    for entry in raw.split(b'\0'):
        if not entry:
            continue
        name, separator, value = entry.partition(b'=')
        require(separator and name not in actual, 'consumer environment shape')
        actual[name] = value
    require(all(actual.get(name.encode()) == value.encode() for name, value in expected.items()),
            'consumer database/storage environment differs')
    require(starttime(pid) == identity['starttime'], 'consumer changed during environment binding')
    return identity


class QueryUnsettled(RuntimeError):
    def __init__(self, child):
        super().__init__('owned unit query remains unsettled; PID1 containment required')
        self.child = child


def remaining(q, reserve_ms=0):
    require(CONTROL_DEADLINE is not None, 'original control deadline not established')
    available = CONTROL_DEADLINE - time.monotonic() - reserve_ms / 1000
    require(available > 0, 'original control deadline/reserve exhausted')
    return available


def loaded_exec(value):
    if value == '':
        return None
    require(value.startswith('{ ') and value.endswith(' }'), 'unsupported loaded Exec syntax')
    fields = {}
    for item in value[2:-2].split(' ; '):
        key, separator, item_value = item.partition('=')
        require(separator and key not in fields, 'loaded Exec duplicate/malformed field')
        fields[key] = item_value
    closed(fields, ['path', 'argv[]', 'ignore_errors', 'start_time', 'stop_time', 'pid', 'code', 'status'])
    require(fields['ignore_errors'] in ('yes', 'no') and fields['pid'].isdigit() and
            fields['path'].startswith('/') and not any(c in fields['path'] for c in ' ;{}'), 'loaded Exec fields')
    # Only fixed whitespace-separated argv used by these three installed roles.
    # Quoted/escaped argv or multiple commands need a separately reviewed grammar.
    require(not any(ord(c) in (92, 34, 39, 59, 123, 125) for c in fields['argv[]']), 'unsupported loaded Exec argv')
    return {'path': fields['path'], 'argv': fields['argv[]'].split(), 'ignore_errors': fields['ignore_errors']}


def unit_fields(q, unit):
    reserve = q['queryKillMs'] + q['terminalReserveMs']
    require(remaining(q, reserve) >= q['queryMs'] / 1000, 'insufficient full query reservation before spawn')
    query_end = min(CONTROL_DEADLINE - reserve / 1000, time.monotonic() + q['queryMs'] / 1000)
    # Block termination delivery before creating the child and retain that mask
    # until it is reaped. The fixed read-only child inherits the mask; SIGKILL
    # remains available for its bounded cleanup and PID1 control-group containment.
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
    child = None
    output = bytearray()
    try:
        child = subprocess.Popen([q['systemctl']['path'], 'show', unit, '--no-pager',
            '--property=' + ','.join(LOADED_FIELDS + ('MainPID', 'ActiveState', 'SubState', 'ExecMainStartTimestampMonotonic'))],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        os.set_blocking(child.stdout.fileno(), False)
        eof = False
        while not (eof and child.poll() is not None):
            timeout = query_end - time.monotonic()
            require(timeout > 0, 'unit query deadline')
            readable, _, _ = select.select([child.stdout], [], [], min(timeout, .05))
            if readable:
                chunk = os.read(child.stdout.fileno(), MAX + 1 - len(output))
                if not chunk:
                    eof = True
                output.extend(chunk)
                require(len(output) <= MAX, 'unit response bound')
        require(child.returncode == 0, 'unit query failed')
    except BaseException:
        if child is not None:
            try:
                if child.poll() is None:
                    child.kill()  # Exact unreaped Popen child; never PID/unit-name lookup.
                    kill_end = min(CONTROL_DEADLINE - q['terminalReserveMs'] / 1000,
                                   time.monotonic() + q['queryKillMs'] / 1000)
                    child.wait(timeout=max(0, kill_end - time.monotonic()))
            except BaseException:
                raise QueryUnsettled(child)
        raise
    finally:
        if child is not None:
            try:
                child.stdout.close()
                settled = child.poll() is not None
            except BaseException:
                raise QueryUnsettled(child)
            if not settled:
                raise QueryUnsettled(child)
        # Pending termination may run here, but only after exact child settlement
        # (or a Popen failure that never returned an owned child).
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    remaining(q, q['terminalReserveMs'])
    values = {}
    for line in output.decode().splitlines():
        key, separator, value = line.partition('=')
        require(separator and key not in values, 'unit property duplicate/malformed')
        values[key] = value
    closed(values, LOADED_FIELDS + ('MainPID', 'ActiveState', 'SubState', 'ExecMainStartTimestampMonotonic'))
    selected = {key: loaded_exec(values[key]) if key in ('ExecStart', 'ExecStopPost') else values[key]
                for key in LOADED_FIELDS}
    require(selected == q['loadedUnits'][unit], 'effective loaded unit differs from accepted policy')
    return values


def keys(q, role):
    public = serialization.load_pem_public_key(pinned(q[role + 'PublicKey'], False))
    require(isinstance(public, Ed25519PublicKey), 'Ed25519 public role key')
    private = serialization.load_pem_private_key(pinned(q[role + 'PrivateKey']), password=None)
    require(isinstance(private, Ed25519PrivateKey) and
            private.public_key().public_bytes_raw() == public.public_bytes_raw(), 'role keypair differs')
    other = 'recovery' if role == 'owner' else 'owner'
    other_public = serialization.load_pem_public_key(pinned(q[other + 'PublicKey'], False))
    require(isinstance(other_public, Ed25519PublicKey) and
            public.public_bytes_raw() != other_public.public_bytes_raw(), 'distinct signing keys required')
    return private, public


def signed(private, body):
    return {'body': body, 'signature': private.sign(canonical(body)).hex()}


def send(peer, key, session, sequence, kind, body):
    value = {'session': session, 'sequence': sequence, 'kind': kind, 'body': body}
    wire = canonical({'value': value, 'mac': hmac.new(key, canonical(value), hashlib.sha256).hexdigest()}) + b'\n'
    require(len(wire) <= MAX, 'wire bound')
    peer.sendall(wire)


def receive(peer, buffer, key, session, sequence):
    chunk = peer.recv(MAX + 1)
    require(chunk, 'peer EOF')
    buffer.extend(chunk)
    require(buffer and len(buffer) <= MAX, 'peer EOF/oversize')
    if b'\n' not in buffer:
        return None
    raw, _, rest = bytes(buffer).partition(b'\n')
    require(not rest, 'no pipelined commands')
    buffer.clear()
    envelope = parse(raw)
    closed(envelope, ['value', 'mac'])
    value = envelope['value']
    closed(value, ['session', 'sequence', 'kind', 'body'])
    require(hmac.compare_digest(envelope['mac'], hmac.new(key, canonical(value), hashlib.sha256).hexdigest()) and
            value['session'] == session and type(value['sequence']) is int and value['sequence'] == sequence, 'peer MAC/sequence/session')
    return value


def owner(q):
    global CONTROL_DEADLINE
    def terminate(_signum, _frame):
        raise RuntimeError('persistent owner stopping; independent recovery required')
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    identity = incarnation(os.getpid(), 0, q['appGid'], q['ownerExeSha256'], OWNER)
    actual = unit_fields(q, OWNER)
    require(actual['ExecMainStartTimestampMonotonic'].isdigit(), 'original owner PID1 start')
    CONTROL_DEADLINE = min(CONTROL_DEADLINE, int(actual['ExecMainStartTimestampMonotonic']) / 1000000
                           + duration_seconds(actual['RuntimeMaxUSec']))
    require(actual['MainPID'] == str(os.getpid()) and actual['ActiveState'] in ('active', 'activating'), 'actual owner MainPID')
    # Exact pinned unit bytes supply the fixed crash trigger; no inferred OnFailure grant.
    unit_fields(q, RECOVERY)
    private, _ = keys(q, 'owner')
    protocol, history = module(q['protocol']), module(q['history'])
    session = os.urandom(32).hex()
    journal = history.Journal(protocol, q['journalDirectory'], session)
    def record(kind, body):
        return journal.append('PERSISTENT_EXPORT', signed(private, {'kind': kind, 'session': session,
            'scopeSha256': q['scopeSha256'], 'jobId': q['jobId'], 'tenantId': q['tenantId'], 'body': body}))
    record('OWNER', {'identity': identity, 'policySha256': hashlib.sha256(canonical(q)).hexdigest()})
    key = pinned(q['appKey'])
    require(len(key) == 32, 'dedicated app role key')
    now = int(time.time() * 1000)
    require(q['notBeforeMs'] <= now < q['expiresMs'], 'explicit owner lifetime')
    end = min(CONTROL_DEADLINE, time.monotonic() + (q['expiresMs'] - now) / 1000)
    directory = Path(SOCKET).parent
    info = directory.stat()
    require(directory.resolve(strict=True) == directory and info.st_uid == 0 and
            info.st_gid == q['appGid'] and stat.S_IMODE(info.st_mode) == 0o750, 'protected socket directory')
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET)  # Existing socket is not unlinked or retried.
    os.chown(SOCKET, 0, q['appGid']); os.chmod(SOCKET, 0o660)
    server.listen(1)
    notify_path = os.environ.get('NOTIFY_SOCKET', '')
    require(notify_path.startswith('@') or len(notify_path) > 1, 'notify address')
    require(notify_path.startswith(('/', '@')), 'PID1 notification socket required')
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notification:
        notification.connect('\0' + notify_path[1:] if notify_path.startswith('@') else notify_path)
        notification.sendall(b'READY=1')
    server.settimeout(max(.001, end - time.monotonic()))
    peer, _ = server.accept(); peer.settimeout(q['lossMs'] / 1000)
    pid, uid, gid = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    require((uid, gid) == (q['appUid'], q['appGid']), 'app peer credentials')
    app = app_incarnation(q, pid)
    app_unit = unit_fields(q, APP)
    require(app_unit['MainPID'] == str(pid) and OWNER in app_unit['BindsTo'].split(), 'actual consumer owner dependency')
    pidfd = os.pidfd_open(pid, 0)
    record('ADOPTED', {'app': app})
    send(peer, key, session, 0, 'HELLO', {'jobId': q['jobId'], 'tenantId': q['tenantId'],
        'scopeSha256': q['scopeSha256'], 'sourceSha': q['sourceSha'], 'operationMs': q['operationMs'], 'lossMs': q['lossMs']})
    buffer = bytearray(); ready = None
    while ready is None:
        ready = receive(peer, buffer, key, session, 0)
    require(ready['kind'] == 'READY' and ready['body'] == {'generation': 'closed', 'cleanup': 'closed'}, 'actual closed consumer')
    require(app_incarnation(q, pid) == app, 'app changed before intent')
    intent = record('INTENT', {'app': app, 'effect': 'generate-exact-export', 'operationMs': q['operationMs']})
    require(time.monotonic() + q['operationMs'] / 1000 + q['lossMs'] / 1000 < end, 'operation/settlement inside independent owner lifetime')
    send(peer, key, session, 1, 'GENERATE', {'intentSha256': intent})
    sequence = 2; due = time.monotonic(); operation_end = time.monotonic() + q['operationMs'] / 1000
    while True:
        require(time.monotonic() < min(end, operation_end) and not select.select([pidfd], [], [], 0)[0], 'owner operation deadline/app loss')
        readable, _, _ = select.select([peer], [], [], min(q['heartbeatMs'] / 1000, .25))
        if readable:
            result = receive(peer, buffer, key, session, 1)
            if result is not None:
                closed(result['body'], ['outcome', 'processed'])
                require(result['kind'] == 'RESULT' and result['body']['outcome'] in ('settled', 'unknown')
                    and type(result['body']['processed']) is bool, 'fixed result')
                require(app_incarnation(q, pid) == app, 'app changed at result')
                record('READBACK', {'app': app, 'intentSha256': intent, **result['body']})
                require(result['body']['outcome'] == 'settled', 'application reported unresolved')
                record('COMPLETE', {'intentSha256': intent})
                send(peer, key, session, sequence, 'COMMITTED', {'intentSha256': intent})
                return
        if time.monotonic() >= due:
            send(peer, key, session, sequence, 'PING', {})
            sequence += 1; due = time.monotonic() + q['heartbeatMs'] / 1000


def recover(q):
    global CONTROL_DEADLINE
    incarnation(os.getpid(), 0, 0, q['ownerExeSha256'], RECOVERY)
    require(unit_fields(q, OWNER)['MainPID'] == '0', 'owner still present')
    recovery_unit = unit_fields(q, RECOVERY)
    require(recovery_unit['MainPID'] == str(os.getpid()) and
            recovery_unit['ExecMainStartTimestampMonotonic'].isdigit(), 'actual recovery MainPID/start')
    recovery_end = min(CONTROL_DEADLINE, int(recovery_unit['ExecMainStartTimestampMonotonic']) / 1000000 + q['recoveryMs'] / 1000)
    recovery_end = min(recovery_end, int(recovery_unit['ExecMainStartTimestampMonotonic']) / 1000000
                       + duration_seconds(recovery_unit['RuntimeMaxUSec']))
    CONTROL_DEADLINE = recovery_end
    require(time.monotonic() < recovery_end, 'original recovery lifetime')
    private, _ = keys(q, 'recovery')
    owner_public = serialization.load_pem_public_key(pinned(q['ownerPublicKey'], False))
    require(isinstance(owner_public, Ed25519PublicKey), 'owner verification key')
    protocol, history = module(q['protocol']), module(q['history'])
    root = Path(q['journalDirectory'])
    require(root.resolve(strict=True) == root and root.stat().st_uid == 0 and
            stat.S_IMODE(root.stat().st_mode) == 0o700, 'recovery directory custody')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    names = os.listdir(fd)
    require(len(names) <= 8, 'recovery namespace bound')
    journals = [name for name in names if name.endswith('.guardian')]
    require(len(journals) == 1 and set(names) == set(journals), 'one exact history and no prior recovery attempt required')
    remaining(q, q['terminalReserveMs'])
    attempt = os.open('persistent-export.recovery-attempt', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    with os.fdopen(attempt, 'wb') as stream:
        stream.write(canonical({'scopeSha256': q['scopeSha256'], 'jobId': q['jobId'], 'retryAllowed': False}) + b'\n')
        stream.flush(); os.fsync(stream.fileno())
    os.fsync(fd)
    snapshot = history.chain_snapshot(protocol, fd, journals[0])
    rows = []; row_hashes = []
    for row in snapshot['rows']:
        item = row['row']; require(item['kind'] == 'PERSISTENT_EXPORT', 'unexpected owner event')
        envelope = item['body']; closed(envelope, ['body', 'signature'])
        owner_public.verify(bytes.fromhex(envelope['signature']), canonical(envelope['body']))
        body = envelope['body']
        closed(body, ['kind', 'session', 'scopeSha256', 'jobId', 'tenantId', 'body'])
        require(body['scopeSha256'] == q['scopeSha256'] and body['jobId'] == q['jobId'] and
                body['tenantId'] == q['tenantId'] and body['session'] + '.guardian' == journals[0], 'recovery scope/session')
        rows.append(body)
        row_hashes.append(hashlib.sha256(protocol.canonical(item) + b'\n').hexdigest())
    kinds = [row['kind'] for row in rows]
    require(kinds in (['OWNER'], ['OWNER', 'ADOPTED'], ['OWNER', 'ADOPTED', 'INTENT'],
        ['OWNER', 'ADOPTED', 'INTENT', 'READBACK'], ['OWNER', 'ADOPTED', 'INTENT', 'READBACK', 'COMPLETE']),
        'closed persistent history progression')
    closed(rows[0]['body'], ['identity', 'policySha256'])
    require(rows[0]['body']['policySha256'] == hashlib.sha256(canonical(q)).hexdigest(),
            'recovery policy differs from the accepted immutable owner contract')
    def identity(value, unit):
        closed(value, ['pid', 'starttime', 'bootId', 'unit'])
        require(type(value['pid']) is int and value['pid'] > 0 and type(value['starttime']) is str and
                value['starttime'].isdigit() and value['unit'] == unit and
                value['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                'recorded process identity/boot differs')
    identity(rows[0]['body']['identity'], OWNER)
    if len(rows) >= 2:
        closed(rows[1]['body'], ['app'])
        identity(rows[1]['body']['app'], APP)
    if len(rows) >= 3:
        closed(rows[2]['body'], ['app', 'effect', 'operationMs'])
        require(rows[2]['body']['app'] == rows[1]['body']['app'] and
                rows[2]['body']['effect'] == 'generate-exact-export' and
                type(rows[2]['body']['operationMs']) is int and rows[2]['body']['operationMs'] == q['operationMs'],
                'intent differs from accepted application/effect/budget')
    if len(rows) >= 4:
        closed(rows[3]['body'], ['app', 'intentSha256', 'outcome', 'processed'])
        require(rows[3]['body']['app'] == rows[1]['body']['app'] and
                rows[3]['body']['intentSha256'] == row_hashes[2] and
                rows[3]['body']['outcome'] in ('settled', 'unknown') and
                type(rows[3]['body']['processed']) is bool, 'readback does not link exact intent/app')
    if len(rows) == 5:
        closed(rows[4]['body'], ['intentSha256'])
        require(rows[4]['body']['intentSha256'] == row_hashes[2] and
                rows[3]['body']['outcome'] == 'settled', 'completion lacks exact settled readback')
    process_settled = False
    if len(rows) >= 2:
        app = rows[1]['body']['app']
        target = None
        try:
            try:
                target = os.pidfd_open(app['pid'], 0)
            except ProcessLookupError:
                pass  # Recorded PID is absent; never substitute the unit's current PID.
            current = unit_fields(q, APP)
            if target is not None and not select.select([target], [], [], 0)[0]:
                require(current['MainPID'] == str(app['pid']) and app_incarnation(q, app['pid']) == app,
                        'recovery refuses replaced application incarnation')
                require(not select.select([target], [], [], 0)[0] and remaining(q, q['queryMs'] + q['queryKillMs'] + q['terminalReserveMs']) > 0,
                        'recovery held process exited or deadline exhausted')
                try:
                    signal.pidfd_send_signal(target, signal.SIGTERM)
                except ProcessLookupError:
                    pass  # Original exited after validation; handle cannot target a replacement.
            else:
                require(current['MainPID'] == '0', 'replacement unit remains outside recovery authority')
            while time.monotonic() < recovery_end:
                original_exited = target is None or bool(select.select([target], [], [], 0)[0])
                current = unit_fields(q, APP)
                require(current['MainPID'] in ('0', str(app['pid'])), 'unit replaced during recovery; no further effect')
                if current['MainPID'] == str(app['pid']):
                    require(not original_exited and app_incarnation(q, app['pid']) == app,
                            'unit reused a recorded PID after its original process exited')
                if original_exited and current['MainPID'] == '0' and current['ActiveState'] in ('inactive', 'failed'):
                    group = Path('/sys/fs/cgroup/system.slice') / APP
                    if not group.exists() or 'populated 0' in (group / 'cgroup.events').read_text().splitlines():
                        process_settled = True
                        break
                time.sleep(min(.1, remaining(q, q['queryMs'] + q['queryKillMs'] + q['terminalReserveMs'])))
        finally:
            if target is not None:
                os.close(target)
    require(time.monotonic() < recovery_end, 'independent recovery deadline exceeded')
    # The independent action never reissues GENERATE or claims database/queue settlement.
    # It retains a signed recovery fence even when the app previously reported settled.
    receipt = signed(private, {'kind': 'RECOVERY_FENCE', 'scopeSha256': q['scopeSha256'],
        'jobId': q['jobId'], 'ownerHistorySha256': snapshot['sha256'], 'lastOwnerEvent': rows[-1]['kind'] if rows else 'absent',
        'applicationProcessSettled': process_settled, 'backendSettlementProved': False,
        'outcome': 'requires-independent-reconciliation', 'retryAllowed': False})
    remaining(q, q['terminalReserveMs'])
    out = os.open('persistent-export.recovery', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    raw = canonical(receipt) + b'\n'
    with os.fdopen(out, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.fsync(fd)


def main():
    global CONTROL_DEADLINE
    require(os.getuid() == os.geteuid() == 0 and len(sys.argv) == 2 and sys.argv[1] in ('owner', 'recovery'), 'fixed installed root role')
    q = policy()
    # Original process birth is a nonrenewable bootstrap ceiling, available before
    # the first PID1 query. Loaded PID1 start below can only shorten it.
    born = int(starttime(os.getpid())) / os.sysconf('SC_CLK_TCK')
    if sys.argv[1] == 'recovery':
        CONTROL_DEADLINE = born + min(q['recoveryMs'] / 1000, duration_seconds(q['loadedUnits'][RECOVERY]['RuntimeMaxUSec']))
    else:
        CONTROL_DEADLINE = min(born + duration_seconds(q['loadedUnits'][OWNER]['RuntimeMaxUSec']),
            time.monotonic() + (q['expiresMs'] - int(time.time() * 1000)) / 1000)
    try:
        if sys.argv[1] == 'owner':
            owner(q)
        else:
            recover(q)
    except QueryUnsettled as error:
        # No more queries, receipts or effects. Keep actual child custody until
        # exit or the independently installed PID1 cgroup deadline contains us.
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
        while True:
            try:
                if error.child.poll() is not None:
                    break
                time.sleep(.05)
            except BaseException:
                # Never drop the handle or resume effects after interrupted reaping.
                try:
                    time.sleep(.05)
                except BaseException:
                    pass
        raise


if __name__ == '__main__':
    main()
