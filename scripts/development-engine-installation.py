#!/usr/bin/env python3
"""Fixed native engine installation loading; no Manager credential role.

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

ANCHOR = '/etc/lunchlineup/trust/development-engines.json'
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
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (private and info.st_mode & 0o077):
        os.close(fd)
        raise RuntimeError('installation file privacy/type')
    return fd


def pin(value, private=False, maximum=256 * MAX, content=True):
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
        require(type(value) is dict and set(value) == {'version', 'roles', 'policy'} and
                type(value['version']) is int and value['version'] == 1, 'guardian anchor shape')
        roles = {'custodian', 'launcher', 'recovery', 'starter', 'finalizer', 'installation', 'protocol',
                 'authz', 'http', 'history', 'common', 'reader', 'interpreter', 'systemctl', 'daemon', 'containerd', 'docker',
                 'nativeUnit', 'daemonUnit', 'runtimeUnit', 'recoveryUnit', 'pluginSpec', 'guardianInstallation', 'guardianRecoveryHistory'}
        require(type(value['roles']) is dict and set(value['roles']) == roles, 'native engine fixed role set')
        fixed = {'custodian': '/usr/local/libexec/lunchlineup/development-engine-custodian',
                 'launcher': '/usr/local/libexec/lunchlineup/development-engine-launcher',
                 'recovery': '/usr/local/libexec/lunchlineup/development-engine-recovery',
                 'starter': '/usr/local/libexec/lunchlineup/development-engine-starter',
                 'finalizer': '/usr/local/libexec/lunchlineup/development-engine-finalizer',
                 'installation': '/usr/local/libexec/lunchlineup/development-engine-installation.py',
                 'protocol': '/usr/local/libexec/lunchlineup/development-manager-channel.py',
                 'authz': '/usr/local/libexec/lunchlineup/development-engine-authz.py',
                 'http': '/usr/local/libexec/lunchlineup/development-engine-http.py',
                 'history': '/usr/local/libexec/lunchlineup/development-engine-history.py',
                 'common': '/usr/local/libexec/lunchlineup/development-engine-common.py',
                 'reader': '/usr/local/libexec/lunchlineup/development-engine-reader.py',
                 'daemon': '/usr/bin/dockerd', 'containerd': '/usr/bin/containerd', 'docker': '/usr/bin/docker',
                 'systemctl': '/usr/bin/systemctl',
                 'pluginSpec': '/etc/docker/plugins/lunchlineup-readonly.spec',
                 'guardianInstallation': '/usr/local/libexec/lunchlineup/development-guardian-installation.py',
                 'guardianRecoveryHistory': '/usr/local/libexec/lunchlineup/development-guardian-recovery-history.py',
                 'nativeUnit': '/etc/systemd/system/lunchlineup-development-engines.service',
                 'daemonUnit': '/etc/systemd/system/lunchlineup-development-docker.service',
                 'runtimeUnit': '/etc/systemd/system/lunchlineup-development-containerd.service',
                 'recoveryUnit': '/etc/systemd/system/lunchlineup-development-recovery.service'}
        require(all(value['roles'][role]['path'] == path for role, path in fixed.items()), 'native fixed installation path differs')
        require(value['policy']['path'] == '/etc/lunchlineup/native/policy.json', 'fixed native readable policy path')
        require(re.fullmatch(r'/usr/bin/python3\.[0-9]{1,2}', value['roles']['interpreter']['path']), 'native pinned interpreter path')
        return value
    finally:
        os.close(fd)


def load_module(name, fd):
    os.lseek(fd, 0, os.SEEK_SET)
    source = os.read(fd, MAX + 1)
    require(0 < len(source) <= MAX, 'guardian module bound')
    os.lseek(fd, 0, os.SEEK_SET)
    module = types.ModuleType('installed_native_engine_' + name)
    exec(compile(source, '<installed-' + name + '>', 'exec'), module.__dict__)
    return module


if __name__ == '__main__':
    raise SystemExit('Installation library has no public dispatch.')
