#!/usr/bin/env python3
"""Fixed root installation loading shared by guardian starter/main/finalizer.

Only the fixed root-private anchor supplies pins. No command argument/environment
can choose a key, executable, policy, journal or host endpoint.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import types

ANCHOR = '/etc/lunchlineup/trust/development-guardian.json'
MAX = 1048576


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


def parse(data):
    require(0 < len(data) <= MAX, 'installation document bound')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate installation key')
            result[key] = value
        return result
    def invalid(_):
        raise RuntimeError('noninteger installation number')
    return json.loads(data, object_pairs_hook=pairs, parse_float=invalid, parse_constant=invalid)


def controlled(path, private=False):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'noncanonical installation path')
    for part in [path, *path.parents]:
        info = part.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'installation not root controlled')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or (private and info.st_mode & 0o077):
        os.close(fd)
        raise RuntimeError('installation file privacy/type')
    return fd


def pin(value, private=False, maximum=64 * MAX, content=True):
    require(type(value) is dict and set(value) == {'path', 'bytes', 'sha256', 'veritySha256'} and
            type(value['bytes']) is int and 0 < value['bytes'] <= maximum and
            all(type(value[k]) is str and re.fullmatch('[a-f0-9]{64}', value[k]) for k in ['sha256', 'veritySha256']), 'installation pin fields')
    fd = controlled(value['path'], private)
    try:
        info = os.fstat(fd)
        require(info.st_size == value['bytes'], 'installation pin size')
        measured = bytearray(struct.pack('HH', 0, 64) + bytes(64))
        fcntl.ioctl(fd, 0xC0046686, measured, True)
        require(struct.unpack('HH', measured[:4]) == (1, 32) and measured[4:36].hex() == value['veritySha256'], 'installation fs-verity pin')
        if content:
            digest = hashlib.sha256()
            while chunk := os.read(fd, MAX):
                digest.update(chunk)
            require(digest.hexdigest() == value['sha256'], 'installation content pin')
            os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def anchor():
    fd = controlled(ANCHOR, True)
    try:
        data = os.read(fd, MAX + 1)
        value = parse(data)
        require(type(value) is dict and set(value) == {'version', 'roles', 'policy', 'managerKey', 'keyId'} and
                type(value['version']) is int and value['version'] == 1, 'guardian anchor shape')
        roles = {'guardian', 'starter', 'finalizer', 'installation', 'protocol', 'connection', 'workers',
                 'workerEntry', 'broker', 'history', 'supervisorEntry', 'bootstrap', 'sessionCustody',
                 'core', 'interpreter', 'ssh', 'docker', 'unitFile', 'physicalCollector', 'nativeClient', 'recoveryHistory'}
        require(type(value['roles']) is dict and set(value['roles']) in (roles, roles | {'pilotReducer', 'pilotJournal'}) and
                type(value['keyId']) is str and 0 < len(value['keyId']) <= 128, 'guardian role/key identity')
        if 'pilotReducer' in value['roles']:
            require(value['roles']['pilotReducer']['path'] == '/usr/local/libexec/lunchlineup/development-pilot-handoff.py' and
                    value['roles']['pilotJournal']['path'] == '/usr/local/libexec/lunchlineup/development-pilot-journal.py',
                    'fixed optional pilot library role paths')
        return value
    finally:
        os.close(fd)


def load_module(name, fd):
    os.lseek(fd, 0, os.SEEK_SET)
    source = os.read(fd, MAX + 1)
    require(0 < len(source) <= MAX, 'guardian module bound')
    os.lseek(fd, 0, os.SEEK_SET)
    module = types.ModuleType('installed_guardian_' + name)
    exec(compile(source, '<installed-' + name + '>', 'exec'), module.__dict__)
    return module


if __name__ == '__main__':
    raise SystemExit('Installation library has no public dispatch.')
