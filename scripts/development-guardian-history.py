#!/usr/bin/env python3
"""Private guardian journal and matching worker history grammar.

No MAC key is accepted from or returned to a supervisor. Verification consumes
root-private installed context and records, returning observations only.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import stat

MAX = 1048576


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


class WorkerHistory:
    def __init__(self, p):
        self.p = p
        self.workers = {}
        self.operations = set()
        self.broker = None
        self.broker_count = 0
        self.broker_bytes = 0

    def transition(self, event):
        p = self.p
        p.closed(event, ['type', 'workerNonce', 'body'])
        nonce, kind, body = event['workerNonce'], event['type'], event['body']
        p.sha(nonce)
        if kind == 'prepared':
            require(nonce not in self.workers and len(self.workers) < 2, 'duplicate/excess registered worker')
            p.closed(body, ['workerNonce', 'role', 'contextSha256', 'cgroup', 'cgroupDevice', 'cgroupInode', 'originalDeadlineNs', 'state'])
            require(body['workerNonce'] == nonce and body['state'] == 'PREPARED' and body['role'] in ('archive-preflight', 'image-inventory') and body['role'] not in self.operations, 'worker registration differs')
            p.sha(body['contextSha256']); p.local_nanoseconds(body['originalDeadlineNs'])
            p.integer(body['cgroupDevice'], 0, 2**53 - 1); p.integer(body['cgroupInode'], 0, 2**53 - 1)
            require(type(body['cgroup']) is str and body['cgroup'].startswith('/sys/fs/cgroup/') and '..' not in body['cgroup'].split('/'), 'registered cgroup path')
            if body['role'] == 'image-inventory':
                require(any(w['role'] == 'archive-preflight' and w['phase'] == 'settled' and w['outcome'] == 'observed' for w in self.workers.values()), 'inventory lacks settled preflight')
            self.operations.add(body['role'])
            self.workers[nonce] = dict(body, phase='prepared', diagnostics=0, diagnosticBytes=0, result=None, outcome=None)
            return
        require(nonce in self.workers, 'unregistered worker event')
        worker = self.workers[nonce]
        if kind == 'authenticated':
            p.closed(body, ['type', 'workerNonce', 'pid', 'starttime', 'contextSha256'])
            require(worker['phase'] == 'prepared' and body['type'] == kind and body['workerNonce'] == nonce and body['contextSha256'] == worker['contextSha256'], 'worker authentication context')
            p.integer(body['pid'], 1, 2**31 - 1); p.local_nanoseconds(body['starttime'])
            worker.update(phase='running', pid=body['pid'], starttime=body['starttime'])
        elif kind == 'diagnostic':
            require(worker['phase'] == 'running', 'diagnostic outside worker')
            size = len(p.canonical(body))
            worker['diagnostics'] += 1; worker['diagnosticBytes'] += size
            require(size <= 16384 and worker['diagnostics'] <= 259 and worker['diagnosticBytes'] <= 259 * 16384, 'diagnostic history bound')
        elif kind == 'broker-prepared':
            require(worker['phase'] == 'running' and worker['role'] == 'image-inventory' and self.broker is None, 'broker registration phase')
            p.closed(body, ['command', 'args', 'originalDeadlineNs', 'cgroup', 'cgroupDevice', 'cgroupInode'])
            p.integer(body['command'], self.broker_count + 1, self.broker_count + 1)
            require(body['command'] <= 259 and p.local_nanoseconds(body['originalDeadlineNs']) <= p.local_nanoseconds(worker['originalDeadlineNs']), 'broker original deadline/count')
            self.broker = p.parse(p.canonical(body)); self.broker_count += 1
        elif kind == 'broker-settled':
            require(worker['phase'] == 'running' and self.broker is not None, 'unregistered broker settlement')
            p.closed(body, ['command', 'exitCode', 'cgroupEmpty', 'stdoutBytes', 'stderrBytes', 'stdoutSha256', 'stderrPrefixHex', 'outcome'])
            require(body['command'] == self.broker['command'] and body['cgroupEmpty'] is True and body['outcome'] in ('observed', 'failed'), 'broker settlement differs')
            p.integer(body['exitCode'], -255, 255)
            p.integer(body['stdoutBytes'], 0, MAX); p.integer(body['stderrBytes'], 0, MAX)
            p.sha(body['stdoutSha256'])
            require(type(body['stderrPrefixHex']) is str and len(body['stderrPrefixHex']) <= 8192, 'broker diagnostic prefix bound')
            self.broker_bytes += body['stdoutBytes'] + body['stderrBytes']
            require(self.broker_bytes <= 16 * MAX, 'broker historical output bound')
            if body['outcome'] == 'observed':
                require(body['exitCode'] == 0 and body['stdoutBytes'] < MAX and body['stderrBytes'] < MAX, 'broker success mismatch')
            self.broker = None
        elif kind == 'result':
            require(worker['phase'] == 'running' and self.broker is None and len(p.canonical(body)) <= MAX, 'worker result phase/bound')
            worker['result'] = p.digest(body); worker['phase'] = 'result'
        elif kind == 'settled':
            p.closed(body, ['type', 'workerNonce', 'exitCode', 'cgroupEmpty', 'outcome', 'result'])
            require(worker['phase'] in ('prepared', 'running', 'result') and self.broker is None and
                    body['type'] == kind and body['workerNonce'] == nonce and body['cgroupEmpty'] is True and
                    body['outcome'] in ('observed', 'failed'), 'worker settlement differs')
            p.integer(body['exitCode'], -255, 255)
            if body['outcome'] == 'observed':
                require(worker['phase'] == 'result' and body['exitCode'] == 0 and p.digest(body['result']) == worker['result'], 'worker result/settlement mismatch')
            else:
                require(body['result'] is None, 'failed worker cannot publish success result')
            worker.update(phase='settled', outcome=body['outcome'])
        else:
            raise RuntimeError('unknown worker history event')

    def observation(self):
        settled = all(w['phase'] == 'settled' for w in self.workers.values()) and self.broker is None
        return {'workers': self.workers, 'brokerPending': self.broker is not None, 'settled': settled,
                'brokerCommands': self.broker_count, 'brokerOutputBytes': self.broker_bytes,
                'authorityRestored': False, 'fenceClearAuthorized': False, 'automaticRetryAllowed': False}


class Journal:
    def __init__(self, p, directory, session_id):
        p.sha(session_id)
        self.p = p
        root = Path(directory)
        require(root.is_absolute() and root.resolve(strict=True) == root, 'guardian journal path')
        for part in [root, *root.parents]:
            info = part.lstat()
            require(info.st_uid == 0 and not info.st_mode & 0o022, 'guardian journal custody')
        require(not root.stat().st_mode & 0o077, 'guardian journal must be private')
        self.dirfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        fcntl.flock(self.dirfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        refuse_prior_custody(p, self.dirfd)
        self.name = session_id + '.guardian'
        self.fd = os.open(self.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.dirfd)
        os.fsync(self.dirfd)
        self.sequence = self.bytes = 0
        self.previous = '0' * 64
        self.failed = False
        self.workers = WorkerHistory(p)

    def append(self, kind, body):
        require(not self.failed, 'guardian journal poisoned')
        try:
            value = {'sequence': self.sequence, 'previous': self.previous, 'kind': kind, 'body': body}
            data = self.p.canonical(value) + b'\n'
            # Separate bounded worker evidence reserve, not lease renewal budget.
            require(len(data) <= MAX + 1024 and self.bytes + len(data) <= 16 * MAX and self.sequence < 4096, 'guardian history bound')
            if kind == 'WORKER':
                self.workers.transition(body)
            pending = memoryview(data)
            while pending:
                count = os.write(self.fd, pending)
                require(count > 0, 'guardian journal short write')
                pending = pending[count:]
            os.fsync(self.fd)
            self.previous = hashlib.sha256(data).hexdigest()
            self.sequence += 1; self.bytes += len(data)
            return self.previous
        except BaseException:
            self.failed = True
            raise


def verify_worker_history(p, records):
    """Used inside protected full guardian-history verification, never authority."""
    history = WorkerHistory(p)
    for record in records:
        history.transition(record)
    return history.observation()

def private_snapshot(p, dirfd, name):
    """Exact protected file, stable full bytes; no path supplied over IPC."""
    require('/' not in name and name not in ('.', '..'), 'private basename required')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dirfd)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and
                before.st_nlink == 1 and not before.st_mode & 0o077, 'private history metadata')
        data = bytearray()
        while len(data) <= 16 * MAX:
            block = os.read(fd, min(65536, 16 * MAX + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
        signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        require(signature(before) == signature(after) == signature(named) and len(data) <= 16 * MAX,
                'protected file changed or exceeded bound')
        return bytes(data)
    finally:
        os.close(fd)


def chain_snapshot(p, dirfd, name):
    raw = private_snapshot(p, dirfd, name)
    require(raw and raw.endswith(b'\n'), 'partial protected journal')
    lines = raw.splitlines(keepends=True)
    require(len(lines) <= 4096, 'protected journal record bound')
    previous = '0' * 64
    rows = []
    for sequence, line in enumerate(lines):
        row = p.parse(line[:-1], MAX + 1024)
        p.closed(row, ['sequence', 'previous', 'kind', 'body'])
        require(type(row['sequence']) is int and row['sequence'] == sequence and
                row['previous'] == previous and p.canonical(row) + b'\n' == line, 'protected journal chain')
        previous = hashlib.sha256(line).hexdigest()
        rows.append({'recordSha256': previous, 'row': row})
    return {'rows': rows, 'lastSha256': previous, 'sha256': hashlib.sha256(raw).hexdigest()}


def refuse_prior_custody(p, dirfd):
    # Directory flock is held before this scan and for the entire guardian.
    # Any prior evidence requires owner reconciliation, even completed local
    # retirement: a lost last reply can still leave the host unresolved. Never
    # infer new admission from active.fence absence or a historical signed notice.
    names = os.listdir(dirfd)
    require(len(names) <= 2048, 'prior custody inventory bound')
    for name in names:
        if name.endswith('.guardian'):
            p.sha(name[:-9])
            chain_snapshot(p, dirfd, name)
    require(not names, 'prior guardian custody/WAL requires separate owner recovery; automatic retry refused')


if __name__ == '__main__':
    raise SystemExit('Guardian history is private; no caller-selected history/key interface.')
