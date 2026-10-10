#!/usr/bin/env python3
"""Fixed private native custody WAL. No repair, cleanup or retry API."""
import fcntl
import hashlib
import os
from pathlib import Path
import stat

MAX = 1048576
DIRECTORY = '/var/lib/lunchlineup/engine-custody'


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def directory():
    root = Path(DIRECTORY)
    require(root.resolve(strict=True) == root, 'native history path canonical custody')
    for part in [root, *root.parents]:
        info = part.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'native history parent custody')
    require(stat.S_IMODE(root.stat().st_mode) == 0o700, 'native history root-private directory required')
    return os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


def read_file(dirfd, name, maximum=16 * MAX):
    require('/' not in name and name not in ('.', '..'), 'native private basename')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dirfd)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and
                before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600, 'native evidence file custody')
        data = bytearray()
        while len(data) <= maximum:
            block = os.read(fd, min(65536, maximum + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
        signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        require(signature(before) == signature(after) == signature(named) and len(data) <= maximum,
                'native evidence changed or exceeded bound')
        return bytes(data)
    finally:
        os.close(fd)


def read_chain(p, dirfd, name):
    require(name.endswith('.native'), 'native history role')
    p.sha(name[:-7])
    raw = read_file(dirfd, name)
    require(raw and raw.endswith(b'\n'), 'native history partial')
    lines = raw.splitlines(keepends=True)
    require(len(lines) <= 8192, 'native history record bound')
    previous = '0' * 64; rows = []
    for sequence, line in enumerate(lines):
        row = p.parse(line[:-1])
        p.closed(row, ['sequence', 'previous', 'event', 'body'])
        require(type(row['sequence']) is int and row['sequence'] == sequence and row['previous'] == previous and
                p.canonical(row) + b'\n' == line, 'native canonical history chain differs')
        previous = hashlib.sha256(line).hexdigest()
        rows.append({'recordSha256': previous, 'row': row})
    return {'rows': rows, 'lastSha256': previous, 'sha256': hashlib.sha256(raw).hexdigest()}


class Journal:
    def __init__(self, p, generation, fence):
        self.p = p; p.sha(generation)
        self.dirfd = directory()
        fcntl.flock(self.dirfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        names = os.listdir(self.dirfd)
        require(len(names) <= 8192, 'native retained inventory bound')
        for name in names:
            if name.endswith('.native'):
                read_chain(p, self.dirfd, name)
        require(not names, 'prior native custody requires explicit exact-target owner recovery')
        self.name = generation + '.native'
        self.fd = os.open(self.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                          0o600, dir_fd=self.dirfd)
        self.sequence = self.bytes = self.response_bytes = self.responses = 0
        self.previous = '0' * 64; self.failed = False
        self.fence_bytes = p.canonical(fence) + b'\n'
        self.fence_fd = os.open('native.active', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                               0o600, dir_fd=self.dirfd)
        self.write_all(self.fence_fd, self.fence_bytes)
        os.fsync(self.fence_fd); os.fsync(self.dirfd)
        self.append('NATIVE_FENCE_CREATED', {'fence': fence, 'fenceSha256': hashlib.sha256(self.fence_bytes).hexdigest(),
            'device': str(os.fstat(self.fence_fd).st_dev), 'inode': str(os.fstat(self.fence_fd).st_ino)})

    @staticmethod
    def write_all(fd, data):
        left = memoryview(data)
        while left:
            count = os.write(fd, left)
            require(count > 0, 'native evidence short write')
            left = left[count:]

    def append(self, event, body):
        require(not self.failed, 'native WAL poisoned')
        try:
            row = {'sequence': self.sequence, 'previous': self.previous, 'event': event, 'body': body}
            data = self.p.canonical(row) + b'\n'
            require(len(data) <= MAX and self.sequence < 8192 and self.bytes + len(data) <= 16 * MAX,
                    'native WAL capacity exhausted')
            self.write_all(self.fd, data); os.fsync(self.fd)
            self.previous = hashlib.sha256(data).hexdigest()
            self.sequence += 1; self.bytes += len(data)
            return self.previous
        except BaseException:
            self.failed = True
            raise

    def retain_response(self, number, data):
        self.p.integer(number, 1, 8192)
        require(not self.failed and len(data) < MAX and self.responses < 8192 and
                self.response_bytes + len(data) <= 32 * MAX, 'native retained response capacity')
        name = self.name[:-7] + '.response-' + str(number)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=self.dirfd)
        try:
            self.write_all(fd, data); os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self.dirfd)
        self.responses += 1; self.response_bytes += len(data)
        return {'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def snapshot(self):
        value = read_chain(self.p, self.dirfd, self.name)
        require(len(value['rows']) == self.sequence and value['lastSha256'] == self.previous,
                'current native WAL differs from owner memory')
        return value


if __name__ == '__main__':
    raise SystemExit('Native private history has no repair or cleanup command.')
