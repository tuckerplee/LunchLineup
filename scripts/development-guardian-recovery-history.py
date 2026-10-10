"""KPT177 source-only dead-owner history reconciliation; never authority.

Only the independently pinned recovery entry may call observe. No CLI or key
API. Protected-owner evidence equality is NOT cryptographic MAC re-verification.
Native linkage uses172's closed supplement. Fixed entry/profile and native
reader/producer installation remain guest-owned prerequisites, never fabricated.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import select
import subprocess
import time

MAX = 1048576
UNIT = 'lunchlineup-development-guardian.service'


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


def refuse(why):
    raise RuntimeError(why)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class Snapshot:
    """Read-only held/named private snapshots, with final repeat-read checks."""
    def __init__(self):
        self.directories = []
        self.files = []
        self.end = time.monotonic_ns() + 60_000_000_000

    def budget(self):
        require(time.monotonic_ns() < self.end, 'recovery original source deadline')

    def directory(self, path, lock=False, private=True):
        self.budget()
        path = Path(path)
        require(path.is_absolute() and path.resolve(strict=True) == path, 'canonical recovery directory')
        for parent in [path, *path.parents]:
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                    'root-controlled recovery directory')
        require(not private or stat.S_IMODE(path.lstat().st_mode) == 0o700, 'private recovery directory mode')
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        self.directories.append((fd, path, os.fstat(fd)))
        if lock:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.flock(fd)
        return fd

    def flock(self, fd):
        info = os.fstat(fd)
        with open('/proc/self/fdinfo/' + str(fd), 'rb') as source:
            raw = source.read(8193)
        require(len(raw) <= 8192, 'recovery flock evidence bound')
        rows = [line.split() for line in raw.decode().splitlines() if line.startswith('lock:')]
        require(len(rows) == 1 and len(rows[0]) == 9 and
                rows[0][2:6] == ['FLOCK', 'ADVISORY', 'WRITE', str(os.getpid())] and
                rows[0][7:] == ['0', 'EOF'], 'recovery directory actual kernel flock custody')
        identity = rows[0][6].split(':')
        require(len(identity) == 3 and (int(identity[0], 16), int(identity[1], 16), int(identity[2])) ==
                (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino), 'recovery directory flock inode')

    @staticmethod
    def signature(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def file(self, directory, name, maximum):
        self.budget()
        require(type(name) is str and '/' not in name and name not in ('', '.', '..'), 'fixed protected basename')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and before.st_nlink == 1 and
                    stat.S_IMODE(before.st_mode) == 0o600 and before.st_size <= maximum, 'protected file custody')
            data = self.read_fd(fd, maximum)
            require(self.signature(before) == self.signature(os.fstat(fd)) ==
                    self.signature(os.stat(name, dir_fd=directory, follow_symlinks=False)), 'protected file changed')
            self.files.append((fd, directory, name, before, data, maximum))
            return data, before
        except BaseException:
            os.close(fd)
            raise

    def read_fd(self, fd, maximum):
        os.lseek(fd, 0, os.SEEK_SET)
        result = bytearray()
        while len(result) <= maximum:
            self.budget()
            chunk = os.read(fd, min(65536, maximum + 1 - len(result)))
            if not chunk:
                break
            result.extend(chunk)
        require(len(result) <= maximum, 'protected read bound')
        return bytes(result)

    def stable(self, locked):
        self.budget()
        self.flock(locked)
        for fd, path, info in self.directories:
            require(self.signature(info) == self.signature(os.fstat(fd)) == self.signature(path.lstat()),
                    'recovery directory changed')
        for fd, parent, name, info, data, maximum in self.files:
            require(self.signature(info) == self.signature(os.fstat(fd)) ==
                    self.signature(os.stat(name, dir_fd=parent, follow_symlinks=False)) and
                    self.read_fd(fd, maximum) == data, 'protected snapshot no longer stable')

    def close(self):
        for fd, *_ in self.files:
            os.close(fd)
        for fd, *_ in reversed(self.directories):
            os.close(fd)


def names(fd, limit):
    result = set()
    with os.scandir(fd) as entries:
        for entry in entries:
            require(len(result) < limit and entry.name not in result, 'protected namespace bound')
            result.add(entry.name)
    return result


def chain(p, raw, maximum, fields, kind, *, budget):
    require(type(raw) is bytes and 0 < len(raw) <= maximum and raw.endswith(b'\n'), 'partial protected chain')
    lines = raw.splitlines(keepends=True)
    require(len(lines) <= 4096, 'protected chain row bound')
    previous = '0' * 64
    result = []
    for index, line in enumerate(lines):
        budget()
        require(line.endswith(b'\n') and len(line) <= MAX + 1024, 'protected row size')
        row = p.parse(line[:-1], MAX + 1024)
        p.closed(row, fields)
        require(type(row['sequence']) is int and row['sequence'] == index and row['previous'] == previous and
                p.canonical(row) + b'\n' == line and type(row[kind]) is str, 'protected canonical chain linkage')
        previous = digest(line)
        result.append({'row': row, 'recordSha256': previous, 'line': line})
    return result


def dead(pid, start, original_boot):
    require(type(pid) is int and 0 < pid < 2**31 and type(start) is str and start.isascii() and start.isdigit(),
            'registered process identity')
    with open('/proc/sys/kernel/random/boot_id', 'rb') as source:
        current_boot = source.read(128).decode().strip()
    if current_boot != original_boot:
        return  # Boot change is used only for death, never to adopt old evidence.
    try:
        with open('/proc/' + str(pid) + '/stat', 'rb') as source:
            raw = source.read(8193)
    except FileNotFoundError:
        return
    require(len(raw) <= 8192, 'registered process stat bound')
    actual = raw.decode().rsplit(')', 1)[1].split()[19]
    require(actual != start, 'original registered owner/worker still exists')


def empty_cgroup(path, expected=None, *, budget):
    budget()
    path = Path(path)
    require(str(path).startswith('/sys/fs/cgroup/') and path.resolve(strict=True) == path, 'exact registered cgroup')
    for parent in [path, *path.parents]:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                'registered cgroup custody')
    root = path.stat()
    require(expected is None or (root.st_dev, root.st_ino) == expected, 'registered cgroup replaced')
    pending = [path]
    count = 0
    while pending:
        budget()
        current = pending.pop(); count += 1
        info = current.lstat()
        require(count <= 16 and stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
                not info.st_mode & 0o022, 'recursive cgroup bound/custody')
        for name, maximum in [('cgroup.events', 4096), ('cgroup.procs', 4096)]:
            with open(current / name, 'rb') as source:
                raw = source.read(maximum + 1)
            require(len(raw) <= maximum, 'cgroup observation bound')
            if name == 'cgroup.events':
                require(b'populated 0\n' in raw, 'registered subtree still populated')
            else:
                require(not raw.strip(), 'registered processes remain')
        with os.scandir(current) as children:
            for child in children:
                if child.is_dir(follow_symlinks=False):
                    require(len(pending) < 16, 'recursive cgroup queue bound')
                    pending.append(Path(child.path))
    require((root.st_dev, root.st_ino) == (path.stat().st_dev, path.stat().st_ino), 'cgroup changed during observation')


class ProtectedFrames:
    """Exact original owner-evidence lookup, explicitly NOT an Authenticator."""
    def __init__(self, p, key_id, outgoing, incoming):
        self.p, self.key_id = p, key_id
        self.records = {'supervisor-to-manager': outgoing, 'manager-to-supervisor': incoming}
        self.counts = {key: 0 for key in self.records}

    def inspect(self, raw, direction):
        p = self.p
        value = p.parse(raw)
        p.closed(value, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
        index = self.counts[direction]
        require(type(value['version']) is int and value['version'] == 1 and value['domain'] == p.ADMISSION_DOMAIN and
                value['direction'] == direction and value['keyId'] == self.key_id and
                type(value['sequence']) is int and value['sequence'] == index, 'protected envelope metadata sequence')
        p.sha(value['mac'])
        require(index < len(self.records[direction]) and value == self.records[direction][index],
                'frame lacks exact retained key-owning guardian decision')
        return value['payload']

    def consume(self, direction):
        self.counts[direction] += 1


def native_observation(p, reader, binding):
    value = reader.observe(binding)
    p.closed(value, ['version', 'binding', 'mode', 'generation', 'engineIdentitySha256', 'nativeHistorySha256',
                     'birthRecordSha256', 'nativeOwnerAlive', 'enginesAlive', 'writerExclusionVerified',
                     'pendingRequests', 'unknownRequests', 'mutationRequestsDispatched', 'activeRequestHandles',
                     'authorityRestored', 'fenceClearAuthorized', 'automaticRetryAllowed'])
    require(type(value['version']) is int and value['version'] == 1 and value['binding'] == binding and
            value['mode'] in ('live-native-owner', 'retained-native-wal'), 'native exact source-owned observation')
    for key in ['generation', 'engineIdentitySha256', 'nativeHistorySha256', 'birthRecordSha256']:
        p.sha(value[key])
    alive = value['mode'] == 'live-native-owner'
    require(value['nativeOwnerAlive'] is alive and value['enginesAlive'] is alive and
            value['writerExclusionVerified'] is True and type(value['activeRequestHandles']) is list and
            value['activeRequestHandles'] == [] and all(type(value[k]) is int and value[k] == 0 for k in
            ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched']) and
            all(value[k] is False for k in ['authorityRestored', 'fenceClearAuthorized', 'automaticRetryAllowed']),
            'native unknown/pending/mixed/unconfined state')
    return value


def control_history(primitives, frames, core_bytes, exchange_bytes, expected, *, worker_records=None, budget, lifetime=None):
    """Replay accepted163 core/exchange grammar using protected owner evidence.

    No key access, MAC re-verification or authority is implemented here. Exact
    signed frames must match the original private guardian decisions. Historical
    reducer state is diagnostic only. No new dead-owner attestation is required.
    """
    p = primitives
    p.closed(expected, ['nonce', 'requestSha256', 'inputTableSha256', 'epochProofSha256', 'policy'])
    for name in ['nonce', 'requestSha256', 'inputTableSha256', 'epochProofSha256']:
        p.sha(expected[name])
    def rows(blob):
        if type(blob) is not bytes or not 0 < len(blob) <= 4 * MAX or not blob.endswith(b'\n'):
            refuse('partial or oversized historical journal')
        lines = blob.splitlines(keepends=True)
        if len(lines) > 4096:
            refuse('historical journal record count')
        result = []
        for line in lines:
            budget()
            value = p.parse(line[:-1])
            if p.canonical(value) + b'\n' != line:
                refuse('historical row not canonical')
            result.append((value, line))
        return result
    core_rows = rows(core_bytes)
    exchange_rows = rows(exchange_bytes)
    previous = '0' * 64
    context = None
    controls = []
    terminal_hash = terminal_details = ack_details = release = None
    phase = 'RESERVE'
    worker_phases = {}
    readonly_terminal = None
    # Supplied only from the guardian's independently validated journal order,
    # never from core link order. Snapshot the exact protected event sequence.
    protected_workers = [] if worker_records is None else worker_records
    if type(protected_workers) is not list or len(protected_workers) > 4096:
        refuse('ordered protected worker sequence required')
    protected_workers = p.parse(p.canonical({'records': protected_workers}), 16 * MAX)['records']
    protected_ids = set()
    for record in protected_workers:
        budget()
        p.closed(record, ['guardianRecordSha256', 'event'])
        identity = p.sha(record['guardianRecordSha256'])
        if identity in protected_ids:
            refuse('reused protected worker record identity')
        protected_ids.add(identity)
    worker_cursor = 0
    for index, (row, raw) in enumerate(core_rows):
        budget()
        p.closed(row, ['sequence', 'previous', 'event', 'details'])
        p.integer(row['sequence'], index, index)
        if row['previous'] != previous:
            refuse('historical core chain differs')
        previous = hashlib.sha256(raw).hexdigest()
        event, details = row['event'], row['details']
        if phase == 'RESERVE':
            if event != 'RESERVED' or details != {'requestSha256': expected['requestSha256'], 'nonce': expected['nonce']}:
                refuse('historical reservation differs')
            phase = 'CONTEXT'
        elif phase == 'CONTEXT':
            if event != 'LEASE_CONTEXT':
                refuse('missing historical custody context')
            p.closed(details, ['request', 'epoch', 'policy', 'requestSentNs', 'unitDeadlineNs'])
            if details['request']['nonce'] != expected['nonce'] or details['request']['requestSha256'] != expected['requestSha256'] or details['request']['inputTableSha256'] != expected['inputTableSha256'] or p.digest(details['epoch']) != expected['epochProofSha256'] or p.canonical(details['policy']) != p.canonical(expected['policy']):
                refuse('historical context differs from independent selection')
            context = details
            phase = 'CONTROL'
        elif phase == 'CONTROL' and event == 'LEASE_CONTROL':
            p.closed(details, ['direction', 'observedNs', 'envelopeSha256', 'payload'])
            p.sha(details['envelopeSha256'])
            p.local_nanoseconds(details['observedNs'])
            controls.append(details)
        elif phase == 'CONTROL' and event == 'WORKER_EVENT':
            p.closed(details, ['workerNonce', 'type', 'eventSha256', 'guardianRecordSha256', 'phase'])
            p.sha(details['workerNonce']); p.sha(details['eventSha256']); p.sha(details['guardianRecordSha256'])
            if worker_cursor >= len(protected_workers):
                refuse('core worker links exceed protected event sequence')
            linked = protected_workers[worker_cursor]
            protected = linked['event']
            if linked['guardianRecordSha256'] != details['guardianRecordSha256'] or p.digest(protected) != details['eventSha256'] or protected['workerNonce'] != details['workerNonce'] or protected['type'] != details['type']:
                refuse('worker core record lacks protected guardian history binding')
            previous_phase = worker_phases.get(details['workerNonce'])
            kind = details['type']
            wanted = {'prepared': 'prepared', 'authenticated': 'running', 'result': 'result', 'settled': 'settled'}.get(kind, previous_phase)
            allowed = {'prepared': None, 'authenticated': 'prepared', 'result': 'running', 'settled': 'result',
                       'diagnostic': 'running', 'broker-prepared': 'running', 'broker-settled': 'running'}
            if kind not in allowed or previous_phase != allowed[kind] or details['phase'] != wanted:
                refuse('worker history phase differs')
            worker_phases[details['workerNonce']] = wanted
            worker_cursor += 1
        elif phase == 'CONTROL' and event == 'READONLY_TERMINAL':
            if worker_cursor != len(protected_workers):
                refuse('completed read-only terminal omits protected worker events')
            p.closed(details, ['outcome', 'workerSummarySha256', 'preflightSha256', 'inventorySha256',
                               'mutationRequestsDispatched', 'authorityRestored', 'fenceClearAuthorized'])
            if not worker_phases or any(value != 'settled' for value in worker_phases.values()) or details['outcome'] != 'readonly-observed' or details['workerSummarySha256'] != p.digest(worker_phases) or type(details['mutationRequestsDispatched']) is not int or details['mutationRequestsDispatched'] != 0 or details['authorityRestored'] is not False or details['fenceClearAuthorized'] is not False:
                refuse('read-only terminal differs or workers unsettled')
            p.sha(details['preflightSha256']); p.sha(details['inventorySha256'])
            readonly_terminal = details
            terminal_hash, terminal_details = previous, details
            phase = 'ACK'
        elif phase == 'CONTROL' and event == 'TERMINAL':
            if protected_workers or worker_phases or p.canonical(details) != p.canonical({'outcome': 'no-execution', 'cliSettled': True, 'daemonRequestsDispatched': 0, 'survivors': []}):
                refuse('unsupported historical terminal work')
            terminal_hash, terminal_details = previous, details
            phase = 'ACK'
        elif phase == 'ACK' and event == 'ACK':
            ack_details = details
            phase = 'RELEASE'
        elif phase == 'RELEASE' and event == 'GUARDIAN_RELEASE':
            p.closed(details, ['nonce', 'requestSha256', 'guardianSessionId', 'ackSha256', 'fenceReceiptSha256'])
            p.sha(details['fenceReceiptSha256'])
            if details['nonce'] != expected['nonce'] or details['requestSha256'] != expected['requestSha256'] or details['guardianSessionId'] != context['epoch']['guardianSessionId'] or details['ackSha256'] != p.digest(ack_details):
                refuse('historical guardian release differs')
            release = details
            phase = 'DONE'
        else:
            refuse('unsupported or out-of-order core history')
    if context is None:
        refuse('partial history lacks custody context')
    state = p.LeaseProtocol(context['request'], context['epoch'], context['policy'],
                             p.local_nanoseconds(context['requestSentNs']), p.local_nanoseconds(context['unitDeadlineNs']))
    auth = frames
    control_index = 0
    wire_phase = 'BOOTSTRAP'
    terminal = manager_ack = None
    # Reconstruct byte reservations from actual historical wrappers. A failure
    # is retained unresolved history, not a retroactive grant or truncated log.
    budgets = {'exchange': p.JournalBudget(0), 'core': p.JournalBudget(0)}
    for index, (row, raw) in enumerate(exchange_rows):
        budget()
        p.closed(row, ['direction', 'message'])
        if wire_phase == 'BOOTSTRAP':
            if index != 0 or row['direction'] != 'bootstrap':
                refuse('historical bootstrap missing')
            p.closed(row['message'], ['inputTable', 'requestSha256'])
            if row['message']['requestSha256'] != expected['requestSha256'] or p.digest(row['message']['inputTable']) != expected['inputTableSha256'] or len(raw) > 512 * 1024:
                refuse('historical input table differs')
            wire_phase = 'REQUEST'
            continue
        if row['direction'] not in ('supervisor', 'manager'):
            refuse('historical exchange direction')
        direction = 'supervisor-to-manager' if row['direction'] == 'supervisor' else 'manager-to-supervisor'
        envelope = row['message']
        payload = auth.inspect(p.canonical(envelope), direction)
        auth.consume(direction)
        kind = payload.get('type')
        if wire_phase == 'REQUEST':
            if direction != 'supervisor-to-manager' or p.canonical(payload) != p.canonical(context['request']):
                refuse('historical request/context differs')
            wire_phase = 'CONTROL'
        elif wire_phase == 'CONTROL' and kind in ('GRANT', 'SESSION_BIND', 'RENEW', 'RENEWED', 'REVOKE'):
            if control_index >= len(controls):
                refuse('authenticated frame lacks durable core transition')
            details = controls[control_index]
            if details['direction'] != direction or details['envelopeSha256'] != p.digest(envelope) or p.canonical(details['payload']) != p.canonical(payload):
                refuse('exchange/core transition mismatch')
            state.transition(direction, payload, p.local_nanoseconds(details['observedNs']))
            control_index += 1
        elif wire_phase == 'CONTROL' and direction == 'supervisor-to-manager' and kind == 'TERMINAL':
            if terminal_hash is None or state.state != 'BOUND' or state.pending is not None:
                refuse('terminal without settled bound control lease')
            grant = state.grant
            wanted = {'type': 'TERMINAL', 'nonce': expected['nonce'], 'requestSha256': expected['requestSha256'],
                      'ledgerSha256': terminal_hash, 'outcome': terminal_details['outcome'], 'grantId': grant['grantId'],
                      'managerEpoch': grant['managerEpoch'], 'grantSequence': state.sequence, 'guestBootId': grant['guestBootId']}
            if p.canonical(payload) != p.canonical(wanted):
                refuse('terminal identity/ledger differs')
            terminal = payload
            wire_phase = 'ACK'
        elif wire_phase == 'ACK' and direction == 'manager-to-supervisor' and kind == 'ACK':
            wanted = {key: value for key, value in terminal.items() if key != 'outcome'}
            wanted['type'] = 'ACK'
            if p.canonical(payload) != p.canonical(wanted) or p.canonical(payload) != p.canonical(ack_details):
                refuse('historical ACK differs or is partially committed')
            manager_ack = payload
            wire_phase = 'DONE'
        else:
            refuse('unexpected historical authenticated message')
    if control_index != len(controls) or (terminal is None) != (terminal_details is None) or (manager_ack is None) != (ack_details is None):
        refuse('partial core/exchange control or terminal commit')
    # Exact historical budget replay is independent for each canonical journal.
    for name, source in [('exchange', exchange_rows), ('core', core_rows)]:
        journal_budget = budgets[name]
        tail = False
        tail_bytes = 0
        for row, raw in source:
            budget()
            if name == 'exchange':
                envelope = row['message']
                payload = envelope.get('payload', {})
                wire_size = len(p.canonical(envelope))
            else:
                details = row['details']
                payload = details.get('payload', {}) if row['event'] == 'LEASE_CONTROL' else {}
                wire_size = len(p.canonical(payload))
            kind = payload.get('type')
            starts_tail = kind in ('REVOKE', 'TERMINAL', 'ACK') or (name == 'core' and row['event'] in ('TERMINAL', 'ACK', 'GUARDIAN_RELEASE', 'READONLY_TERMINAL'))
            if starts_tail and not tail:
                tail = True
                if journal_budget.pending_bytes is not None:
                    journal_budget.used += journal_budget.pending_bytes
                    journal_budget.pending_bytes = None
            if tail:
                tail_bytes += len(raw)
                journal_budget.used += len(raw)
                if tail_bytes > MAX or journal_budget.used > 4 * MAX:
                    refuse('historical terminal tail exceeds reserve')
            elif kind == 'RENEW':
                journal_budget.begin_pair(wire_size, len(raw))
            elif kind == 'RENEWED':
                journal_budget.end_pair(wire_size, len(raw))
            else:
                journal_budget.reserve_other(len(raw))
    if lifetime is not None:
        require(terminal is not None and state.expiry_ns is not None, 'complete terminal historical lifetime required')
        lifetime['terminalDeadlineNs'] = min(state.expiry_ns, state.overall_ns, p.local_nanoseconds(context['unitDeadlineNs']))
    return {'kind': 'verified-historical-control-observation', 'nonce': expected['nonce'],
            'requestSha256': expected['requestSha256'], 'historicalControlState': state.state,
            'terminal': terminal, 'managerAck': manager_ack, 'guardianReleaseRecord': release,
            'readonlyTerminal': readonly_terminal, 'workerPhases': worker_phases,
            'pairedWorkerCoverage': {'status': 'complete-terminal' if readonly_terminal is not None or terminal is not None else 'partial-prefix',
                                     'consumed': worker_cursor, 'protected': len(protected_workers),
                                     'complete': (readonly_terminal is not None or terminal is not None) and worker_cursor == len(protected_workers)},
            'outcome': ('manager-acknowledged-' + terminal['outcome']) if manager_ack else 'unresolved',
            'coreSha256': hashlib.sha256(core_bytes).hexdigest(),
            'exchangeSha256': hashlib.sha256(exchange_bytes).hexdigest(),
            'authorityRestored': False, 'fenceClearAuthorized': False, 'automaticRetryAllowed': False}


def envelope(p, value, key_id, domain, direction):
    p.closed(value, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
    require(type(value['version']) is int and value['version'] == 1 and value['domain'] == domain and
            value['direction'] == direction and value['keyId'] == key_id and type(value['payload']) is dict,
            'protected envelope metadata')
    p.integer(value['sequence'], 0, 4096); p.sha(value['mac'])
    return value['payload']  # NO MAC verification claim.


def pinned_json(p, installation, pin):
    fd = installation.pin(pin, True, MAX)
    try:
        data = os.read(fd, MAX + 1)
        require(0 < len(data) <= MAX, 'private policy bound')
        return p.parse(data)
    finally:
        os.close(fd)


def worker_reconciliation(p, history, broker, rows, policy, expected, snapshot, journal_fd):
    workers = history.WorkerHistory(p)
    protected, contexts, responses, prepared = [], {}, [], None
    manifest, results, actors, slots = [], {}, [], []
    for record in rows:
        snapshot.budget()
        kind, body = record['row']['kind'], record['row']['body']
        if kind == 'WORKER_CONTEXT':
            p.closed(body, ['role', 'workerNonce', 'requestSha256', 'selectionSha256', 'grantId', 'managerEpoch',
                            'guardianSessionId', 'originalDeadlineNs', 'inputTable', 'operation'])
            nonce = p.sha(body['workerNonce'])
            require(nonce not in contexts and len(contexts) < 2 and body['role'] in ('archive-preflight', 'image-inventory'),
                    'duplicate/foreign full worker context')
            for key in ['requestSha256', 'selectionSha256', 'grantId', 'managerEpoch', 'guardianSessionId']:
                require(body[key] == expected[key], 'worker exact original context binding')
            p.local_nanoseconds(body['originalDeadlineNs'])
            require(type(body['inputTable']) is dict and 1 <= len(body['inputTable']) <= 64,
                    'worker immutable input table bound')
            candidate = policy['candidate']
            require(set(body['inputTable']) == set(candidate['inputs']) | {'protocol'}, 'worker full input coverage')
            for name, item in body['inputTable'].items():
                p.closed(item, ['bytes', 'sha256', 'veritySha256', 'device', 'inode'])
                pin = expected['protocolPin'] if name == 'protocol' else candidate['inputs'][name]
                require(all(item[key] == pin[key] for key in ['bytes', 'sha256', 'veritySha256']), 'worker input pin linkage')
                p.integer(item['device'], 0, 2**53 - 1); p.integer(item['inode'], 1, 2**53 - 1)
            if body['role'] == 'archive-preflight':
                require(body['operation'] == {'policy': candidate['policy']}, 'preflight candidate policy differs')
            else:
                require('archive-preflight' in results, 'inventory context before complete preflight')
                require(body['operation'] == {'preflight': results['archive-preflight'], 'binding': dict(
                    candidate['inventoryBinding'], preflightSha256=results['archive-preflight']['sha256'])},
                    'inventory preflight/binding differs')
            contexts[nonce] = body
        elif kind == 'WORKER':
            workers.transition(body)
            protected.append({'guardianRecordSha256': record['recordSha256'], 'event': body})
            nonce, event = body['workerNonce'], body['type']
            require(nonce in contexts, 'worker event without full original context')
            context = contexts[nonce]
            detail = body['body']
            if event == 'prepared':
                require(detail['contextSha256'] == p.digest(context) and detail['role'] == context['role'] and
                        detail['originalDeadlineNs'] == context['originalDeadlineNs'] and
                        detail['cgroup'] == policy['workerCgroup']['path'], 'worker registration/context differs')
                slots.append((detail['cgroup'], (detail['cgroupDevice'], detail['cgroupInode'])))
            elif event == 'authenticated':
                actors.append((detail['pid'], detail['starttime']))
            elif event == 'broker-prepared':
                require(prepared is None and detail['cgroup'] == policy['brokerCgroup']['path'], 'overlapping/foreign broker')
                prepared = (record['recordSha256'], body)
                slots.append((detail['cgroup'], (detail['cgroupDevice'], detail['cgroupInode'])))
            elif event == 'broker-settled':
                require(prepared is not None and prepared[1]['workerNonce'] == nonce and detail['outcome'] == 'observed',
                        'incomplete/failed broker response')
                manifest.append((prepared, (record['recordSha256'], body)))
                prepared = None
            elif event == 'settled':
                require(detail['outcome'] == 'observed', 'failed worker remains unresolved')
                results[context['role']] = detail['result']
        elif kind == 'BROKER_RESPONSE':
            p.closed(body, ['workerNonce', 'command', 'name', 'bytes', 'sha256'])
            require(len(responses) < 259 and len(manifest) == len(responses) + 1, 'response/settlement ordering differs')
            index = len(responses) + 1
            settled = manifest[-1][1][1]
            require(body['command'] == index and body['name'] == expected['localSessionId'] + '.response-' + str(index) and
                    body['workerNonce'] == settled['workerNonce'], 'exact response name/worker/command')
            raw, _ = snapshot.file(journal_fd, body['name'], MAX)
            require(len(raw) == body['bytes'] == settled['body']['stdoutBytes'] < MAX and
                    digest(raw) == body['sha256'] == settled['body']['stdoutSha256'], 'full protected response bytes differ')
            responses.append((body, raw))
    observed = workers.observation()
    require(observed['settled'] is True and observed['brokerPending'] is False and prepared is None and
            len(manifest) == len(responses) == observed['brokerCommands'] and
            sum(len(raw) for _, raw in responses) <= 16 * MAX and set(contexts) == set(observed['workers']),
            'incomplete worker/broker/response coverage')
    if policy['workflow'] == 'no-execution':
        require(not protected and not contexts and not responses, 'no-execution contains worker evidence')
    else:
        require(len(contexts) == 2 and set(results) == {'archive-preflight', 'image-inventory'} and
                3 <= len(manifest) <= 259, 'missing full ordered worker results')
        args = [pair[0][1]['body']['args'] for pair in manifest]
        require(args[0] == args[-1] == broker.INFO and args[1] == broker.LIST, 'finite broker command grammar')
        def decode(raw):
            def unique(items):
                value = {}
                for key, item in items:
                    require(key not in value, 'duplicate daemon response key')
                    value[key] = item
                return value
            def invalid(_):
                refuse('nonfinite daemon response')
            return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)
        ids = set()
        for line in responses[1][1].splitlines():
            item = decode(line)
            require(type(item) is dict and type(item.get('ID')) is str and
                    re.fullmatch('sha256:[a-f0-9]{64}', item['ID']), 'LIST image identity')
            ids.add(item['ID'])
        require(len(ids) <= 256 and len(args) == len(ids) + 3 and
                sorted(ids) == results['image-inventory']['receipt']['retainedImageIds'], 'complete LIST/result coverage')
        seen = set()
        for command, (_, raw) in zip(args[2:-1], responses[2:-1]):
            require(len(command) == 5 and command[:4] == broker.INSPECT and command[4] in ids and command[4] not in seen,
                    'complete unique INSPECT coverage')
            item = decode(raw); p.closed(item, ['id', 'tags', 'digests'])
            require(item['id'] == command[4], 'INSPECT response identity')
            seen.add(command[4])
        require(seen == ids and decode(responses[0][1]) == decode(responses[-1][1]) ==
                results['image-inventory']['receipt']['daemon'], 'initial/final daemon identity differs')
    return {'protected': protected, 'contexts': contexts, 'responses': responses, 'manifest': manifest,
            'results': results, 'workers': observed, 'actors': actors, 'slots': slots}


def control_expected(expected):
    return {key: expected[key] for key in ['nonce', 'requestSha256', 'inputTableSha256', 'epochProofSha256', 'policy']}


def validate_daemon_settlement(p, value, settlement):
    p.closed(value, ['brokerManifestSha256', 'daemonIdentityBeforeSha256', 'daemonIdentityAfterSha256',
        'initialInfoResponseSha256', 'finalInfoResponseSha256', 'completedReadCommands', 'readResponsesVerified',
        'pendingRequests', 'unknownRequests', 'mutationRequestsDispatched', 'activeRequestHandles', 'settlementReceiptSha256'])
    require(value['brokerManifestSha256'] == p.digest(settlement['brokerManifest']) and
            value['daemonIdentityBeforeSha256'] == value['daemonIdentityAfterSha256'] == settlement['daemonIdentitySha256'] and
            value['initialInfoResponseSha256'] == settlement['brokerManifest'][0]['settled']['stdoutSha256'] and
            value['finalInfoResponseSha256'] == settlement['brokerManifest'][-1]['settled']['stdoutSha256'] and
            type(value['completedReadCommands']) is int and value['completedReadCommands'] == len(settlement['brokerManifest']) and
            value['readResponsesVerified'] is True and type(value['activeRequestHandles']) is list and value['activeRequestHandles'] == [] and
            all(type(value[k]) is int and value[k] == 0 for k in ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched']),
            'protected semantic daemon settlement differs')
    p.sha(value['settlementReceiptSha256'])


def projected_manifest(p, workers, budget):
    manifest = []
    for prepared, settled in workers['manifest']:
        budget()
        detail = settled[1]['body']
        projected = {key: value for key, value in detail.items() if key != 'stderrPrefixHex'}
        projected['stderrPrefixHexSha256'] = p.digest(detail['stderrPrefixHex'])
        manifest.append({'workerNonce': settled[1]['workerNonce'], 'prepared': prepared[1]['body'], 'settled': projected,
                         'preparedRecordSha256': prepared[0], 'settledRecordSha256': settled[0]})
    return manifest


def validate_settlement(p, value, workers, expected):
    p.closed(value, ['workerObservation', 'contextBindings', 'brokerManifest', 'retainedImageIds', 'daemonIdentitySha256',
                     'daemonReadSettlement', 'physicalSettlementReceiptSha256'])
    require(len(p.canonical(value)) <= 320 * 1024 and value['workerObservation'] == workers['workers'] and
            value['daemonIdentitySha256'] == expected['nativeIdentitySha256'], 'full protected worker/native settlement')
    contexts = {}
    for nonce, body in workers['contexts'].items():
        expected['budget']()
        contexts[nonce] = {key: body[key] for key in ['requestSha256', 'selectionSha256', 'grantId', 'managerEpoch',
                                                   'guardianSessionId', 'originalDeadlineNs']}
        contexts[nonce].update(contextSha256=p.digest(body), contextVerified=True, inputTableSha256=expected['inputTableSha256'])
    manifest = projected_manifest(p, workers, expected['budget'])
    require(value['contextBindings'] == contexts and value['brokerManifest'] == manifest and
            value['retainedImageIds'] == workers['results']['image-inventory']['receipt']['retainedImageIds'],
            'complete protected context/response projection differs')
    p.sha(value['physicalSettlementReceiptSha256'])
    validate_daemon_settlement(p, value['daemonReadSettlement'], value)


def reconcile_wal(p, rows, policy, authority, core_raw, exchange_raw, workers, expected, history):
    """Consume EVERY defined163/169 row; unknown native/action rows refuse."""
    outgoing, incoming, pending = [], [], None
    custody = created = adopted = terminal_proof = release_proof = None
    unlock_intent = unlock_observed = local_release = release_commit = None
    notice = intent = retired = retirement_reply = reaped = None
    protected = []
    history_receipts = {}
    terminal_challenge = release_challenge = validated = None
    pending_settlement = None
    native_receipts = []
    wal_prefix = hashlib.sha256()
    lifetime = {}
    all_outgoing = [item['row']['body']['envelope'] for item in rows if item['row']['kind'] == 'OUTGOING_PREPARED']
    all_incoming = [item['row']['body']['envelope'] for item in rows if item['row']['kind'] == 'MANAGER']
    full_frames = ProtectedFrames(p, authority['keyId'], all_outgoing, all_incoming)
    control_history(p, full_frames, core_raw, exchange_raw, control_expected(expected), worker_records=workers['protected'],
                    budget=expected['budget'], lifetime=lifetime)
    historical_deadline = lifetime['terminalDeadlineNs']
    core_records = chain(p, core_raw, 4 * MAX, ['sequence', 'previous', 'event', 'details'], 'event', budget=expected['budget'])
    core_by_hash = {item['recordSha256']: item['row'] for item in core_records}
    singleton = set()
    observation_kinds = {'TERMINAL_HISTORY_PROOF', 'TERMINAL_VERIFIED', 'RELEASE_HISTORY_PROOF', 'HISTORY_OBSERVATION'}
    prefix_core, prefix_exchange = {}, {}
    for raw, result in [(core_raw, prefix_core), (exchange_raw, prefix_exchange)]:
        whole = hashlib.sha256(); size = 0
        for line in raw.splitlines(keepends=True):
            expected['budget']()
            whole.update(line); size += len(line)
            result[whole.hexdigest()] = size

    def observation(value):
        require(type(value) is dict and value.get('coreSha256') in prefix_core and
                value.get('exchangeSha256') in prefix_exchange, 'protected observation lacks exact full-file prefix')
        frames = ProtectedFrames(p, authority['keyId'], outgoing, incoming)
        observed = control_history(p, frames, core_raw[:prefix_core[value['coreSha256']]],
            exchange_raw[:prefix_exchange[value['exchangeSha256']]], control_expected(expected), worker_records=protected, budget=expected['budget'])
        observed['workerObservation'] = history.verify_worker_history(p, [entry['event'] for entry in protected])
        require(value == observed, 'protected owner observation/core/exchange/worker history differs')

    def semantic(phase, reference, projection=None):
        nonlocal pending_settlement
        if policy['workflow'] == 'no-execution':
            require(reference is None and pending_settlement is None, 'zero-work proof cannot use daemon settlement')
            return
        require(pending_settlement is not None and pending_settlement['phase'] == phase and
                reference == pending_settlement['sha256'], 'missing/reused/wrong-phase semantic proof reference')
        if projection is not None:
            require(projection == pending_settlement['projection'], 'terminal/release daemon projection differs from full semantic file')
        if phase != 'terminal':
            original = terminal_proof['payload']['settlement']
            validate_daemon_settlement(p, pending_settlement['projection'], original)
        pending_settlement = None

    for record in rows:
        expected['budget']()
        kind, body = record['row']['kind'], record['row']['body']
        prefix_sha = wal_prefix.hexdigest()
        wal_prefix.update(record['line'])
        if kind in {'FENCE_CREATED', 'CUSTODY', 'SUPERVISOR_OFD_ADOPTED', 'TERMINAL_PROOF', 'UNLOCK_INTENT',
                    'UNLOCK_OBSERVED', 'LOCAL_RELEASE', 'RELEASE_COMMITTED', 'RELEASE_PROOF', 'HOST_CLEARED_RECEIVED',
                    'GUEST_RETIRE_INTENT', 'GUEST_RETIRED', 'RETIREMENT_REPLY', 'SUPERVISOR_REAPED', 'HOST_CLEARED_VALIDATED'}:
            require(kind not in singleton, 'duplicate protected one-shot transition')
            singleton.add(kind)
        if kind == 'FENCE_CREATED':
            require(record['row']['sequence'] == 0, 'fence creation must begin original WAL')
            created = body
        elif kind == 'CUSTODY':
            p.closed(body, ['request', 'epoch', 'hostHello', 'hostLifetime', 'observedNs', 'fenceSha256'])
            require(created is not None and body['fenceSha256'] == created['guestFenceSha256'], 'custody/fence differs')
            epoch, hello = body['epoch'], body['hostHello']
            hello_body = envelope(p, hello, authority['keyId'], p.CHANNEL_DOMAIN, 'manager-to-supervisor')
            require(hello['sequence'] == 0 and hello_body['type'] == 'HOST_HELLO' and
                    epoch['currentEpochProofSha256'] == p.digest(hello), 'original epoch/hostHello provenance')
            require(epoch['managerEpoch'] == p.digest({key: hello_body[key] for key in
                    ['hostBootId', 'durableGeneration', 'managerStartNonce', 'authorityPolicySha256']}), 'epoch digest')
            for key in ['managerEpoch', 'channelNonce', 'guardianSessionId', 'guestBootId']:
                require(epoch[key] == hello_body[key], 'epoch/host hello exact identity')
            require(hello_body['requestSha256'] == expected['requestSha256'] and
                    hello_body['guardianInstallationSha256'] == policy['installation']['guardianInstallationSha256'] and
                    hello_body['authorityPolicySha256'] == policy['installation']['authorityPolicySha256'] and
                    p.digest(epoch) == expected['epochProofSha256'], 'independent custody installation bindings')
            lifetime = envelope(p, body['hostLifetime'], authority['keyId'], p.CHANNEL_DOMAIN, 'manager-to-supervisor')
            p.closed(lifetime, ['type', 'guestBootId', 'guardianSessionId', 'managerEpoch', 'requestSha256', 'hostRemainingMs', 'helloSha256'])
            require(body['hostLifetime']['sequence'] == 1 and lifetime['type'] == 'HOST_LIFETIME' and
                    lifetime['helloSha256'] == p.digest(hello) and all(lifetime[k] == hello_body[k] for k in
                    ['guestBootId', 'guardianSessionId', 'managerEpoch', 'requestSha256']), 'original host lifetime')
            p.integer(lifetime['hostRemainingMs'], 1, 1800000); p.local_nanoseconds(body['observedNs'])
            p.closed(body['request'], ['supervisorNonce', 'requestSha256', 'inputTableSha256', 'guestBootId'])
            require(all(body['request'][k] == v for k, v in policy['approvedRequestBindings'].items()), 'custody original request')
            custody = body
        elif kind == 'SUPERVISOR_OFD_ADOPTED':
            p.closed(body, ['supervisorNonce', 'contextSha256', 'supervisorFd', 'guardianLockFd', 'guardianPid',
                            'guardianStarttime', 'supervisorPid', 'supervisorStarttime', 'sameOpenFileDescription', 'guardianLockHeld'])
            require(custody is not None and body['supervisorNonce'] == custody['request']['supervisorNonce'] and
                    body['guardianPid'] == created['fence']['guardianPid'] and
                    body['guardianStarttime'] == created['fence']['guardianStarttime'] and
                    body['sameOpenFileDescription'] is True and body['guardianLockHeld'] is True, 'original OFD adoption differs')
            p.sha(body['contextSha256']); p.integer(body['supervisorFd'], 0, 2**31 - 1); p.integer(body['guardianLockFd'], 0, 2**31 - 1)
            adopted = body
        elif kind == 'OUTGOING_PREPARED':
            p.closed(body, ['envelope', 'sentNs'])
            require(adopted is not None and pending is None and notice is None, 'overlapping/unowned outgoing decision')
            value = envelope(p, body['envelope'], authority['keyId'], p.ADMISSION_DOMAIN, 'supervisor-to-manager')
            require(value['type'] in ('REQUEST', 'RENEW', 'TERMINAL') and body['envelope']['sequence'] == len(outgoing),
                    'unknown/out-of-order outgoing decision')
            p.local_nanoseconds(body['sentNs'])
            pending = body['envelope']
            outgoing.append(pending)
        elif kind == 'OUTGOING_COMMITTED':
            p.closed(body, ['envelopeSha256', 'ledgerSha256'])
            require(pending is not None and body['envelopeSha256'] == p.digest(pending) and
                    body['ledgerSha256'] in core_by_hash, 'outgoing commit/core link differs')
            committed = core_by_hash[body['ledgerSha256']]
            payload = pending['payload']
            if payload['type'] == 'REQUEST':
                require(committed['event'] == 'LEASE_CONTEXT' and committed['details']['request'] == payload,
                        'REQUEST commit not exact lease-context row')
            elif payload['type'] == 'RENEW':
                require(committed['event'] == 'LEASE_CONTROL' and committed['details']['direction'] == 'supervisor-to-manager' and
                        committed['details']['envelopeSha256'] == p.digest(pending) and committed['details']['payload'] == payload,
                        'RENEW commit not exact outgoing control row')
            else:
                require(committed['event'] == ('READONLY_TERMINAL' if payload['outcome'] == 'readonly-observed' else 'TERMINAL') and
                        body['ledgerSha256'] == payload['ledgerSha256'] and committed['details']['outcome'] == payload['outcome'],
                        'TERMINAL commit not exact terminal ledger row')
            pending = None
        elif kind == 'MANAGER':
            p.closed(body, ['envelope', 'observedNs'])
            value = envelope(p, body['envelope'], authority['keyId'], p.ADMISSION_DOMAIN, 'manager-to-supervisor')
            require(adopted is not None and body['envelope']['sequence'] == len(incoming) and
                    value['type'] in ('GRANT', 'SESSION_BIND', 'RENEWED', 'ACK', 'REVOKE'), 'unknown/out-of-order original authenticated decision')
            p.local_nanoseconds(body['observedNs'])
            incoming.append(body['envelope'])
        elif kind == 'WORKER':
            protected.append({'guardianRecordSha256': record['recordSha256'], 'event': body})
        elif kind in ('WORKER_CONTEXT', 'BROKER_RESPONSE'):
            # Consumed in full by worker_reconciliation, not ignored.
            require(body in ([value for value in workers['contexts'].values()] if kind == 'WORKER_CONTEXT' else
                            [value for value, _ in workers['responses']]), 'full worker/response reconciliation missing')
        elif kind in observation_kinds:
            observation(body)
            history_receipts[record['recordSha256']] = (kind, body)
        elif kind == 'TERMINAL_CHALLENGE_RECEIVED':
            p.closed(body, ['payload', 'receivedNs'])
            payload = body['payload']
            releasing = payload.get('type') in ('HOST_RELEASE_CHECK', 'HOST_READONLY_RELEASE_CHECK')
            p.closed(payload, [*expected['terminalBindings'], 'type', 'challengeNonce', *(['ackSha256'] if releasing else [])])
            readonly = policy['workflow'] == 'readonly-workers'
            require(payload['type'] == ('HOST_READONLY_RELEASE_CHECK' if releasing and readonly else
                    'HOST_RELEASE_CHECK' if releasing else 'HOST_READONLY_TERMINAL_CHECK' if readonly else 'HOST_TERMINAL_CHECK') and
                    all(payload[key] == value for key, value in expected['terminalBindings'].items()), 'exact original terminal challenge binding')
            p.sha(payload['challengeNonce'])
            received = positive_decimal(body['receivedNs'])
            require(received < historical_deadline and pending is None and outgoing and outgoing[-1]['payload']['type'] == 'TERMINAL',
                    'challenge before terminal commit or outside original lifetime')
            terminal_sent = next(positive_decimal(item['row']['body']['sentNs']) for item in rows if
                item['row']['kind'] == 'OUTGOING_PREPARED' and item['row']['body']['envelope']['payload']['type'] == 'TERMINAL')
            require(received >= terminal_sent, 'challenge predates original terminal')
            if releasing:
                require(terminal_proof is not None and release_challenge is None and local_release is None and
                        incoming and incoming[-1]['payload']['type'] == 'ACK' and
                        payload['ackSha256'] == p.digest(incoming[-1]['payload']), 'release challenge lacks original durable ACK eligibility')
                ack_received = next(positive_decimal(item['row']['body']['observedNs']) for item in rows if
                    item['row']['kind'] == 'MANAGER' and item['row']['body']['envelope']['payload']['type'] == 'ACK')
                require(received >= ack_received, 'release challenge predates original authenticated ACK')
                release_challenge = record
            else:
                require(terminal_challenge is None and terminal_proof is None and
                        not any(item['payload']['type'] == 'ACK' for item in incoming), 'duplicate/late original terminal challenge')
                terminal_challenge = record
        elif kind == 'UNLOCK_INTENT':
            p.closed(body, ['ackSha256', 'terminalSha256', 'observation', 'daemonSettlementReceiptSha256'])
            require(terminal_proof is not None and unlock_intent is None, 'unlock before terminal proof')
            observation(body['observation'])
            require(body['terminalSha256'] == expected['terminalBindings']['terminalSha256'] and
                    body['observation']['managerAck'] is not None and
                    body['ackSha256'] == p.digest(body['observation']['managerAck']), 'unlock intent exact terminal/ACK binding')
            require(release_challenge is not None, 'unlock without original release challenge')
            semantic('pre-unlock', body['daemonSettlementReceiptSha256'])
            unlock_intent = body
        elif kind == 'UNLOCK_OBSERVED':
            p.closed(body, ['ackSha256', 'lockDevice', 'lockInode'])
            require(unlock_intent is not None and body['ackSha256'] == unlock_intent['ackSha256'], 'unlock observed linkage')
            unlock_observed = record
        elif kind == 'LOCAL_RELEASE':
            p.closed(body, ['nonce', 'requestSha256', 'guardianSessionId', 'ackSha256', 'fenceReceiptSha256'])
            require(unlock_observed is not None and body['fenceReceiptSha256'] == unlock_observed['recordSha256'] and
                    body['ackSha256'] == unlock_observed['row']['body']['ackSha256'] and body['nonce'] == expected['nonce'] and
                    body['requestSha256'] == expected['requestSha256'] and body['guardianSessionId'] == expected['guardianSessionId'],
                    'local release/unlock linkage')
            local_release = body
        elif kind == 'RELEASE_COMMITTED':
            p.closed(body, ['releaseReceiptSha256', 'ledgerSha256'])
            require(local_release is not None and body['releaseReceiptSha256'] == p.digest(local_release) and
                    body['ledgerSha256'] in core_by_hash and core_by_hash[body['ledgerSha256']]['event'] == 'GUARDIAN_RELEASE' and
                    core_by_hash[body['ledgerSha256']]['details'] == local_release, 'release commit exact durable row binding')
            release_commit = body
        elif kind in ('TERMINAL_PROOF', 'RELEASE_PROOF'):
            payload = envelope(p, body, authority['keyId'], p.CHANNEL_DOMAIN, 'supervisor-to-manager')
            readonly = policy['workflow'] == 'readonly-workers'
            releasing = kind == 'RELEASE_PROOF'
            fields = [*expected['terminalBindings'], 'type', 'challengeNonce', 'historyReceiptSha256', 'historyVerified',
                      'admissionFenced', 'writerExclusionRetained', 'guardianPid1Verified', 'pendingRenewal',
                      'registeredChildren', 'unknownRequests', 'guestFenceSha256']
            if releasing:
                fields += ['ackSha256', 'releaseReceipt', 'guardianLockAbsent', 'daemonIpcConfined']
            else:
                fields += ['terminalRow', 'guardianLockHeld']
            fields += (['mutationRequestsDispatched', 'settlementSha256', 'daemonReadSettlement'] if releasing else
                       ['mutationRequestsDispatched', 'settlement']) if readonly else ['everDispatched', 'daemonRequestsDispatched']
            p.closed(payload, fields)
            challenge = release_challenge if releasing else terminal_challenge
            require(challenge is not None and payload['challengeNonce'] == challenge['row']['body']['payload']['challengeNonce'],
                    'terminal/release proof original challenge differs')
            require(payload['type'] == ('GUEST_READONLY_RELEASE_PROOF' if readonly and releasing else
                    'GUEST_READONLY_TERMINAL_PROOF' if readonly else 'GUEST_RELEASE_PROOF' if releasing else 'GUEST_TERMINAL_PROOF') and
                    all(payload[k] is True for k in ['historyVerified', 'admissionFenced', 'writerExclusionRetained', 'guardianPid1Verified']) and
                    payload['historyReceiptSha256'] in history_receipts and
                    history_receipts[payload['historyReceiptSha256']][0] == ('RELEASE_HISTORY_PROOF' if releasing else 'TERMINAL_HISTORY_PROOF'),
                    'terminal/release exact proof shape/history linkage')
            require(payload.get('historyVerified') is True and payload.get('guestFenceSha256') == created['guestFenceSha256'],
                    'protected terminal/release proof fence/history')
            for key, value in expected['terminalBindings'].items():
                require(payload[key] == value, 'terminal/release exact current binding')
            require(payload.get('unknownRequests') == 0 and payload.get('registeredChildren') == [] and
                    payload.get('pendingRenewal') is False, 'terminal/release proof has unknown work')
            if kind == 'TERMINAL_PROOF':
                require(local_release is None, 'terminal proof after release')
                require(payload['guardianLockHeld'] is True and digest(p.canonical(payload['terminalRow']) + b'\n') ==
                        history_receipts[payload['historyReceiptSha256']][1]['terminal']['ledgerSha256'], 'terminal exact core row')
                if readonly:
                    validate_settlement(p, payload['settlement'], workers, expected)
                    require(payload['settlement']['physicalSettlementReceiptSha256'] ==
                            payload['settlement']['daemonReadSettlement']['settlementReceiptSha256'], 'terminal semantic file projection pointer differs')
                    semantic('terminal', payload['settlement']['physicalSettlementReceiptSha256'], payload['settlement']['daemonReadSettlement'])
                terminal_proof = body
            else:
                require(release_commit is not None and payload['releaseReceipt'] == local_release and payload['guardianLockAbsent'] is True and
                        payload['daemonIpcConfined'] is True and payload['ackSha256'] == local_release['ackSha256'], 'release proof before commit')
                if readonly:
                    require(payload['settlementSha256'] == p.digest(terminal_proof['payload']['settlement']), 'release original settlement hash')
                    validate_daemon_settlement(p, payload['daemonReadSettlement'], terminal_proof['payload']['settlement'])
                    semantic('release', payload['daemonReadSettlement']['settlementReceiptSha256'], payload['daemonReadSettlement'])
            if readonly:
                require(type(payload['mutationRequestsDispatched']) is int and payload['mutationRequestsDispatched'] == 0,
                        'read-only proof dispatched mutation')
            else:
                require(payload['everDispatched'] is False and type(payload['daemonRequestsDispatched']) is int and
                        payload['daemonRequestsDispatched'] == 0, 'no-execution proof dispatched requests')
            if releasing:
                release_proof = body
        elif kind == 'HOST_CLEARED_VALIDATED':
            p.closed(body, ['envelope', 'receivedNs'])
            payload = envelope(p, body['envelope'], authority['keyId'], p.CHANNEL_DOMAIN, 'manager-to-supervisor')
            p.closed(payload, [*expected['terminalBindings'], 'type', 'challengeNonce', 'ackSha256', 'releaseReceiptSha256',
                'clearedRecordSha256', 'remainingFencesSha256', 'guestFenceSha256', 'authorityRestored', 'automaticRetryAllowed'])
            for key in ['challengeNonce', 'clearedRecordSha256', 'remainingFencesSha256']:
                p.sha(payload[key])
            require(release_proof is not None and release_commit is not None and local_release is not None and
                    payload['type'] == 'HOST_CLEARED' and positive_decimal(body['receivedNs']) < historical_deadline,
                    'host-clear validation before complete release/outside lifetime')
            require(all(payload[key] == value for key, value in expected['terminalBindings'].items()) and
                    payload['ackSha256'] == local_release['ackSha256'] and payload['releaseReceiptSha256'] == p.digest(local_release) and
                    payload['guestFenceSha256'] == created['guestFenceSha256'] and payload['authorityRestored'] is False and
                    payload['automaticRetryAllowed'] is False, 'host-clear validated original bindings differ')
            validated = record
        elif kind == 'HOST_CLEARED_RECEIVED':
            p.closed(body, ['envelope', 'protectedHistory', 'physicalReceiptSha256', 'guestFenceIdentity',
                            'validatedRecordSha256', 'daemonSettlementReceiptSha256'])
            require(validated is not None and body['validatedRecordSha256'] == validated['recordSha256'] and
                    body['envelope'] == validated['row']['body']['envelope'], 'host-clear exact preceding validation differs')
            semantic('host-clear', body['daemonSettlementReceiptSha256'])
            require(release_proof is not None, 'host clear before complete protected release')
            payload = envelope(p, body['envelope'], authority['keyId'], p.CHANNEL_DOMAIN, 'manager-to-supervisor')
            fields = ['type', 'grantId', 'managerEpoch', 'guestBootId', 'requestSha256', 'challengeNonce', 'guardianSessionId',
                      'requestNonce', 'terminalSha256', 'inputTableSha256', 'selectionSha256', 'ackSha256',
                      'releaseReceiptSha256', 'clearedRecordSha256', 'remainingFencesSha256', 'guestFenceSha256',
                      'authorityRestored', 'automaticRetryAllowed']
            p.closed(payload, fields)
            require(payload['type'] == 'HOST_CLEARED' and payload['authorityRestored'] is False and
                    payload['automaticRetryAllowed'] is False and payload['releaseReceiptSha256'] == p.digest(local_release) and
                    payload['guestFenceSha256'] == created['guestFenceSha256'], 'host clear exact protected decision')
            for key, value in expected['terminalBindings'].items():
                require(payload[key] == value, 'host clear terminal binding')
            for key in ['challengeNonce', 'clearedRecordSha256', 'remainingFencesSha256', 'ackSha256']:
                p.sha(payload[key])
            observation(body['protectedHistory']); p.sha(body['physicalReceiptSha256'])
            notice = record
        elif kind == 'GUEST_RETIRE_INTENT':
            p.closed(body, ['hostClearedEnvelopeSha256', 'retirementNonce', 'guestFenceIdentity', 'hostClearRecordSha256'])
            require(notice is not None and body['hostClearRecordSha256'] == notice['recordSha256'] and
                    body['hostClearedEnvelopeSha256'] == p.digest(notice['row']['body']['envelope']) and
                    body['retirementNonce'] == notice['row']['body']['envelope']['payload']['challengeNonce'] and
                    body['guestFenceIdentity'] == notice['row']['body']['guestFenceIdentity'], 'retirement intent linkage')
            intent = record
        elif kind == 'GUEST_RETIRED':
            require(intent is not None, 'retired without intent')
            p.closed(body, [*intent['row']['body'], 'guestFenceAbsent', 'finalPhysicalReceiptSha256', 'authorityRestored', 'automaticRetryAllowed'])
            require(all(body[k] == v for k, v in intent['row']['body'].items()) and body['guestFenceAbsent'] is True and
                    body['authorityRestored'] is False and body['automaticRetryAllowed'] is False, 'retirement exact intent differs')
            p.sha(body['finalPhysicalReceiptSha256']); retired = record
        elif kind == 'RETIREMENT_REPLY':
            require(retired is not None, 'retirement reply before durable retirement')
            payload = envelope(p, body, authority['keyId'], p.CHANNEL_DOMAIN, 'supervisor-to-manager')
            original = notice['row']['body']['envelope']['payload']
            p.closed(payload, [*original, 'retirementReceipt'])
            require(all(payload[k] == v for k, v in original.items() if k != 'type') and
                    payload['type'] == 'GUEST_FENCE_RETIRED', 'retirement reply original notice differs')
            receipt = payload['retirementReceipt']
            wanted = {k: original[k] for k in ['grantId', 'managerEpoch', 'guestBootId', 'requestSha256', 'guardianSessionId',
                     'terminalSha256', 'ackSha256', 'releaseReceiptSha256', 'clearedRecordSha256', 'guestFenceSha256']}
            wanted.update(nonce=original['requestNonce'], hostClearedEnvelopeSha256=p.digest(notice['row']['body']['envelope']),
                retirementNonce=original['challengeNonce'], retirementRecordSha256=retired['recordSha256'],
                guestFenceAbsent=True, authorityRestored=False, automaticRetryAllowed=False)
            require(receipt == wanted, 'exact retirement reply receipt differs'); retirement_reply = record
        elif kind == 'SUPERVISOR_REAPED':
            p.closed(body, ['pid', 'starttime', 'exitCode', 'retirementRecordSha256'])
            require(retirement_reply is not None and body['pid'] == adopted['supervisorPid'] and
                    body['starttime'] == adopted['supervisorStarttime'] and type(body['exitCode']) is int and body['exitCode'] == 0 and
                    body['retirementRecordSha256'] == retired['recordSha256'], 'registered supervisor reaping differs')
            reaped = body
        elif kind in ('PHYSICAL_EVIDENCE', 'OBSERVATION_CHALLENGE', 'OBSERVATION_PRODUCED'):
            require(record['recordSha256'] in expected['physicalRecords'], 'physical/control row not reconciled')
        elif kind in ('NATIVE_CUSTODY', 'NATIVE_BOUND', 'NATIVE_READ_REGISTERED', 'NATIVE_READ_SETTLED'):
            require(record['recordSha256'] in expected['nativeRecords'], 'native row not fully reconciled')
            if kind == 'NATIVE_READ_SETTLED':
                native_receipts.append(body['receipt'])
        elif kind == 'DAEMON_SETTLEMENT_EVIDENCE':
            require(policy['workflow'] == 'readonly-workers' and pending_settlement is None and
                    record['recordSha256'] in expected['daemonProofs'], 'foreign/overlapping semantic proof marker')
            evidence = expected['daemonProofs'][record['recordSha256']]
            value, state = evidence['body'], evidence['body']['nativeReadState']
            manifest = projected_manifest(p, workers, expected['budget'])
            require(value['guardianHistorySha256'] == prefix_sha and value['brokerManifestSha256'] == p.digest(manifest) and
                    value['protectedBrokerReceiptsSha256'] == p.digest([item for item in native_receipts if item['registration']['kind'] == 'broker']) and
                    state['completedRecordsSha256'] == p.digest(native_receipts) and
                    type(state['completedReadCommands']) is int and state['completedReadCommands'] == len(manifest),
                    'complete semantic file prefix/manifest/native receipt sequence differs')
            if validated is not None:
                require(notice is None, 'semantic proof after host-clear consumption')
                phase, challenge = 'host-clear', validated
            elif terminal_proof is None:
                phase, challenge = 'terminal', terminal_challenge
                require(any(kind == 'TERMINAL_HISTORY_PROOF' for kind, _ in history_receipts.values()), 'terminal semantic phase')
            elif local_release is None:
                phase, challenge = 'pre-unlock', release_challenge
                require(unlock_intent is None, 'duplicate pre-unlock semantic phase')
            else:
                phase, challenge = 'release', release_challenge
                require(release_commit is not None and release_proof is None and
                        any(kind == 'RELEASE_HISTORY_PROOF' for kind, _ in history_receipts.values()), 'release semantic phase')
            require(challenge is not None and value['originalChallengeNs'] == challenge['row']['body']['receivedNs'] and
                    positive_decimal(evidence['observedNs']) < historical_deadline, 'semantic file exact original challenge/lifetime differs')
            projection = {'brokerManifestSha256': p.digest(manifest), 'daemonIdentityBeforeSha256': expected['nativeIdentitySha256'],
                'daemonIdentityAfterSha256': expected['nativeIdentitySha256'],
                'initialInfoResponseSha256': manifest[0]['settled']['stdoutSha256'],
                'finalInfoResponseSha256': manifest[-1]['settled']['stdoutSha256'], 'completedReadCommands': len(manifest),
                'readResponsesVerified': True, 'pendingRequests': 0, 'unknownRequests': 0, 'mutationRequestsDispatched': 0,
                'activeRequestHandles': [], 'settlementReceiptSha256': body['proof']['sha256']}
            pending_settlement = {'phase': phase, 'sha256': body['proof']['sha256'], 'projection': projection}
        elif kind == 'PILOT_HISTORY':
            p.closed(body, ['bundle', 'expected', 'receiptTailSha256', 'authorityRestored', 'mutationAuthorized'])
            p.sha(body['receiptTailSha256'])
            require(body['authorityRestored'] is False and body['mutationAuthorized'] is False,
                    'pilot WAL cannot restore authority')
            # The fixed dead-owner entry deliberately has no Manager key and
            # may not rebuild a live Guardian. Do not downgrade signed history
            # verification to hash equality or treat it as read-only settlement.
            refuse('signed pilot history requires separately installed authenticated recovery observer; key access remains forbidden')
        elif kind == 'UNRESOLVED':
            p.closed(body, ['reason', 'authorityRestored'])
            require(type(body['reason']) is str and len(body['reason']) <= 256 and body['authorityRestored'] is False,
                    'unresolved record shape')
            require(record is rows[-1], 'actions follow original unresolved terminal record')
        else:
            refuse('unsupported guardian/native linkage record: ' + str(kind)[:128])
    require(created is not None and custody is not None and adopted is not None and pending is None and pending_settlement is None and
            terminal_challenge is not None and terminal_proof is not None and
            (release_challenge is None or (release_proof is not None and local_release is not None)) and
            (validated is None or notice is not None),
            'partial/unknown original owner history')
    frames = ProtectedFrames(p, authority['keyId'], outgoing, incoming)
    observed = control_history(p, frames, core_raw, exchange_raw, control_expected(expected), worker_records=workers['protected'], budget=expected['budget'])
    require(all(frames.counts[key] == len(frames.records[key]) for key in frames.records) and
            observed['terminal'] is not None and observed['managerAck'] is not None, 'incomplete terminal/ACK/owner decision coverage')
    return {'observation': observed, 'custody': custody, 'adopted': adopted, 'localRelease': local_release,
            'notice': notice, 'intent': intent, 'retired': retired, 'retirementReply': retirement_reply, 'reaped': reaped}


def positive_decimal(value):
    require(type(value) is str and re.fullmatch('[1-9][0-9]*', value) and int(value) < 2**63,
            'canonical positive native timestamp')
    return int(value)


def native_links(p, rows, binding, table_sha, broker, workers, terminal_deadline, budget):
    links = []
    custody = bound = active = pending_broker = None
    request_prepared = request_committed = host_custody = reaped = False
    counters = {'broker': 0, 'physical': 0}
    handles = set()
    responses = {item['command']: (item, raw) for item, raw in workers['responses']}
    contexts = workers['contexts']
    for item in rows:
        budget()
        row, reference = item['row'], item['recordSha256']
        kind, body = row['kind'], row['body']
        if kind == 'CUSTODY':
            require(custody is not None, 'host custody before native custody')
            host_custody = True
        elif kind == 'OUTGOING_PREPARED' and body['envelope']['payload'].get('type') == 'REQUEST':
            require(host_custody and not request_prepared, 'duplicate/unowned native request preparation')
            request_prepared = True
        elif kind == 'OUTGOING_COMMITTED' and request_prepared and not request_committed:
            require(bound is not None, 'REQUEST committed without native binding')
            request_committed = True
        elif kind == 'WORKER':
            require(request_committed and bound is not None, 'worker before native-bound request commit')
            if body['type'] == 'broker-prepared':
                require(active is None and pending_broker is None, 'broker preparation overlaps native handle')
                pending_broker = body
            elif body['type'] == 'broker-settled':
                require(active is not None and active['row']['body']['registration']['kind'] == 'broker' and
                        pending_broker is not None and body['workerNonce'] == pending_broker['workerNonce'] and
                        body['body']['command'] == pending_broker['body']['command'] and body['body']['outcome'] == 'observed',
                        'broker settlement lacks exact native registration')
                pending_broker = dict(pending_broker, settled=True)
        elif kind == 'SUPERVISOR_REAPED':
            require(active is None, 'native read remains at guardian completion')
            reaped = True
        if not kind.startswith('NATIVE_'):
            continue
        require(not reaped, 'native event after guardian completion')
        p.integer(body.get('version'), 1, 1)
        links.append({'recordSha256': reference, 'row': row})
        if kind == 'NATIVE_CUSTODY':
            p.closed(body, ['version', 'bootstrap'])
            require(custody is None and not host_custody and not request_prepared and row['sequence'] > 0,
                    'native custody ordering/uniqueness')
            value = body['bootstrap']
            p.closed(value, ['guestBootId', 'requestSha256', 'localSessionId', 'nativePolicySha256', 'nativePid',
                             'nativeStarttime', 'deadlineNs', 'birthRecordSha256', 'identity', 'identitySha256'])
            require(all(value[k] == binding[k] for k in ['guestBootId', 'requestSha256', 'localSessionId']),
                    'native custody original fence binding')
            for key in ['nativePolicySha256', 'birthRecordSha256', 'identitySha256']:
                p.sha(value[key])
            p.integer(value['nativePid'], 1, 2**31 - 1)
            positive_decimal(value['nativeStarttime']); positive_decimal(value['deadlineNs'])
            require(type(value['identity']) is dict and p.digest(value['identity']) == value['identitySha256'],
                    'native identity content linkage')
            # Closed identity semantics belong to pinned verify_links, not this
            # caller's interpretation or a self-reported custody boolean.
            custody = item
        elif kind == 'NATIVE_BOUND':
            p.closed(body, ['version', 'binding', 'nativeCustodyRecordSha256'])
            p.closed(body['binding'], [*binding, 'inputTableSha256'])
            require(custody is not None and bound is None and request_prepared and not request_committed and
                    body['nativeCustodyRecordSha256'] == custody['recordSha256'] and
                    body['binding'] == dict(binding, inputTableSha256=table_sha), 'native exact REQUEST binding')
            bound = item
        elif kind == 'NATIVE_READ_REGISTERED':
            p.closed(body, ['version', 'nativeBoundRecordSha256', 'registration', 'registeredRecordSha256', 'daemonIdentitySha256'])
            require(bound is not None and request_committed and active is None and
                    body['nativeBoundRecordSha256'] == bound['recordSha256'] and
                    body['daemonIdentitySha256'] == custody['row']['body']['bootstrap']['identitySha256'],
                    'foreign/overlapping native read registration')
            handle = p.sha(body['registeredRecordSha256'])
            require(handle not in handles, 'reused native read handle'); handles.add(handle)
            registration = body['registration']
            p.closed(registration, ['kind', 'command', 'workerNonce', 'args', 'path', 'originalDeadlineNs',
                                    'guardianSessionId', 'requestSha256'])
            role = registration['kind']
            require(role in counters and all(registration[k] == binding[k] for k in ['guardianSessionId', 'requestSha256']),
                    'native registration original owner binding')
            counters[role] += 1
            p.integer(registration['command'], counters[role], counters[role])
            require(counters[role] <= (259 if role == 'broker' else 2048), 'native registration count bound')
            deadline = positive_decimal(registration['originalDeadlineNs'])
            require(deadline <= positive_decimal(custody['row']['body']['bootstrap']['deadlineNs']) and
                    deadline <= terminal_deadline, 'native registration original lifetime exceeded')
            if role == 'broker':
                nonce = registration['workerNonce']
                require(nonce in contexts and contexts[nonce]['role'] == 'image-inventory' and pending_broker is not None and
                        pending_broker['workerNonce'] == nonce and not pending_broker.get('settled') and
                        registration['command'] == pending_broker['body']['command'] and
                        registration['args'] == pending_broker['body']['args'] and registration['path'] is None and
                        deadline <= positive_decimal(contexts[nonce]['originalDeadlineNs']) and
                        deadline <= positive_decimal(pending_broker['body']['originalDeadlineNs']), 'native broker command/context differs')
            else:
                require(pending_broker is None and registration['workerNonce'] is None and registration['args'] is None and
                        type(registration['path']) is str and (registration['path'] in ('/info', '/containers/json?all=1') or
                        re.fullmatch('/containers/[a-f0-9]{64}/json', registration['path'])), 'finite native physical route')
            active = item
        elif kind == 'NATIVE_READ_SETTLED':
            p.closed(body, ['version', 'guardianRegistrationRecordSha256', 'receipt'])
            require(active is not None and body['guardianRegistrationRecordSha256'] == active['recordSha256'],
                    'native settled read has no exact registration')
            registration_body = active['row']['body']
            receipt = body['receipt']
            p.closed(receipt, ['registration', 'registeredRecordSha256', 'daemonIdentitySha256', 'records', 'wireRecords',
                              'pendingRequests', 'unknownRequests', 'mutationRequestsDispatched', 'activeRequestHandles',
                              'readResponsesVerified', 'settlementRecordSha256'])
            require(all(receipt[k] == registration_body[k] for k in ['registration', 'registeredRecordSha256', 'daemonIdentitySha256']) and
                    all(type(receipt[k]) is int and receipt[k] == 0 for k in
                        ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched']) and
                    receipt['activeRequestHandles'] == [] and type(receipt['activeRequestHandles']) is list and
                    receipt['readResponsesVerified'] is True, 'native pending/unknown/different settlement')
            p.sha(receipt['settlementRecordSha256'])
            registration = receipt['registration']
            primary = native_primary(p, receipt, broker, budget)
            if registration['kind'] == 'broker':
                require(pending_broker is not None and pending_broker.get('settled') is True and
                        registration['command'] in responses and
                        next(item['row']['sequence'] for item in rows if item['row']['kind'] == 'BROKER_RESPONSE' and
                             item['row']['body']['command'] == registration['command']) < row['sequence'],
                        'native broker settlement before successful full response persistence')
                raw = responses[registration['command']][1]
                compare_primary(p, registration['args'], primary, raw, broker, budget)
                pending_broker = None
            active = None
        else:
            refuse('unsupported native linkage kind')
    require(custody is not None and bound is not None and request_committed and active is None and pending_broker is None and
            counters['broker'] == len(workers['responses']), 'incomplete native/guardian read linkage')
    return links, custody


def native_primary(p, receipt, broker, budget):
    """Closed projection grammar from172 Authorizer, validated again by reader."""
    registration = receipt['registration']
    if registration['kind'] == 'physical':
        route = registration['path']
        target = ['info' if route == '/info' else 'containers' if route == '/containers/json?all=1' else 'container',
                  '/containers/json' if route == '/containers/json?all=1' else route]
    else:
        args = registration['args']
        target = ['info', '/info'] if args == broker.INFO else ['images', '/images/json'] if args == broker.LIST else None
        if target is None:
            require(type(args) is list and len(args) == 5 and args[:4] == broker.INSPECT and
                    re.fullmatch('sha256:[a-f0-9]{64}', args[4]), 'native finite INSPECT command')
            target = ['image', '/images/' + args[4] + '/json']
    records, wires = receipt['records'], receipt['wireRecords']
    require(type(records) is list and type(wires) is list and 1 <= len(records) == len(wires) <= 4, 'complete native endpoint/wire count')
    seen_targets, seen_ids, primary = set(), set(), None
    for record, wire in zip(records, wires):
        budget()
        p.closed(record, ['method', 'uri', 'target', 'proxyId', 'registeredRecordSha256', 'request', 'requestRecordSha256',
                          'responseStatusCode', 'responseBodySha256', 'responseBytes', 'projection', 'responseFile',
                          'handlerReturned', 'mutationRequestDispatched', 'responseRecordSha256'])
        p.closed(wire, ['proxyId', 'wireRecordSha256', 'deliveredRecordSha256'])
        for key in ['proxyId', 'registeredRecordSha256', 'requestRecordSha256', 'responseBodySha256', 'responseRecordSha256']:
            p.sha(record[key])
        p.sha(wire['wireRecordSha256']); p.sha(wire['deliveredRecordSha256'])
        p.integer(record['request'], 1, 8192); p.integer(record['responseBytes'], 0, MAX - 1)
        require(type(record['responseStatusCode']) is int and record['responseStatusCode'] == 200 and
                record['handlerReturned'] is True and record['mutationRequestDispatched'] is False and
                record['registeredRecordSha256'] == receipt['registeredRecordSha256'] and
                wire['proxyId'] == record['proxyId'] and record['proxyId'] not in seen_ids and
                type(record['target']) is list and len(record['target']) == 2 and
                all(type(value) is str for value in record['target']), 'native response/wire pairing or state')
        endpoint = tuple(record['target'])
        require(endpoint not in seen_targets and (record['target'] == target or endpoint in (('ping', '/_ping'), ('version', '/version'))),
                'extra/duplicate native endpoint')
        seen_targets.add(endpoint); seen_ids.add(record['proxyId'])
        if record['target'] == target:
            require(record['method'] == 'GET' and primary is None, 'native primary method/count')
            primary = record['projection']
    require(primary is not None, 'native primary missing')
    return primary


def compare_primary(p, args, projection, raw, broker, budget):
    def unique(items):
        value = {}
        for key, item in items:
            require(key not in value, 'duplicate CLI response key'); value[key] = item
        return value
    if args == broker.LIST:
        ids = set()
        for line in raw.splitlines():
            budget()
            value = json.loads(line, object_pairs_hook=unique)
            require(type(value) is dict and type(value.get('ID')) is str and re.fullmatch('sha256:[a-f0-9]{64}', value['ID']),
                    'CLI LIST/native projection identity')
            ids.add(value['ID'])
        wanted = {'retainedImageIds': sorted(ids)}
    else:
        wanted = json.loads(raw, object_pairs_hook=unique)
    require(projection == wanted, 'complete native primary projection differs from protected CLI stdout')


def physical_records(p, rows, q, snapshot, fence, expected):
    references = set()
    receipts = {}
    daemon_proofs = {}
    challenge = None
    proof_fd = snapshot.directory(q['proofDirectory'])
    proof_names = set()
    for item in rows:
        snapshot.budget()
        kind, body = item['row']['kind'], item['row']['body']
        if kind == 'PHYSICAL_EVIDENCE':
            p.closed(body, ['receipt', 'proofs', 'collectionStartedNs'])
            p.local_nanoseconds(body['collectionStartedNs'])
            receipt = body['receipt']
            p.closed(receipt, ['guardianPid', 'daemonPid', 'guardianStarttime', 'lockDevice', 'lockInode', 'daemonStarttime',
                              'daemonSocketDevice', 'daemonSocketInode', 'guardianCgroup', 'guardianUnitSha256',
                              'lockOfdSha256', 'daemonExeSha256', 'daemonConfigSha256', 'confinementReceiptSha256', 'writerPolicyReceiptSha256'])
            require(receipt['guardianPid'] == fence['guardianPid'] and receipt['guardianStarttime'] == fence['guardianStarttime'] and
                    receipt['guardianCgroup'] == '/system.slice/' + UNIT and
                    receipt['guardianUnitSha256'] == expected['guardianUnitSha256'], 'protected physical original guardian identity')
            require(type(body['proofs']) is list and len(body['proofs']) == 3, 'complete physical proof triplet')
            for descriptor, role, hash_field in zip(body['proofs'], ['ofd', 'confinement', 'writers'],
                    ['lockOfdSha256', 'confinementReceiptSha256', 'writerPolicyReceiptSha256']):
                p.closed(descriptor, ['path', 'sha256', 'bytes'])
                path = Path(descriptor['path'])
                require(path.parent == Path(q['proofDirectory']) and
                        re.fullmatch(re.escape(fence['localSessionId']) + r'\.physical\.[0-9]+\.' + role + r'\.json', path.name) and
                        path.name not in proof_names, 'exact unique physical proof path')
                raw, _ = snapshot.file(proof_fd, path.name, 16384)
                require(len(raw) == descriptor['bytes'] and digest(raw) == descriptor['sha256'] == receipt[hash_field],
                        'complete physical proof content linkage')
                value = p.parse(raw)
                p.closed(value, ['kind', 'localSessionId', 'requestSha256', 'guardianSessionId', 'observedNs', 'body'])
                require(value['kind'] == role and value['localSessionId'] == fence['localSessionId'] and
                        value['requestSha256'] == fence['requestSha256'] and value['guardianSessionId'] == expected['guardianSessionId'],
                        'physical proof original session binding')
                p.local_nanoseconds(value['observedNs'])
                fields = {'ofd': ['guardianPid', 'guardianStarttime', 'device', 'inode', 'held', 'descriptorProofs'],
                    'confinement': ['kernel', 'actors', 'engines', 'guardianPid1', 'engineUnits', 'daemonSocketDevice',
                                    'daemonSocketInode', 'runtimeSocket', 'store', 'nativeIdentitySha256', 'nativeBirthRecordSha256'],
                    'writers': ['authorizationSha256', 'ownerRegistrySha256', 'maintenance', 'trustedRootActors', 'retainedContainers']}
                p.closed(value['body'], fields[role])
                if role == 'ofd':
                    require(value['body']['guardianPid'] == fence['guardianPid'] and
                            value['body']['guardianStarttime'] == fence['guardianStarttime'] and
                            value['body']['device'] == receipt['lockDevice'] and value['body']['inode'] == receipt['lockInode'] and
                            type(value['body']['held']) is bool, 'physical original OFD proof binding')
                if role == 'writers':
                    require(value['body']['authorizationSha256'] == q['ownerAuthorization']['sha256'] and
                            value['body']['ownerRegistrySha256'] == expected['ownerRegistrySha256'],
                            'writer authorization/complete original registry history differs')
                if role == 'confinement':
                    require(value['body']['nativeIdentitySha256'] == expected['nativeIdentitySha256'] and
                            value['body']['nativeBirthRecordSha256'] == expected['nativeBirthRecordSha256'],
                            'physical proof original native birth/identity differs')
                proof_names.add(path.name)
            receipts[p.digest(receipt)] = receipt
            references.add(item['recordSha256'])
        elif kind == 'DAEMON_SETTLEMENT_EVIDENCE':
            p.closed(body, ['proof'])
            descriptor = body['proof']
            p.closed(descriptor, ['path', 'sha256', 'bytes'])
            path = Path(descriptor['path'])
            require(path.parent == Path(q['proofDirectory']) and path.name not in proof_names and
                    re.fullmatch(re.escape(fence['localSessionId']) + r'\.physical\.[0-9]+\.daemon-read-settlement\.json', path.name),
                    'exact unique daemon settlement proof path')
            raw, _ = snapshot.file(proof_fd, path.name, 16384)
            require(type(descriptor['bytes']) is int and len(raw) == descriptor['bytes'] and digest(raw) == descriptor['sha256'],
                    'complete daemon settlement proof descriptor differs')
            value = p.parse(raw)
            p.closed(value, ['kind', 'localSessionId', 'requestSha256', 'guardianSessionId', 'observedNs', 'body'])
            require(raw == p.canonical(value) and value['kind'] == 'daemon-read-settlement' and
                    value['localSessionId'] == fence['localSessionId'] and value['requestSha256'] == fence['requestSha256'] and
                    value['guardianSessionId'] == expected['guardianSessionId'], 'daemon settlement wrapper/session differs')
            evidence = value['body']
            p.closed(evidence, ['daemonIdentitySha256', 'nativeBirthRecordSha256', 'nativeHistorySha256', 'nativeReadState',
                'brokerManifestSha256', 'protectedBrokerReceiptsSha256', 'guardianHistorySha256', 'originalChallengeNs'])
            require(evidence['daemonIdentitySha256'] == expected['nativeIdentitySha256'] and
                    evidence['nativeBirthRecordSha256'] == expected['nativeBirthRecordSha256'], 'semantic proof native birth differs')
            for key in ['nativeHistorySha256', 'brokerManifestSha256', 'protectedBrokerReceiptsSha256', 'guardianHistorySha256']:
                p.sha(evidence[key])
            original = positive_decimal(evidence['originalChallengeNs'])
            observed = positive_decimal(value['observedNs'])
            require(original <= observed < original + 2_500_000_000, 'semantic proof original challenge persistence budget')
            state = evidence['nativeReadState']
            p.closed(state, ['daemonIdentitySha256', 'pendingRequests', 'unknownRequests', 'mutationRequestsDispatched',
                'activeRequestHandles', 'completedReadCommands', 'completedRecordsSha256', 'authorityRestored', 'automaticRetryAllowed'])
            require(state['daemonIdentitySha256'] == expected['nativeIdentitySha256'] and
                    all(type(state[key]) is int and state[key] == 0 for key in
                        ['pendingRequests', 'unknownRequests', 'mutationRequestsDispatched']) and
                    type(state['activeRequestHandles']) is list and state['activeRequestHandles'] == [] and
                    state['authorityRestored'] is False and state['automaticRetryAllowed'] is False,
                    'semantic native proof requests/authority differ')
            p.sha(state['completedRecordsSha256'])
            daemon_proofs[item['recordSha256']] = value
            proof_names.add(path.name)
        elif kind == 'OBSERVATION_CHALLENGE':
            p.closed(body, ['payload', 'receivedNs'])
            require(challenge is None, 'overlapping historical physical observation')
            p.local_nanoseconds(body['receivedNs'])
            payload = body['payload']
            p.closed(payload, ['type', 'guestBootId', 'guardianSessionId', 'managerEpoch', 'requestSha256',
                'guardianInstallationSha256', 'observationNonce', 'vmid', 'selectionSha256', 'custodyPolicySha256',
                'requestNonce', 'inputTableSha256'])
            require(payload['type'] in ('HOST_OBSERVE', 'HOST_PILOT_BOUNDARY_CHECK') and type(payload['vmid']) is int and payload['vmid'] == 107,
                    'physical observation type/target')
            for key, value in expected['observationBindings'].items():
                require(payload[key] == value, 'original physical observation bindings')
            p.sha(payload['observationNonce']); challenge = payload
            references.add(item['recordSha256'])
        elif kind == 'OBSERVATION_PRODUCED':
            require(challenge is not None, 'physical response without challenge')
            p.closed(body, [*challenge, 'machineId', 'guardianPid1Verified', 'sharedLockVerified', 'daemonIpcConfined',
                           'exclusiveWriter', 'mutationAdmissionDenied', 'physicalReceipt', 'physicalReceiptSha256',
                           *(['pilotBoundary'] if challenge['type'] == 'HOST_PILOT_BOUNDARY_CHECK' else [])])
            expected_reply = 'GUEST_PILOT_BOUNDARY' if challenge['type'] == 'HOST_PILOT_BOUNDARY_CHECK' else 'GUEST_OBSERVATION'
            require(all(body[k] == v for k, v in challenge.items() if k != 'type') and body['type'] == expected_reply and
                    body['machineId'] == '80a9dfd43bbc6a074cf9148daa5335c2' and
                    all(body[k] is True for k in ['guardianPid1Verified', 'sharedLockVerified', 'daemonIpcConfined',
                                                 'exclusiveWriter', 'mutationAdmissionDenied']) and
                    body['physicalReceiptSha256'] == p.digest(body['physicalReceipt']) and
                    receipts.get(body['physicalReceiptSha256']) == body['physicalReceipt'], 'protected physical response evidence differs')
            if challenge['type'] == 'HOST_PILOT_BOUNDARY_CHECK':
                boundary = body['pilotBoundary']
                p.closed(boundary, ['observationScope', 'installedWorkflow', 'pilotLibrariesLoaded',
                    'guardianEntrySha256', 'installationLibrarySha256', 'persistentTruthImplemented',
                    'persistentMutationAuthorized', 'activationAuthorized', 'deadOwnerKeyAccessAllowed', 'unavailable'])
                require(boundary['observationScope'] == 'native-qa-readonly' and
                    boundary['installedWorkflow'] in ('no-execution', 'readonly-workers') and
                    type(boundary['pilotLibrariesLoaded']) is bool and
                    all(boundary[key] is False for key in ('persistentTruthImplemented', 'persistentMutationAuthorized',
                        'activationAuthorized', 'deadOwnerKeyAccessAllowed')) and
                    boundary['unavailable'] == ['persistent-engine-observer', 'independent-persistent-recovery',
                        'producer-runtime-gates', 'live-handoff-effect-producer', 'dead-owner-authenticated-handoff'],
                    'historical boundary is not persistent authority')
                p.sha(boundary['guardianEntrySha256']); p.sha(boundary['installationLibrarySha256'])
            challenge = None; references.add(item['recordSha256'])
    require(challenge is None and names(proof_fd, 3600) == proof_names, 'partial/foreign/unlinked protected physical evidence')
    return references, receipts, daemon_proofs


class RecoveryQueryUnsettled(RuntimeError):
    """Failure custody handoff to the fixed entry; never a success receipt."""
    def __init__(self, child, raw, reason):
        super().__init__('fixed read-only PID1 query custody unresolved: pid=' + str(child.pid) + '; ' + str(reason)[:256])
        self.query_child = child  # Keep exact Popen/reaping custody, not PID alone.
        self.query_pid = child.pid
        self.query_output = bytes(raw)


def unit_dead(installation, pin, snapshot, authority):
    """One fixed read-only PID1 query. No stop/kill/start API, even on timeout."""
    fd = installation.pin(pin)
    child = None
    data = bytearray()
    try:
        unit_fd = installation.pin(authority['roles']['unitFile'])
        os.close(unit_fd)
        fields = 'Id,LoadState,ActiveState,SubState,MainPID,ControlGroup,Job,FragmentPath,DropInPaths,NeedDaemonReload'
        child = subprocess.Popen(['/usr/bin/systemctl', 'show', '--no-pager', '--property=' + fields,
                                  '--', UNIT], executable='/proc/self/fd/' + str(fd), pass_fds=(fd,),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, close_fds=True, cwd='/')
        os.set_blocking(child.stdout.fileno(), False)
        end = min(snapshot.end, time.monotonic_ns() + 2_000_000_000)
        while True:
            require(time.monotonic_ns() < end, 'fixed PID1 read unresolved; entry must retain utility custody')
            if not select.select([child.stdout], [], [], min(0.05, (end - time.monotonic_ns()) / 1e9))[0]:
                continue
            chunk = os.read(child.stdout.fileno(), min(4096, 16385 - len(data)))
            if not chunk:
                break
            data.extend(chunk); require(len(data) <= 16384, 'PID1 read bound')
        require(child.wait(timeout=max(0.001, (end - time.monotonic_ns()) / 1e9)) == 0, 'PID1 query failed')
        values = {}
        for line in data.decode().splitlines():
            key, sep, value = line.partition('=')
            require(sep and key not in values, 'ambiguous PID1 recovery properties'); values[key] = value
        require(set(values) == set(fields.split(',')) and values['Id'] == UNIT and values['LoadState'] == 'loaded' and
                values['ActiveState'] in ('inactive', 'failed') and values['SubState'] in ('dead', 'failed') and
                values['MainPID'] == '0' and values['Job'] == '' and values['DropInPaths'] == '' and
                values['NeedDaemonReload'] == 'no' and values['FragmentPath'] == authority['roles']['unitFile']['path'],
                'guardian exact loaded unit/queued action remains')
        if values['ControlGroup']:
            require(values['ControlGroup'] == '/system.slice/' + UNIT, 'unexpected guardian cgroup')
            empty_cgroup('/sys/fs/cgroup' + values['ControlGroup'], budget=snapshot.budget)
        elif os.path.lexists('/sys/fs/cgroup/system.slice/' + UNIT):
            empty_cgroup('/sys/fs/cgroup/system.slice/' + UNIT, budget=snapshot.budget)
        return values
    except BaseException as error:
        if child is not None and child.poll() is None:
            raise RecoveryQueryUnsettled(child, data, error) from error
        raise
    finally:
        if child is not None and child.stdout is not None:
            child.stdout.close()
        os.close(fd)
        # Never terminate an actor or a stuck query. The fixed entry must retain
        # child ownership on any exception; no observation can escape that path.


def observe(p, installation, guardian_authority, native_reader):
    require(os.geteuid() == os.getuid() == os.getegid() == 0, 'fixed root recovery entry required')
    # Arguments are fixed-entry-owned pinned objects, not a caller API. Never
    # iterate/open guardian_authority.managerKey or recreate Guardian/Handshake.
    policy = pinned_json(p, installation, guardian_authority['policy'])
    p.closed(policy, ['installation', 'approvedRequestBindings', 'supervisorTable', 'lease', 'journalDirectory',
        'nonceDirectory', 'supervisorProfile', 'ssh', 'worker', 'workerCgroup', 'brokerCgroup', 'candidate', 'physicalWriterProof', 'nativeInstallation', 'workflow'])
    require(policy['workflow'] in ('no-execution', 'readonly-workers') and policy['physicalWriterProof'] is not None,
            'supported independently pinned recovery policy')
    p.closed(policy['approvedRequestBindings'], ['requestSha256', 'guestBootId', 'inputTableSha256'])
    require(p.digest(policy['supervisorTable']) == policy['approvedRequestBindings']['inputTableSha256'], 'full input table policy linkage')
    native_installation = policy['nativeInstallation']
    p.closed(native_installation, ['entry', 'interpreter', 'unitFile', 'policy'])
    for pin in native_installation.values():
        p.closed(pin, ['path', 'bytes', 'sha256', 'veritySha256'])
        p.sha(pin['sha256']); p.sha(pin['veritySha256']); p.integer(pin['bytes'], 1, 64 * MAX)
    require(native_installation['entry']['path'] == '/usr/local/libexec/lunchlineup/development-engine-custodian' and
            native_installation['unitFile']['path'] == '/etc/systemd/system/lunchlineup-development-engines.service',
            'fixed native installation entry/unit')
    q = pinned_json(p, installation, policy['physicalWriterProof'])
    p.closed(q, ['version', 'bootId', 'machineId', 'lsm', 'engines', 'maintenance', 'ownerAuthorization',
        'trustedRootProcesses', 'proofDirectory', 'systemctl', 'containerLimit', 'store', 'runtimeSocket',
        'runtimeDirectories', 'kernelFeatures'])
    require(type(q['version']) is int and q['version'] == 1 and
            q['bootId'] == policy['approvedRequestBindings']['guestBootId'] and
            q['machineId'] == '80a9dfd43bbc6a074cf9148daa5335c2', 'physical policy original target/boot')
    require(type(q['engines']) is dict and set(q['engines']) == {'daemon', 'containerd'}, 'closed native physical engines')
    for entry in q['engines'].values():
        p.closed(entry, ['unit', 'executable', 'config', 'argv', 'cgroup', 'unitFile', 'dropIns'])
    require(q['runtimeSocket'] == {'path': '/run/lunchlineup/engine-custody/raw/containerd.sock'} and
            q['runtimeDirectories'] == ['/run/lunchlineup/engine-custody', '/run/lunchlineup/engine-custody/raw'] and
            type(q['lsm']) is dict and {'native', 'recovery'} <= set(q['lsm']), 'native physical runtime/profile boundary')
    auth = pinned_json(p, installation, q['ownerAuthorization'])
    p.closed(auth, ['bootId', 'requestSha256', 'installationSha256', 'policySha256', 'operatorOwner',
        'approvalReference', 'notAfterBootNs', 'rootWriterRule', 'maintenanceInventorySha256',
        'trustedRootInventorySha256', 'registryPath'])
    require(auth['bootId'] == q['bootId'] and auth['requestSha256'] == policy['approvedRequestBindings']['requestSha256'] and
            auth['installationSha256'] == policy['installation']['guardianInstallationSha256'] and
            auth['policySha256'] == p.digest({key: value for key, value in q.items() if key != 'ownerAuthorization'}) and
            auth['maintenanceInventorySha256'] == p.digest(q['maintenance']) and
            auth['trustedRootInventorySha256'] == p.digest(q['trustedRootProcesses']) and
            auth['rootWriterRule'] == 'only-this-guardian-and-its-fixed-broker;no-concurrent-root-maintenance' and
            auth['registryPath'] == '/run/lunchlineup/development-writer.owner', 'original owner authorization differs')
    require(all(type(auth[k]) is str and 1 <= len(auth[k]) <= 256 for k in ['operatorOwner', 'approvalReference']),
            'named original owner/approval required')
    p.local_nanoseconds(auth['notAfterBootNs'])  # Historical only; never renew authority.
    modules = {}
    for role in ['history', 'broker']:
        fd = installation.pin(guardian_authority['roles'][role])
        try:
            modules[role] = installation.load_module(role, fd)
        finally:
            os.close(fd)
    snapshot = Snapshot()
    try:
        directory = snapshot.directory(policy['journalDirectory'], lock=True)
        directory_names = names(directory, 2048)
        journals = sorted(name for name in directory_names if name.endswith('.guardian'))
        require(len(journals) == 1, 'missing/ambiguous retained original guardian WAL')
        local_id = p.sha(journals[0][:-9])
        raw, _ = snapshot.file(directory, journals[0], 16 * MAX)
        rows = chain(p, raw, 16 * MAX, ['sequence', 'previous', 'kind', 'body'], 'kind', budget=snapshot.budget)
        created = rows[0]['row']['body']
        require(rows[0]['row']['kind'] == 'FENCE_CREATED', 'original fence creation absent')
        p.closed(created, ['fence', 'guestFenceSha256', 'device', 'inode'])
        fence = created['fence']
        p.closed(fence, ['localSessionId', 'guestBootId', 'guardianPid', 'guardianStarttime', 'requestSha256'])
        require(fence['localSessionId'] == local_id and fence['requestSha256'] == policy['approvedRequestBindings']['requestSha256'] and
                fence['guestBootId'] == policy['approvedRequestBindings']['guestBootId'] and
                re.fullmatch('[a-f0-9-]{36}', fence['guestBootId']), 'original fence/policy identity')
        fence_bytes = p.canonical(fence) + b'\n'
        require(digest(fence_bytes) == created['guestFenceSha256'], 'original newline fence hash')
        dead(fence['guardianPid'], fence['guardianStarttime'], fence['guestBootId'])
        pid1 = unit_dead(installation, q['systemctl'], snapshot, guardian_authority)
        present = 'active.fence' in directory_names
        if present:
            actual, info = snapshot.file(directory, 'active.fence', MAX)
            require(actual == fence_bytes and (str(info.st_dev), str(info.st_ino)) == (created['device'], created['inode']),
                    'original active fence inode/bytes changed')
        custody = [item for item in rows if item['row']['kind'] == 'CUSTODY']
        require(len(custody) == 1, 'missing/ambiguous original host custody')
        epoch = custody[0]['row']['body']['epoch']
        requests = [item['row']['body']['envelope']['payload'] for item in rows if item['row']['kind'] == 'OUTGOING_PREPARED' and
                    item['row']['body']['envelope']['payload'].get('type') == 'REQUEST']
        terminals = [item['row']['body']['envelope']['payload'] for item in rows if item['row']['kind'] == 'OUTGOING_PREPARED' and
                    item['row']['body']['envelope']['payload'].get('type') == 'TERMINAL']
        require(len(requests) == len(terminals) == 1, 'complete original REQUEST/TERMINAL required')
        request, terminal = requests[0], terminals[0]
        p.closed(request, ['type', 'nonce', 'requestSha256', 'guestBootId', 'inputTableSha256'])
        require(all(request[k] == v for k, v in policy['approvedRequestBindings'].items()), 'original request independent selection differs')
        nonce = p.sha(request['nonce'])
        nonce_fd = snapshot.directory(policy['nonceDirectory'])
        require(names(nonce_fd, 2048) == {nonce, nonce + '.exchange'}, 'foreign/unknown nonce history')
        core_raw, _ = snapshot.file(nonce_fd, nonce, 4 * MAX)
        exchange_raw, _ = snapshot.file(nonce_fd, nonce + '.exchange', 4 * MAX)
        core_rows = chain(p, core_raw, 4 * MAX, ['sequence', 'previous', 'event', 'details'], 'event', budget=snapshot.budget)
        require(len(core_rows) >= 2 and core_rows[1]['row']['event'] == 'LEASE_CONTEXT', 'original core lease context absent')
        context = core_rows[1]['row']['details']
        require(context['request'] == request and context['epoch'] == epoch and context['policy'] == policy['lease'], 'core/original protected context mismatch')
        deadline = p.local_nanoseconds(context['unitDeadlineNs'])
        expected = {'nonce': nonce, 'requestSha256': request['requestSha256'], 'inputTableSha256': request['inputTableSha256'],
            'epochProofSha256': p.digest(epoch), 'policy': policy['lease'], 'localSessionId': local_id,
            'guardianSessionId': epoch['guardianSessionId'], 'grantId': terminal['grantId'],
            'managerEpoch': epoch['managerEpoch'], 'selectionSha256': policy['lease']['selectionSha256'],
            'protocolPin': guardian_authority['roles']['protocol'], 'guardianUnitSha256': guardian_authority['roles']['unitFile']['sha256'],
            'budget': snapshot.budget}
        expected['terminalBindings'] = {'grantId': terminal['grantId'], 'managerEpoch': epoch['managerEpoch'],
            'guestBootId': request['guestBootId'], 'requestSha256': request['requestSha256'], 'guardianSessionId': epoch['guardianSessionId'],
            'requestNonce': nonce, 'terminalSha256': p.digest(terminal), 'inputTableSha256': request['inputTableSha256'],
            'selectionSha256': policy['lease']['selectionSha256']}
        expected['observationBindings'] = {key: expected['terminalBindings'][key] for key in
            ['guestBootId', 'requestSha256', 'guardianSessionId', 'managerEpoch', 'requestNonce', 'inputTableSha256', 'selectionSha256']}
        expected['observationBindings'].update(guardianInstallationSha256=policy['installation']['guardianInstallationSha256'],
            custodyPolicySha256=policy['lease']['custodyPolicySha256'])
        workers = worker_reconciliation(p, modules['history'], modules['broker'], rows, policy, expected, snapshot, directory)
        binding = {'guestBootId': fence['guestBootId'], 'requestSha256': request['requestSha256'], 'requestNonce': nonce,
                   'guardianSessionId': epoch['guardianSessionId'], 'localSessionId': local_id}
        links, native_custody = native_links(p, rows, binding, request['inputTableSha256'], modules['broker'], workers, deadline, snapshot.budget)
        # Native reader owns full identity/WAL/wire/custody grammar. It MUST
        # hold the SAME selected generation and custody across these calls.
        require(native_reader.verify_links(binding, links) is None, 'native linkage reader contract')
        native = native_observation(p, native_reader, binding)
        bootstrap = native_custody['row']['body']['bootstrap']
        require(deadline <= positive_decimal(bootstrap['deadlineNs']), 'recovered core lifetime exceeds original native bound')
        require(native['engineIdentitySha256'] == bootstrap['identitySha256'] and
                native['birthRecordSha256'] == bootstrap['birthRecordSha256'] and
                bootstrap['nativePolicySha256'] == native_installation['policy']['sha256'], 'native original birth/identity/policy linkage')
        expected['nativeRecords'] = {item['recordSha256'] for item in links}
        expected['nativeIdentitySha256'] = native['engineIdentitySha256']
        expected['nativeBirthRecordSha256'] = native['birthRecordSha256']
        original_owner = {'bootId': fence['guestBootId'], 'guardianPid': fence['guardianPid'],
            'guardianStarttime': fence['guardianStarttime'], 'localSessionId': local_id,
            'requestSha256': request['requestSha256'], 'authorizationSha256': q['ownerAuthorization']['sha256']}
        expected['ownerRegistrySha256'] = p.digest(original_owner)
        expected['physicalRecords'], physical, expected['daemonProofs'] = physical_records(p, rows, q, snapshot, fence, expected)
        reconciled = reconcile_wal(p, rows, policy, guardian_authority, core_raw, exchange_raw, workers, expected, modules['history'])
        observed = reconciled['observation']
        require(observed['terminal'] == terminal, 'terminal owner/exchange/core mismatch')
        if observed['readonlyTerminal'] is not None:
            require(observed['readonlyTerminal']['preflightSha256'] == p.digest(workers['results']['archive-preflight']) and
                    observed['readonlyTerminal']['inventorySha256'] == p.digest(workers['results']['image-inventory']), 'full results/terminal linkage')
        adopted = reconciled['adopted']
        actors = [(adopted['supervisorPid'], adopted['supervisorStarttime']), *workers['actors']]
        for pid, start in actors:
            dead(pid, start, fence['guestBootId'])
        for path, identity in workers['slots']:
            empty_cgroup(path, identity, budget=snapshot.budget)
        # Exact retained writer registry is not removed/adopted/rewritten.
        registry_fd = snapshot.directory('/run/lunchlineup', private=False)
        owner_raw, _ = snapshot.file(registry_fd, 'development-writer.owner', MAX)
        owner = p.parse(owner_raw)
        require(owner_raw == p.canonical(owner) and owner == original_owner, 'retained writer registry binding')
        notice, intent, retired = reconciled['notice'], reconciled['intent'], reconciled['retired']
        require((present and retired is None) or (not present and intent is not None), 'fence absence/retirement remains uncertain')
        allowed = {journals[0], *[item['name'] for item, _ in workers['responses']]}
        if present:
            allowed.add('active.fence')
        finalizer_name = local_id + '.finalizer'
        if finalizer_name in directory_names:
            finalizer_raw, _ = snapshot.file(directory, finalizer_name, MAX)
            finalizer = p.parse(finalizer_raw[:-1])
            p.closed(finalizer, ['kind', 'localSessionId', 'fenceSha256', 'guardianHistorySha256', 'cgroups',
                'outcome', 'authorityRestored', 'fenceClearAuthorized', 'automaticRetryAllowed'])
            require(finalizer_raw == p.canonical(finalizer) + b'\n' and
                    finalizer['kind'] == 'guardian-finalizer-observation' and finalizer['localSessionId'] == local_id and
                    finalizer['fenceSha256'] == created['guestFenceSha256'] and finalizer['guardianHistorySha256'] == digest(raw) and
                    finalizer['outcome'] == 'unresolved' and all(finalizer[key] is False for key in
                    ['authorityRestored', 'fenceClearAuthorized', 'automaticRetryAllowed']) and
                    type(finalizer['cgroups']) is list, 'exact retained finalizer receipt differs')
            registered = dict(workers['slots'])
            seen = set()
            for entry in finalizer['cgroups']:
                snapshot.budget()
                p.closed(entry, ['path', 'device', 'inode', 'recursiveEmptyObserved'])
                require(entry['path'] in registered and entry['path'] not in seen and
                        type(entry['device']) is type(entry['inode']) is int and
                        (entry['device'], entry['inode']) == registered[entry['path']] and
                        entry['recursiveEmptyObserved'] is True, 'finalizer registered subtree observation differs')
                seen.add(entry['path'])
            require(seen == set(registered), 'finalizer registered subtree coverage incomplete')
            allowed.add(finalizer_name)
        require(directory_names == allowed, 'foreign/unknown/unlinked guardian directory artifact')
        notice_envelope = notice['row']['body']['envelope'] if notice else None
        fence_identity = {'device': created['device'], 'inode': created['inode'], 'guestFenceSha256': created['guestFenceSha256'],
                          'localSessionId': local_id, 'guardianSessionId': epoch['guardianSessionId']}
        if notice:
            require(notice['row']['body']['guestFenceIdentity'] == fence_identity and
                    notice_envelope['payload']['ackSha256'] == p.digest(observed['managerAck']) and
                    notice['row']['body']['physicalReceiptSha256'] in physical, 'notice original fence/ACK/physical linkage')
        require(names(directory, 2048) == directory_names and names(nonce_fd, 2048) == {nonce, nonce + '.exchange'}, 'protected namespace changed')
        dead(fence['guardianPid'], fence['guardianStarttime'], fence['guestBootId'])
        require(unit_dead(installation, q['systemctl'], snapshot, guardian_authority) == pid1, 'guardian fixed unit changed during recovery')
        for pid, start in actors:
            dead(pid, start, fence['guestBootId'])
        for path, identity in workers['slots']:
            empty_cgroup(path, identity, budget=snapshot.budget)
        require(native_reader.verify_links(binding, links) is None and native_observation(p, native_reader, binding) == native,
                'native selected generation/custody changed during recovery')
        snapshot.stable(directory)
        return {'version': 1, 'guardianSessionId': epoch['guardianSessionId'], 'localSessionId': local_id,
            'requestNonce': nonce, 'requestSha256': request['requestSha256'], 'guestBootId': fence['guestBootId'],
            'terminalSha256': p.digest(terminal), 'ackSha256': p.digest(observed['managerAck']),
            'hostClearedEnvelopeSha256': p.digest(notice_envelope) if notice else None,
            'retirementNonce': notice_envelope['payload']['challengeNonce'] if notice else None,
            'guestFencePresent': present, 'guestFenceSha256': created['guestFenceSha256'],
            'guestRetirementStage': 'GUEST_RETIRED' if retired else 'GUEST_RETIRE_INTENT' if intent else
                'HOST_CLEARED_RECEIVED' if notice else 'LOCAL_RELEASE' if reconciled['localRelease'] else 'ACK',
            'guestRetirementRecordSha256': retired['recordSha256'] if retired else None,
            'protectedHistorySha256': digest(raw), 'authorityRestored': False, 'fenceClearAuthorized': False,
            'automaticRetryAllowed': False, 'requiresSeparateOwnerRecovery': True}
    finally:
        snapshot.close()


if __name__ == '__main__':
    raise SystemExit('Pinned read-only recovery library only; no CLI, keys, repair or authority.')

