#!/usr/bin/env python3
"""Proposed admission primitives only. No CLI activation or Docker execution.

Manager authentication and daemon-settlement adapters intentionally refuse until
independently implemented and installed. Never import this as an authority token.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import struct
import time

MAX_JSON = 1024 * 1024
MAX_LEDGER = 4 * 1024 * 1024
LOCK = '/run/lock/lunchlineup-deploy.lock'
TARGET = ('Proxmox1', 107, 'lunchlineup-dev', '80a9dfd43bbc6a074cf9148daa5335c2')


class Refusal(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def canonical(value):
    # Protocol v1: UTF-8, sorted keys, compact separators, ASCII escapes, no LF.
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('ascii')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def parse(data):
    require(isinstance(data, bytes) and 0 < len(data) <= MAX_JSON, 'JSON byte bound')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    def invalid(_):
        raise Refusal('non-integer protocol number')
    value = json.loads(data.decode('utf-8'), object_pairs_hook=unique,
                       parse_float=invalid, parse_constant=invalid)
    def bounded(item, depth=0):
        require(depth <= 32, 'JSON nesting bound')
        if isinstance(item, dict):
            for child in item.values():
                bounded(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                bounded(child, depth + 1)
        elif type(item) is int:
            require(abs(item) <= 2**53 - 1, 'protocol integer bound')
    bounded(value)
    return value


def closed(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys), 'closed object shape')


def validate(schema, value):
    """Only the constructs used by the pinned admission request schema."""
    if 'const' in schema:
        require(type(value) is type(schema['const']) and value == schema['const'], 'constant mismatch')
    if 'enum' in schema:
        require(value in schema['enum'], 'enum mismatch')
    types = {'object': dict, 'array': list, 'string': str, 'integer': int, 'boolean': bool}
    if 'type' in schema:
        require(type(value) is types[schema['type']], 'type mismatch')
    if isinstance(value, dict):
        require(set(schema.get('required', [])) <= set(value), 'required field missing')
        if schema.get('additionalProperties') is False:
            require(set(value) <= set(schema.get('properties', {})), 'unknown field')
        for key, child in schema.get('properties', {}).items():
            if key in value:
                validate(child, value[key])
    if isinstance(value, list):
        require(len(value) >= schema.get('minItems', 0), 'array bound')
        if schema.get('uniqueItems'):
            require(len({canonical(x) for x in value}) == len(value), 'duplicate array item')
        for item in value:
            if 'items' in schema:
                validate(schema['items'], item)
    if isinstance(value, str):
        require(len(value) >= schema.get('minLength', 0), 'string bound')
        if 'pattern' in schema:
            require(re.search(schema['pattern'], value) is not None, 'pattern mismatch')
        if schema.get('format') == 'date-time':
            parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            require(parsed.utcoffset() == datetime.timedelta(0), 'UTC recovery time required')
    if type(value) is int:
        require(value >= schema.get('minimum', value) and value <= schema.get('maximum', value), 'integer range')
    def matches(child):
        try:
            validate(child, value)
            return True
        except (Refusal, ValueError, TypeError):
            return False
    if 'not' in schema:
        require(not matches(schema['not']), 'forbidden value')
    if 'oneOf' in schema:
        require(sum(matches(child) for child in schema['oneOf']) == 1, 'oneOf mismatch')
    for child in schema.get('allOf', []):
        if 'if' not in child or matches(child['if']):
            validate(child.get('then', child), value)


def open_root_file(path, flags=os.O_RDONLY):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'noncanonical path')
    for part in [path, *path.parents]:
        info = part.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'root custody absent')
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refusal('regular file required')
    return fd


class PinnedInputs:
    def __init__(self):
        self.fds = {}

    def add(self, role, entry):
        closed(entry, ['path', 'bytes', 'sha256', 'veritySha256'])
        require(role not in self.fds, 'duplicate input role')
        fd = open_root_file(entry['path'])
        try:
            info = os.fstat(fd)
            require(info.st_size == entry['bytes'], 'input size differs')
            # Linux FS_IOC_MEASURE_VERITY, SHA256 only. Unsupported -> refusal.
            measurement = bytearray(struct.pack('HH', 0, 64) + bytes(64))
            fcntl.ioctl(fd, 0xC0046686, measurement, True)
            algorithm, length = struct.unpack('HH', measurement[:4])
            require(algorithm == 1 and length == 32 and measurement[4:36].hex() == entry['veritySha256'], 'verity identity differs')
            h = hashlib.sha256()
            while chunk := os.read(fd, 1024 * 1024):
                h.update(chunk)
            require(h.hexdigest() == entry['sha256'], 'content differs')
            os.lseek(fd, 0, os.SEEK_SET)
            self.fds[role] = fd
        except BaseException:
            os.close(fd)
            raise

    def rewind(self, role):
        fd = self.fds[role]
        os.lseek(fd, 0, os.SEEK_SET)
        return fd  # Supervisor alone controls readers/offsets; no pathname reopen.

    def close(self):
        for fd in self.fds.values():
            os.close(fd)
        self.fds.clear()


class ManagerVerifier:
    def verify(self, authenticated_envelope, expected_message_type):
        # Installed peer/cryptographic transport implementation must return the
        # authenticated canonical message. Never accept a request's verified flag.
        raise Refusal('Manager authentication adapter is not implemented')


class Core:
    def __init__(self, verifier):
        self.verifier = verifier
        self.lock_fd = None
        self.ledger_fd = None
        self.inputs = PinnedInputs()
        self.state = 'NEW'
        self.sequence = 0
        self.previous = '0' * 64
        self.bytes_written = 0
        self.resources = {}

    def select(self, request_bytes, approved_request_bytes, schema):
        require(self.state == 'NEW', 'invalid selection state')
        request = parse(request_bytes)
        approved = parse(approved_request_bytes)
        validate(schema, request)
        require(canonical(request) == canonical(approved), 'request differs from independent installed policy')
        target = request['target']
        require(tuple(target[k] for k in ['estate', 'vmid', 'hostname', 'machineId']) == TARGET, 'wrong estate')
        selection = request['selection']
        require(selection['project'] not in ('lunchlineup', 'lunchlineup-ux-20260907'), 'retained project forbidden')
        plan = request['operationPlan']
        if 'source' in plan:
            source, restore = plan['source'], plan['restore']
            same_instance = source['postgresContainerId'] == restore['postgresContainerId']
            if request['operation'] == 'backup-proof':
                require(source['database'] != restore['database'], 'logical restore database must differ')
                if same_instance:
                    require(source['volumeName'] == restore['volumeName'] and source['volumeMountIdentitySha256'] == restore['volumeMountIdentitySha256'], 'same-instance storage identity differs')
            else:
                require(not same_instance, 'physical restore instance must differ')
            if not same_instance:
                require(source['volumeName'] != restore['volumeName'] and source['volumeMountIdentitySha256'] != restore['volumeMountIdentitySha256'], 'independent restore storage absent')
            # These compare approved declarations; live instance/mount verification
            # remains an unimplemented dispatch gate, never inferred from strings.
            if 'backup' in plan:
                require(plan['backup']['sourceSystemIdentifier'] == source['systemIdentifier'] == plan['recoveryTarget']['systemIdentifier'], 'recovery system identity differs')
        self.request = request
        self.request_digest = digest(request)
        self.state = 'SELECTED'

    def reserve(self, nonce_directory, *, guardian=None):
        require(self.state == 'SELECTED', 'invalid reserve state')
        # Directory creation/installation is deliberately not performed here.
        directory = Path(nonce_directory)
        require(directory.resolve(strict=True) == directory, 'nonce directory not canonical')
        for part in [directory, *directory.parents]:
            info = part.lstat()
            require(info.st_uid == 0 and not info.st_mode & 0o022, 'nonce directory custody absent')
        if guardian is None:
            self.lock_fd = open_root_file(LOCK, os.O_RDWR)
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            # Only the fixed pinned bootstrap calls this internal branch after
            # live guardian/PID1/peer/epoch/kcmp validation. No public FD input.
            guardian.assert_live()
            self.lock_fd = guardian.duplicate_lock()
            # Never flock/reopen/unlock the guardian's shared OFD here.
        # The namespace policy is part of the reservation transaction under flock.
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            observed = os.fstat(directory_fd)
            require(observed.st_uid == 0 and not observed.st_mode & 0o022, 'nonce directory FD custody absent')
            require(not os.listdir(directory_fd), 'prior nonce records require Manager reconciliation')
            self.nonce = secrets.token_hex(32)
            self.ledger_fd = os.open(self.nonce, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory_fd)
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        # O_EXCL + fsync leaves a permanent spent nonce even on crash/restart.
        self.record('RESERVED', {'requestSha256': self.request_digest, 'nonce': self.nonce})
        dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
        self.state = 'RESERVED'

    def record(self, event, details):
        require(self.ledger_fd is not None and self.sequence < 4096, 'ledger unavailable/full')
        row = {'sequence': self.sequence, 'previous': self.previous, 'event': event, 'details': details}
        data = canonical(row) + b'\n'
        require(len(data) <= MAX_JSON and self.bytes_written + len(data) <= MAX_LEDGER, 'ledger byte bound')
        view = memoryview(data)
        while view:
            count = os.write(self.ledger_fd, view)
            require(count > 0, 'ledger short write')
            view = view[count:]
        os.fsync(self.ledger_fd)
        self.previous = hashlib.sha256(data).hexdigest()
        self.sequence += 1
        self.bytes_written += len(data)

    def challenge(self, boot_id, input_table_digest):
        require(self.state == 'RESERVED', 'invalid challenge state')
        self.boot_id = boot_id
        self.input_digest = input_table_digest
        self.sent_ns = time.monotonic_ns()
        self.state = 'CHALLENGED'
        return {'type': 'REQUEST', 'nonce': self.nonce, 'requestSha256': self.request_digest,
                'guestBootId': boot_id, 'inputTableSha256': input_table_digest}

    def accept_grant(self, envelope):
        require(self.state == 'CHALLENGED', 'invalid grant state')
        grant = self.verifier.verify(envelope, 'GRANT')
        closed(grant, ['type', 'nonce', 'requestSha256', 'guestBootId', 'inputTableSha256', 'grantId', 'managerEpoch', 'sequence', 'durationMs', 'maxRoundTripMs'])
        require(all(isinstance(grant[k], str) and 0 < len(grant[k]) <= 128 for k in ['grantId', 'managerEpoch']), 'invalid grant/Manager epoch')
        require(grant['type'] == 'GRANT' and grant['nonce'] == self.nonce and grant['requestSha256'] == self.request_digest and grant['guestBootId'] == self.boot_id and grant['inputTableSha256'] == self.input_digest and type(grant['sequence']) is int and grant['sequence'] == 0, 'grant binding differs')
        require(type(grant['durationMs']) is int and 0 < grant['durationMs'] <= min(60000, self.request['limits']['maxSeconds'] * 1000), 'grant duration invalid')
        require(type(grant['maxRoundTripMs']) is int and 0 < grant['maxRoundTripMs'] <= 5000, 'round trip bound invalid')
        now = time.monotonic_ns()
        self.expiry_ns = self.sent_ns + grant['durationMs'] * 1000000
        require(now - self.sent_ns <= grant['maxRoundTripMs'] * 1000000 and now < self.expiry_ns, 'late grant')
        self.grant = grant
        self.record('GRANT', grant)
        self.state = 'ADMITTED_NO_EXECUTION'

    def child_context(self):
        # Creating a socket or duplicating flock is not authenticating a child.
        raise Refusal('installed child executable/peer custody adapter is not implemented')

    def dispatch(self, operation):
        # No Docker/client/child entry point exists in this core revision.
        raise Refusal('daemon settlement, immutable FD integration and child custody are not implemented')

    def terminal(self):
        require(self.state in ('RESERVED', 'CHALLENGED', 'ADMITTED_NO_EXECUTION'), 'invalid terminal state')
        require(not self.resources, 'unsettled resources')
        self.record('TERMINAL', {'outcome': 'no-execution', 'cliSettled': True, 'daemonRequestsDispatched': 0, 'survivors': []})
        self.state = 'TERMINAL_PENDING_ACK'
        self.terminal_identity = {'grantId': getattr(self, 'grant', {}).get('grantId'), 'managerEpoch': getattr(self, 'grant', {}).get('managerEpoch'), 'grantSequence': getattr(self, 'grant', {}).get('sequence'), 'guestBootId': getattr(self, 'boot_id', None)}
        return dict(self.terminal_identity, **{'type': 'TERMINAL', 'nonce': self.nonce, 'requestSha256': self.request_digest, 'ledgerSha256': self.previous, 'outcome': 'no-execution'})

    def acknowledge(self, envelope):
        require(self.state == 'TERMINAL_PENDING_ACK', 'invalid ACK state')
        ack = self.verifier.verify(envelope, 'ACK')
        closed(ack, ['type', 'nonce', 'requestSha256', 'ledgerSha256', *self.terminal_identity])
        require(canonical(ack) == canonical(dict(self.terminal_identity, **{'type': 'ACK', 'nonce': self.nonce, 'requestSha256': self.request_digest, 'ledgerSha256': self.previous})), 'ACK differs')
        self.record('ACK', ack)
        self.state = 'ACKNOWLEDGED'
        errors = []
        fds = list(self.inputs.fds.values())
        self.inputs.fds.clear()
        for attribute in ['ledger_fd', 'lock_fd']:
            fd = getattr(self, attribute)
            setattr(self, attribute, None)
            if fd is not None:
                fds.append(fd)
        for fd in fds:
            try:
                os.close(fd)
            except OSError as error:
                errors.append(error)
        if errors:
            raise errors[0]


if __name__ == '__main__':
    raise SystemExit('Development admission core is not integrated; all execution refused.')
