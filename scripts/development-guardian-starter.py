#!/usr/bin/python3
"""Fixed PID1 entry: verify independent root anchor, exec guardian via FD4.

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
    # Bootstrap just the independent installation library without importing from
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
    guardian = library.pin(authority['roles']['guardian'])
    interpreter = library.pin(authority['roles']['interpreter'])
    installation = library.pin(authority['roles']['installation'])
    # Preserve installation library at FD5 so main can load exactly the pinned
    # bootstrap dependency; FD3 belongs to the later supervisor endpoint.
    copies = [fcntl.fcntl(n, fcntl.F_DUPFD_CLOEXEC, 16) for n in [guardian, interpreter, installation]]
    os.dup2(copies[0], 4, inheritable=True)
    os.dup2(copies[2], 5, inheritable=True)
    notify = os.environ.get('NOTIFY_SOCKET', '')
    if not notify or not notify.startswith(('/', '@')):
        raise RuntimeError('PID1 notify socket absent')
    os.execve('/proc/self/fd/' + str(copies[1]), [authority['roles']['interpreter']['path'], '-I', '/proc/self/fd/4'],
              {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'NOTIFY_SOCKET': notify})


if __name__ == '__main__':
    main()
