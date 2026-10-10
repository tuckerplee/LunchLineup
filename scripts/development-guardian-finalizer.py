#!/usr/bin/python3
"""Fixed PID1 finalizer: preserve durable unresolved ownership.

Installer must pin this starter and its interpreter in the service unit. This
source is not an installer. No request arguments, environment overrides or shell.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys
import types


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise RuntimeError('fixed root starter only')
    # Load just the independent installation library without importing from
    # writable cwd/PYTHONPATH or letting a supplied module choose its own pin.
    path = Path('/etc/lunchlineup/trust/development-guardian.json')
    for part in [path, *path.parents]:
        info = part.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or part.resolve(strict=True) != part:
            raise RuntimeError('starter anchor custody')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise RuntimeError('starter anchor privacy')
        raw = os.read(fd, 1048577)
        if len(raw) > 1048576:
            raise RuntimeError('starter anchor bound')
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise RuntimeError('starter duplicate key')
                value[key] = item
            return value
        value = json.loads(raw, object_pairs_hook=unique)
    finally:
        os.close(fd)
    entry = value['roles']['installation']
    path = Path(entry['path'])
    if str(path) != '/usr/local/libexec/lunchlineup/development-guardian-installation.py':
        raise RuntimeError('wrong installation library role')
    for part in [path, *path.parents]:
        info = part.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or part.resolve(strict=True) != part:
            raise RuntimeError('starter library custody')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        measured = bytearray(struct.pack('HH', 0, 64) + bytes(64))
        fcntl.ioctl(fd, 0xC0046686, measured, True)
        raw = os.read(fd, 1048577)
        if not stat.S_ISREG(os.fstat(fd).st_mode) or len(raw) != entry['bytes'] or len(raw) > 1048576 or hashlib.sha256(raw).hexdigest() != entry['sha256'] or struct.unpack('HH', measured[:4]) != (1, 32) or measured[4:36].hex() != entry['veritySha256']:
            raise RuntimeError('starter library pin')
        library = types.ModuleType('fixed_guardian_installation')
        exec(compile(raw, '<installed-library>', 'exec'), library.__dict__)
    finally:
        os.close(fd)
    authority = library.anchor()
    held = {}
    for role in ['finalizer', 'protocol', 'workers', 'history']:
        held[role] = library.pin(authority['roles'][role])
    p = library.load_module('protocol', held['protocol'])
    workers = library.load_module('workers', held['workers'])
    history = library.load_module('history', held['history'])
    policy_fd = library.pin(authority['policy'], True)
    policy = p.parse(os.read(policy_fd, 1048577))
    os.close(policy_fd)
    directory = Path(policy['journalDirectory'])
    for part in [directory, *directory.parents]:
        info = part.lstat()
        if part.resolve(strict=True) != part or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('finalizer journal parent custody')
    if directory.stat().st_mode & 0o077:
        raise RuntimeError('finalizer private journal directory required')
    custody_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fcntl.flock(custody_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        fence_fd = library.controlled(directory / 'active.fence', True)
    except FileNotFoundError:
        # A retired/missing fence is never clean by itself. Select the sole
        # retained private WAL and verify its complete chain before deriving any
        # containment target. Partial/unlinked/foreign history refuses.
        names = os.listdir(custody_fd)
        if len(names) > 2048:
            raise RuntimeError('finalizer prior history inventory bound')
        journals = [name for name in names if name.endswith('.guardian')]
        if len(journals) != 1:
            raise RuntimeError('absent fence with ambiguous guardian WAL')
        p.sha(journals[0][:-9])
        snapshot = history.chain_snapshot(p, custody_fd, journals[0])
        created = [item['row']['body'] for item in snapshot['rows'] if item['row']['kind'] == 'FENCE_CREATED']
        intent = [item['row']['body'] for item in snapshot['rows'] if item['row']['kind'] == 'GUEST_RETIRE_INTENT']
        if len(created) != 1 or len(intent) != 1:
            raise RuntimeError('absent fence lacks exact protected retirement intent')
        fence_bytes = p.canonical(created[0]['fence']) + b'\n'
        if hashlib.sha256(fence_bytes).hexdigest() != created[0]['guestFenceSha256'] or intent[0]['guestFenceIdentity'] != {
            'device': created[0]['device'], 'inode': created[0]['inode'], 'guestFenceSha256': created[0]['guestFenceSha256'],
            'localSessionId': created[0]['fence']['localSessionId'],
            'guardianSessionId': intent[0]['guestFenceIdentity']['guardianSessionId']}:
            raise RuntimeError('absent fence historical identity differs')
        if journals[0] != created[0]['fence']['localSessionId'] + '.guardian':
            raise RuntimeError('absent fence WAL session differs')
    else:
        fence_bytes = os.read(fence_fd, 1048577)
        os.close(fence_fd)
    fence = p.parse(fence_bytes.rstrip(b'\n'))
    p.closed(fence, ['localSessionId', 'guestBootId', 'guardianPid', 'guardianStarttime', 'requestSha256'])
    p.sha(fence['localSessionId'])
    # Root-private journal is selected solely by the current independently
    # created fence; a caller never supplies paths, PIDs or containment targets.
    journal_fd = library.controlled(directory / (fence['localSessionId'] + '.guardian'), True)
    raw = os.read(journal_fd, 16 * 1048576 + 1)
    os.close(journal_fd)
    if not raw or len(raw) > 16 * 1048576 or not raw.endswith(b'\n'):
        raise RuntimeError('finalizer partial/oversized guardian history; fence retained')
    previous = '0' * 64
    registrations = []
    lines = raw.splitlines(keepends=True)
    if len(lines) > 4096:
        raise RuntimeError('finalizer history row limit')
    for sequence, line in enumerate(lines):
        row = p.parse(line[:-1], 1049600)
        p.closed(row, ['sequence', 'previous', 'kind', 'body'])
        if type(row['sequence']) is not int or row['sequence'] != sequence or row['previous'] != previous or p.canonical(row) + b'\n' != line:
            raise RuntimeError('finalizer journal chain differs; fence retained')
        previous = hashlib.sha256(line).hexdigest()
        if row['kind'] == 'WORKER' and row['body']['type'] in ('prepared', 'broker-prepared'):
            event = row['body']
            admission = policy['workerCgroup'] if event['type'] == 'prepared' else policy['brokerCgroup']
            registered = event['body']
            if registered['cgroup'] != admission['path']:
                raise RuntimeError('finalizer registration differs from independent cgroup policy')
            registrations.append((admission, registered))
    observations = []
    seen = set()
    for admission, registered in registrations:
        if admission['path'] in seen:
            continue
        seen.add(admission['path'])
        path = Path(admission['path'])
        if not str(path).startswith('/sys/fs/cgroup/') or path.resolve(strict=True) != path:
            raise RuntimeError('finalizer cgroup custody absent')
        for part in [path, *path.parents]:
            info = part.lstat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('finalizer cgroup custody changed')
        info = path.stat()
        if (info.st_dev, info.st_ino) != (registered['cgroupDevice'], registered['cgroupInode']):
            raise RuntimeError('finalizer refuses replaced cgroup')
        # Build only the registered containment handle. Constructor's empty-slot
        # requirement applies to dispatch, not terminal containment of survivors.
        slot = object.__new__(workers.CgroupSlot)
        slot.path, slot.identity = path, (info.st_dev, info.st_ino)
        slot.procs_fd = None
        if not slot.empty():
            slot.kill()
        observations.append({'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
                             'recursiveEmptyObserved': slot.empty()})
    receipt = p.canonical({'kind': 'guardian-finalizer-observation', 'localSessionId': fence['localSessionId'],
        'fenceSha256': hashlib.sha256(fence_bytes).hexdigest(), 'guardianHistorySha256': hashlib.sha256(raw).hexdigest(),
        'cgroups': observations, 'outcome': 'unresolved', 'authorityRestored': False,
        'fenceClearAuthorized': False, 'automaticRetryAllowed': False}) + b'\n'
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        output = os.open(fence['localSessionId'] + '.finalizer', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory_fd)
        try:
            remaining = memoryview(receipt)
            while remaining:
                count = os.write(output, remaining)
                if count <= 0:
                    raise RuntimeError('finalizer short receipt write')
                remaining = remaining[count:]
            os.fsync(output)
        finally:
            os.close(output)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    os.close(custody_fd)
    # Receipt remains unresolved even after local retirement: it does not know
    # whether the host durably received the last reply. Never retire the separate
    # writer-owner registry or authorize a new session. No cleanup/mutation.


if __name__ == '__main__':
    main()
