#!/usr/bin/env python3
"""Read only the fixed owner phase record; absence preserves generic wrapper mode."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time



def require_readonly_mount(path):
    """Identify the visible mount through this directory FD, including bind mounts.

    ismount() cannot distinguish a same-device bind from its parent. The kernel
    fdinfo mount ID selects the actual visible mountinfo row, not an inferred
    newest ID or a hidden stacked mount. Both VFS options and fstatvfs must be RO.
    """
    if path.resolve(strict=True) != path:
        raise ValueError('runtime input parent is not canonical')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        first = os.fstat(fd)
        if not stat.S_ISDIR(first.st_mode) or first.st_uid != 0 or first.st_mode & 0o022:
            raise ValueError('runtime input parent is not protected')
        descriptor = Path('/proc/self/fdinfo') / str(fd)
        ids = [line.split(':', 1)[1].strip() for line in descriptor.read_text().splitlines()
               if line.startswith('mnt_id:')]
        if len(ids) != 1 or not re.fullmatch(r'[1-9][0-9]*', ids[0]):
            raise ValueError('runtime visible mount ID unavailable')
        entries = [line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()]
        rows = [row for row in entries if row and row[0] == ids[0]]
        if len(rows) != 1 or len(rows[0]) < 10 or '-' not in rows[0][6:]:
            raise ValueError('runtime visible mount row unavailable')
        row = rows[0]
        mountpoint = re.sub(r'\\(040|011|012|134)', lambda match: chr(int(match[1], 8)), row[4])
        expected_device = str(os.major(first.st_dev)) + ':' + str(os.minor(first.st_dev))
        if (mountpoint != str(path) or row[2] != expected_device or
                'ro' not in row[5].split(',') or 'rw' in row[5].split(',') or
                not os.fstatvfs(fd).f_flag & os.ST_RDONLY):
            raise ValueError('runtime input parent is not an exact read-only mount')
        after = os.fstat(fd); named = path.lstat()
        if any(getattr(first, key) != getattr(after, key) or getattr(first, key) != getattr(named, key)
               for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode')):
            raise ValueError('runtime input parent changed during mount check')
    finally:
        os.close(fd)

def select_phase():
    run = os.environ.get('CI_RUN_ID', '')
    source = os.environ.get('CI_COMMIT_SHA', '')
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,159}', run):
        raise ValueError('invalid run identity')
    root = Path('/var/lib/custom-ci/runs') / run
    record = root / 'browser-phase.json'
    if not record.exists() and not record.is_symlink():
        return {'phase': 'all', 'runtimeDirectory': '-'}
    # This helper stays adjacent to the authenticated source storage guard.
    spec = importlib.util.spec_from_file_location('fixed_storage', Path(__file__).with_name('check-internal-ci-storage.py'))
    guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    phase = guard.read_finite_attestation(record)
    if (set(phase) != {'version', 'runId', 'sourceSha', 'phase', 'runtimeDirectory',
                      'runtimeIdentity', 'sealedInputs', 'deadlineMonotonic'} or
            phase['version'] != 1 or phase['runId'] != run or phase['sourceSha'] != source or
            not re.fullmatch('[a-f0-9]{40}', source) or phase['phase'] not in ('acquisition', 'runtime') or
            type(phase['deadlineMonotonic']) not in (int, float) or
            not 0 < phase['deadlineMonotonic'] - time.monotonic() <= 9000):
        raise ValueError('invalid fixed owner phase')
    runtime = Path(phase['runtimeDirectory'])
    if not re.fullmatch(r'/tmp/llr\.[A-Za-z0-9]{6}', str(runtime)):
        raise ValueError('unowned short runtime path')
    info = runtime.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or
            stat.S_IMODE(info.st_mode) != 0o700 or runtime.resolve(strict=True) != runtime or
            [info.st_dev, info.st_ino] != phase['runtimeIdentity'] or
            (runtime / 'owner').read_text().strip() != run):
        raise ValueError('owner runtime directory identity changed')
    containers = runtime / 'containers'
    info2 = containers.lstat()
    if (not stat.S_ISDIR(info2.st_mode) or info2.st_uid != os.geteuid() or
            info2.st_dev != info.st_dev or containers.resolve(strict=True) != containers):
        raise ValueError('owner runtime container directory changed')
    qualification = root / 'tmp/job-tmp' / ('lunchlineup-beta-qualification-' + run)
    expected = set() if phase['phase'] == 'acquisition' else {'runtime.env', 'development-compose.json'}
    if type(phase['sealedInputs']) is not dict or set(phase['sealedInputs']) != expected:
        raise ValueError('owner runtime input roster changed')
    if expected:
        require_readonly_mount(qualification)
    for name, pin in phase['sealedInputs'].items():
        path = qualification / name
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            first = os.fstat(fd)
            if (not os.statvfs(path).f_flag & os.ST_RDONLY or not stat.S_ISREG(first.st_mode) or first.st_uid != 0 or first.st_nlink != 1 or
                    stat.S_IMODE(first.st_mode) not in (0o440, 0o444) or
                    set(pin) != {'bytes', 'sha256'} or not 0 < first.st_size == pin['bytes'] <= 1048576):
                raise ValueError('runtime input is not sealed')
            body = os.read(fd, 1048577)
            after = os.fstat(fd); final = path.lstat()
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_mode', 'st_nlink')
            if (len(body) != first.st_size or hashlib.sha256(body).hexdigest() != pin['sha256'] or
                    any(getattr(first, k) != getattr(after, k) or getattr(first, k) != getattr(final, k) for k in fields)):
                raise ValueError('sealed runtime input changed')
        finally:
            os.close(fd)
    return {'phase': phase['phase'], 'runtimeDirectory': str(runtime)}


if __name__ == '__main__':
    value = select_phase()
    print(value['phase'])
    print(value['runtimeDirectory'])
