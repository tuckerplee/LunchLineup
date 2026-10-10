#!/usr/bin/env python3
"""Unintegrated no-dispatch bootstrap. No network transport or Docker calls.
Installed root policy supplies exact public pins; only guardian holds Manager key.
"""
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import struct
import types

ANCHOR = '/etc/lunchlineup/trust/development-bootstrap.json'
MAX = 1024 * 1024


def refuse(message):
    raise ValueError(message)


def closed(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        refuse('closed bootstrap object required')


def decode(data):
    if not 0 < len(data) <= MAX:
        refuse('bootstrap JSON bound')
    def unique(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                refuse('duplicate bootstrap key')
            out[key] = value
        return out
    return json.loads(data, object_pairs_hook=unique)


def open_controlled(path):
    p = Path(path)
    if not p.is_absolute() or p.resolve(strict=True) != p:
        refuse('noncanonical installed input')
    for component in [p, *p.parents]:
        info = component.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            refuse('installed input custody absent')
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        refuse('installed regular file required')
    return fd


def pin(entry, private=False):
    closed(entry, ['path', 'bytes', 'sha256', 'veritySha256'])
    if type(entry['bytes']) is not int or not 0 < entry['bytes'] <= MAX:
        refuse('installed input size bound')
    fd = open_controlled(entry['path'])
    try:
        info = os.fstat(fd)
        if private and (info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077):
            refuse('Manager key must exclude all group/other access')
        if info.st_size != entry['bytes']:
            refuse('installed input size differs')
        measure = bytearray(struct.pack('HH', 0, 64) + bytes(64))
        fcntl.ioctl(fd, 0xC0046686, measure, True)
        if struct.unpack('HH', measure[:4]) != (1, 32) or measure[4:36].hex() != entry['veritySha256']:
            refuse('installed verity pin differs')
        data = os.read(fd, MAX + 1)
        if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            refuse('installed content pin differs')
        os.lseek(fd, 0, os.SEEK_SET)
        metadata = dict(entry, device=info.st_dev, inode=info.st_ino)
        return fd, data, metadata
    except BaseException:
        os.close(fd)
        raise


class Session:
    """Only initial REQUEST/GRANT and no-execution TERMINAL/ACK are implemented."""
    def __init__(self, core, held, journal_fd, key, key_id, table):
        self.core, self.held, self.journal = core, held, journal_fd
        self.key, self.key_id, self.table = key, key_id, table
        self.sequence, self.bytes, self.poisoned = 0, 0, False
        self.out_sequence = 0
        self.inventory_phase = 'NOT_REQUESTED'
        self.journal_hash = hashlib.sha256()

    def persist(self, direction, message):
        if self.poisoned:
            refuse('poisoned exchange cannot resume')
        data = self.module.canonical({'direction': direction, 'message': message}) + b'\n'
        if len(data) > MAX or self.bytes + len(data) > 4 * MAX:
            self.abort()
            refuse('exchange journal bound')
        try:
            remaining = memoryview(data)
            while remaining:
                n = os.write(self.journal, remaining)
                if n <= 0:
                    refuse('exchange journal write failed')
                remaining = remaining[n:]
            os.fsync(self.journal)
            self.bytes += len(data)
            self.journal_hash.update(data)
        except BaseException:
            self.abort()
            raise

    def verify(self, envelope_bytes, expected_message_type):
        envelope = self.module.parse(envelope_bytes)
        closed(envelope, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
        if type(envelope['version']) is not int or envelope['version'] != 1 or envelope['keyId'] != self.key_id or type(envelope['sequence']) is not int or envelope['sequence'] != self.sequence:
            refuse('authenticated exchange sequence/version differs')
        if envelope['domain'] != 'lunchlineup-development-admission-v1' or envelope['direction'] != 'manager-to-supervisor' or not isinstance(envelope['payload'], dict):
            refuse('Manager envelope domain/direction/payload differs')
        message = {k: envelope[k] for k in ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload']}
        expected = hmac.new(self.key, self.module.canonical(message), hashlib.sha256).hexdigest()
        if not isinstance(envelope['mac'], str) or not hmac.compare_digest(expected, envelope['mac']) or envelope['payload'].get('type') != expected_message_type:
            refuse('Manager envelope authentication failed')
        # Persist authenticated bytes before consuming sequence or returning grant.
        self.persist('manager', envelope)
        self.sequence += 1
        return envelope['payload']

    def outgoing(self, payload):
        message = {'version': 1, 'domain': 'lunchlineup-development-admission-v1', 'direction': 'supervisor-to-manager', 'keyId': self.key_id, 'sequence': self.out_sequence, 'payload': payload}
        envelope = dict(message, mac=hmac.new(self.key, self.module.canonical(message), hashlib.sha256).hexdigest())
        self.persist('supervisor', envelope)
        self.out_sequence += 1
        return envelope

    def challenge(self):
        try:
            if self.poisoned:
                refuse('poisoned exchange cannot resume')
            boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            message = self.core.challenge(boot_id, self.module.digest(self.table))
            return self.outgoing(message)
        except BaseException:
            self.abort()
            raise

    def receive_grant(self, envelope):
        try:
            self.core.accept_grant(envelope)
        except BaseException:
            self.abort()
            raise

    def terminal(self):
        # A pending inventory exchange must finish before normal settlement.
        # Refusal writes nothing and leaves it consumable; explicit abort instead
        # poisons custody and preserves the unsupported partial journal.
        if self.inventory_phase not in ('NOT_REQUESTED', 'COMPLETED'):
            refuse('inventory must settle or session must abort before terminal')
        try:
            message = self.core.terminal()
            self.pending_terminal = message
            return self.outgoing(message)
        except BaseException:
            self.abort()
            raise

    def receive_ack(self, envelope):
        try:
            self.core.acknowledge(envelope)
            self.close_inputs()
        except BaseException:
            self.abort()
            raise

    def preflight_images(self):
        """Installed-binding-only, no-dispatch adapter; no arbitrary role arguments."""
        import time
        try:
            def live_session():
                if self.poisoned or self.core.state != 'ADMITTED_NO_EXECUTION' or time.monotonic_ns() >= self.core.expiry_ns:
                    refuse('initial admitted session expired or unavailable')
            live_session()
            binding = self.candidate_binding
            closed(binding, ['policy', 'inputs', 'evidenceDirectory', 'inventoryBinding'])
            # Bounds precede PinnedInputs.add's integrity reads as well as parser IO.
            closed(binding['policy'], ['path', 'bytes', 'sha256', 'veritySha256'])
            if type(binding['policy']['bytes']) is not int or not 0 < binding['policy']['bytes'] <= MAX:
                refuse('candidate policy bound')
            roles = binding['inputs']
            if not isinstance(roles, dict) or not {'manifest', 'helper'} <= set(roles) or len(roles) > 66:
                refuse('candidate role set invalid')
            total = 0
            for role, entry in roles.items():
                closed(entry, ['path', 'bytes', 'sha256', 'veritySha256'])
                if type(entry['bytes']) is not int or not 0 < entry['bytes'] <= (32 * 1024**3 if role.startswith('archive:') else 16 * MAX):
                    refuse('candidate input byte bound')
                if role.startswith('archive:'):
                    total += entry['bytes']
                elif role not in ('manifest', 'helper'):
                    refuse('unknown candidate role')
            if total > 64 * 1024**3:
                refuse('candidate aggregate archive limit before pin scan')
            selected = self.core.request['selection']
            selected_helper = self.core.request['installedHelpers']['archivePreflight']
            if roles['manifest']['path'] != selected['artifactManifest'] or roles['manifest']['sha256'] != selected['artifactManifestSha256'] or roles['helper']['path'] != selected_helper['path'] or roles['helper']['sha256'] != selected_helper['sha256']:
                refuse('candidate role differs from approved request')
            self.core.inputs.add('candidatePolicy', binding['policy'])
            fd = self.core.inputs.rewind('candidatePolicy')
            policy = self.module.parse(os.read(fd, MAX + 1))
            os.lseek(fd, 0, os.SEEK_SET)
            if policy['sourceSha'] != selected['sourceSha'] or policy['treeSha'] != selected['treeSha'] or policy['manifestSha256'] != roles['manifest']['sha256'] or policy['helperSha256'] != roles['helper']['sha256']:
                refuse('independently pinned candidate policy differs')
            table = {}
            for role, entry in roles.items():
                live_session()
                self.core.inputs.add('preflight:' + role, entry)
                fd = self.core.inputs.rewind('preflight:' + role)
                info = os.fstat(fd)
                table[role] = {'fd': fd, 'bytes': entry['bytes'], 'sha256': entry['sha256'],
                    'veritySha256': entry['veritySha256'], 'device': info.st_dev, 'inode': info.st_ino}
            helper_fd = table['helper']['fd']
            os.lseek(helper_fd, 0, os.SEEK_SET)
            source = os.read(helper_fd, 16 * MAX + 1)
            os.lseek(helper_fd, 0, os.SEEK_SET)
            if hashlib.sha256(source).hexdigest() != policy['helperSha256']:
                refuse('loaded callable helper identity differs')
            helper = types.ModuleType('installed_fd_archive_preflight')
            exec(compile(source, roles['helper']['path'], 'exec'), helper.__dict__)
            live_session()
            result = helper.bundle_preflight_fds(table, policy)
            live_session()
            if result['receipt']['loadAuthorized'] is not False or result['receipt']['inventoryStatus'] != 'pending-live-owner-custody':
                refuse('parser returned unexpected authority')
            # Persist result before ledger link. Failed writes preserve evidence and
            # poison the admission; no in-memory result is treated as completed.
            data = self.module.canonical({'kind': 'supervisor-fd-preflight-evidence',
                'nonce': self.core.nonce, 'requestSha256': self.core.request_digest,
                'candidatePolicySha256': binding['policy']['sha256'],
                'supervisorArchiveIntegrityHashBytes': total, 'result': result}) + b'\n'
            if len(data) > MAX:
                refuse('preflight evidence byte limit')
            directory = Path(binding['evidenceDirectory'])
            if not directory.is_absolute() or directory.resolve(strict=True) != directory:
                refuse('invalid candidate evidence directory')
            for part in [directory, *directory.parents]:
                st = part.lstat()
                if st.st_uid != 0 or st.st_mode & 0o022:
                    refuse('candidate evidence directory custody absent')
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                sink_info = os.fstat(directory_fd)
                nonce_info = os.stat(self.nonce_directory, follow_symlinks=False)
                if sink_info.st_mode & 0o077 or (sink_info.st_dev, sink_info.st_ino) == (nonce_info.st_dev, nonce_info.st_ino):
                    refuse('separate private candidate evidence directory required')
                name = self.core.nonce + '.archive-preflight.json'
                output_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory_fd)
                try:
                    pending = memoryview(data)
                    while pending:
                        n = os.write(output_fd, pending)
                        if n <= 0:
                            refuse('preflight evidence short write')
                        pending = pending[n:]
                    os.fsync(output_fd)
                finally:
                    os.close(output_fd)
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            receipt = {'path': str(directory / name), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
            live_session()
            self.core.record('ARCHIVE_PREFLIGHT', receipt)
            self.archive_preflight_result = result
            return receipt
        except BaseException:
            self.abort()
            raise

    def inventory_challenge(self):
        import time
        try:
            if self.poisoned or self.inventory_phase != 'NOT_REQUESTED' or self.core.state != 'ADMITTED_NO_EXECUTION' or time.monotonic_ns() >= self.core.expiry_ns or not hasattr(self, 'archive_preflight_result'):
                refuse('inventory requires current admitted archive preflight')
            # Take a canonical value snapshot, not a mutable receipt alias.
            binding = self.module.parse(self.module.canonical(self.candidate_binding['inventoryBinding']))
            closed(binding, ['managerContextId', 'candidateSha', 'preflightSha256', 'daemonId', 'dockerRootDir', 'serverVersion', 'maxImages'])
            if binding['candidateSha'] != self.core.request['selection']['sourceSha'] or binding['preflightSha256'] != self.archive_preflight_result['sha256']:
                refuse('installed inventory binding differs from preflight')
            self.inventory_request = {'type': 'INVENTORY_REQUEST', 'nonce': self.core.nonce,
                'requestSha256': self.core.request_digest, 'guestBootId': self.core.boot_id,
                'parentGrantId': self.core.grant['grantId'], 'binding': binding}
            self.inventory_request_bytes = self.module.canonical(self.inventory_request)
            self.inventory_sent_ns = time.monotonic_ns()
            self.inventory_phase = 'REQUESTED'
            return self.outgoing(self.inventory_request)
        except BaseException:
            self.abort()
            raise

    def inventory_images(self, envelope):
        import time
        try:
            if self.poisoned or self.core.state != 'ADMITTED_NO_EXECUTION' or time.monotonic_ns() >= self.core.expiry_ns or self.inventory_phase != 'REQUESTED':
                refuse('inventory requires current unconsumed admitted challenge')
            self.inventory_phase = 'CONSUMING'
            grant = self.verify(envelope, 'INVENTORY_GRANT')
            closed(grant, ['type', 'request', 'managerEpoch', 'inventoryGrantId', 'durationMs', 'evidence'])
            if self.module.canonical(grant['request']) != self.inventory_request_bytes or grant['managerEpoch'] != self.core.grant['managerEpoch'] or not isinstance(grant['inventoryGrantId'], str) or not 0 < len(grant['inventoryGrantId']) <= 128 or type(grant['durationMs']) is not int or not 0 < grant['durationMs'] <= 60000:
                refuse('authenticated inventory grant differs')
            evidence = grant['evidence']
            closed(evidence, ['estate', 'vmid', 'machineId', 'dataset', 'quotaBytes', 'usedBytes', 'poolHealth', 'poolFreeBytes', 'holdPresent', 'writerExclusionSha256', 'storeBackingSha256', 'capacityEvidenceSha256', 'holdDecisionSha256'])
            if evidence['estate'] != 'Proxmox1' or type(evidence['vmid']) is not int or evidence['vmid'] != 107 or evidence['machineId'] != self.core.request['target']['machineId'] or evidence['dataset'] != 'data/vm107' or type(evidence['quotaBytes']) is not int or evidence['quotaBytes'] != 80 * 1024**3 or type(evidence['usedBytes']) is not int or not 0 <= evidence['usedBytes'] < 76 * 1024**3 or evidence['poolHealth'] != 'ONLINE' or type(evidence['poolFreeBytes']) is not int or evidence['poolFreeBytes'] < 60 * 1024**3 or evidence['holdPresent'] is not True:
                refuse('Manager target/capacity/hold evidence differs')
            import re
            if any(not isinstance(evidence[k], str) or not re.fullmatch('[a-f0-9]{64}', evidence[k]) for k in ['writerExclusionSha256', 'storeBackingSha256', 'capacityEvidenceSha256', 'holdDecisionSha256']):
                refuse('Manager live evidence identity missing')
            expires = min(self.core.expiry_ns, self.inventory_sent_ns + grant['durationMs'] * 1000000)
            binding = self.module.parse(self.inventory_request_bytes)['binding']
            binding_bytes = self.module.canonical(binding)
            parent = self
            def live_inventory(phase):
                if parent.poisoned or parent.core.state != 'ADMITTED_NO_EXECUTION' or parent.inventory_phase != phase or time.monotonic_ns() >= min(expires, parent.core.expiry_ns):
                    refuse('read-only inventory phase or lease unavailable')
            class ReadonlyLease:
                def assert_current(self, observed):
                    live_inventory('READING')
                    if parent.module.canonical(observed) != binding_bytes:
                        refuse('read-only inventory lease expired or differs')
                def record_readonly_diagnostic(self, summary):
                    parent.persist_inventory_evidence('diagnostic-' + str(summary['command']), summary)
                def finish_readonly_inventory(self):
                    if parent.inventory_phase != 'READING':
                        refuse('read-only inventory already settled')
                    parent.inventory_phase = 'READ_FINISHED'
            class AuthenticatedGate:
                def acquire_readonly_inventory(self, observed):
                    live_inventory('CONSUMING')
                    parent.inventory_phase = 'READING'
                    lease = ReadonlyLease()
                    lease.assert_current(observed)
                    return lease
            # Gate exists only after this exact session's authenticated Manager
            # response passes. No default owner/context and no application rights.
            helper_fd = self.core.inputs.rewind('preflight:helper')
            source = os.read(helper_fd, 16 * MAX + 1)
            os.lseek(helper_fd, 0, os.SEEK_SET)
            if hashlib.sha256(source).hexdigest() != self.core.request['installedHelpers']['archivePreflight']['sha256']:
                refuse('inventory helper pin differs')
            helper = types.ModuleType('installed_readonly_inventory')
            exec(compile(source, '<pinned-inventory-helper>', 'exec'), helper.__dict__)
            result = helper.owner_gated_inventory(self.archive_preflight_result, binding, AuthenticatedGate())
            live_inventory('READ_FINISHED')
            proof = {'kind': 'supervisor-read-only-inventory', 'nonce': self.core.nonce,
                'requestSha256': self.core.request_digest, 'managerGrant': grant,
                'preflightSha256': self.archive_preflight_result['sha256'], 'result': result}
            receipt = self.persist_inventory_evidence('receipt', proof)
            live_inventory('READ_FINISHED')
            self.core.record('IMAGE_INVENTORY', receipt)
            self.inventory_phase = 'COMPLETED'
            return receipt
        except BaseException:
            self.abort()
            raise

    def persist_inventory_evidence(self, suffix, value):
        import re
        if not re.fullmatch(r'(?:receipt|diagnostic-(?:[1-9][0-9]{0,2}))', suffix):
            refuse('invalid inventory evidence suffix')
        data = self.module.canonical(value) + b'\n'
        cap = MAX if suffix == 'receipt' else 16384
        if len(data) > cap:
            refuse('private inventory evidence bound')
        directory = Path(self.candidate_binding['evidenceDirectory'])
        if not directory.is_absolute() or directory.resolve(strict=True) != directory:
            refuse('inventory evidence root invalid')
        for part in [directory, *directory.parents]:
            st = part.lstat()
            if st.st_uid != 0 or st.st_mode & 0o022:
                refuse('inventory evidence custody absent')
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if os.fstat(directory_fd).st_mode & 0o077:
                refuse('inventory evidence root must be private')
            name = self.core.nonce + '.inventory-' + suffix + '.json'
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory_fd)
            try:
                remaining = memoryview(data)
                while remaining:
                    count = os.write(fd, remaining)
                    if count <= 0:
                        refuse('inventory evidence short write')
                    remaining = remaining[count:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return {'path': str(directory / name), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}

    def terminal_query(self):
        try:
            if self.poisoned or self.core.state != 'TERMINAL_PENDING_ACK':
                refuse('no pending terminal to query')
            # Query the same terminal identity; never repeat an operation.
            return self.outgoing(dict(self.pending_terminal, type='TERMINAL_QUERY'))
        except BaseException:
            self.abort()
            raise

    def namespace_query(self):
        try:
            if self.poisoned or self.core.state != 'TERMINAL_PENDING_ACK':
                refuse('namespace reconciliation requires pending terminal')
            self.namespace_snapshot = {'nonce': self.core.nonce,
                'requestSha256': self.core.request_digest,
                'terminal': self.pending_terminal,
                'exchangePrefixSha256': self.journal_hash.hexdigest(),
                'exchangePrefixBytes': self.bytes}
            return self.outgoing(dict(self.namespace_snapshot, type='NAMESPACE_QUERY'))
        except BaseException:
            self.abort()
            raise

    def receive_namespace_decision(self, envelope):
        try:
            if self.poisoned or self.core.state != 'TERMINAL_PENDING_ACK' or not hasattr(self, 'namespace_snapshot'):
                refuse('namespace query missing')
            reply = self.verify(envelope, 'NAMESPACE_RECONCILIATION')
            closed(reply, ['type', 'snapshot', 'decision', 'reuseOldNamespace'])
            if self.module.canonical(reply['snapshot']) != self.module.canonical(self.namespace_snapshot) or reply['decision'] not in ('preserve-unresolved', 'acknowledge-no-execution') or reply['reuseOldNamespace'] is not False:
                refuse('namespace reconciliation binding/decision differs')
            # Authenticated decision is already durably journaled. It never
            # deletes/reuses records, resumes a grant, or substitutes for ACK.
            self.namespace_decision = reply
            del self.namespace_snapshot
            return reply
        except BaseException:
            self.abort()
            raise

    def close_inputs(self):
        errors = []
        fds, self.held = self.held, []
        if self.journal is not None:
            fds.append(self.journal)
            self.journal = None
        for fd in fds:
            try:
                os.close(fd)
            except OSError as error:
                errors.append(type(error).__name__)
        self.key = b''  # Releases reference; does not promise memory erasure.
        self.cleanup_errors = getattr(self, 'cleanup_errors', []) + errors

    def abort(self):
        # Best effort, idempotent; consume handles before close and preserve the
        # primary exception. Valid only while daemon dispatch is impossible.
        self.poisoned = True
        guardian = getattr(self, 'guardian_custody', None)
        if guardian is not None:
            self.core.state = 'GUARDIAN_UNRESOLVED'
            try:
                guardian.retain_unresolved(getattr(self.core, 'nonce', None), self.core.request_digest)
            except BaseException as error:
                self.guardian_notice_error = type(error).__name__
            # Close only this failed constructor's local references. No unlock,
            # ACK or release of the independent guardian/host fence occurs.
            try:
                guardian.close_local_unresolved()
            except BaseException as error:
                self.guardian_close_error = type(error).__name__
        else:
            self.core.state = 'POISONED'
        fds = list(self.core.inputs.fds.values())
        self.core.inputs.fds.clear()
        for attribute in ['ledger_fd', 'lock_fd']:
            fd = getattr(self.core, attribute, None)
            setattr(self.core, attribute, None)
            if fd is not None:
                fds.append(fd)
        self.held.extend(fds)
        self.close_inputs()


def bootstrap(request_bytes):
    held = []
    core = None
    journal = None
    session = None
    try:
        # This fixed root-controlled anchor is installed independent authority.
        # Manager must provision it; caller cannot select its path or pins.
        anchor_fd = open_controlled(ANCHOR)
        held.append(anchor_fd)
        anchor_bytes = os.read(anchor_fd, MAX + 1)
        anchor = decode(anchor_bytes)
        closed(anchor, ['version', 'keyId', 'nonceDirectory', 'inputs', 'helperInputs', 'bootstrapEntry', 'workflow'])
        if type(anchor['version']) is not int or anchor['version'] != 1:
            refuse('bootstrap version')
        closed(anchor['inputs'], ['core', 'schema', 'approvedRequest', 'installationReceipt',
                                  'managerChannel', 'sessionCustody', 'custodyPolicy', 'guardianConnection'])
        loaded, table = {}, {}
        for role, entry in anchor['inputs'].items():
            fd, data, metadata = pin(entry)
            held.append(fd)
            loaded[role], table[role] = data, metadata
        table['anchor'] = {'path': ANCHOR, 'sha256': hashlib.sha256(anchor_bytes).hexdigest(),
                           'device': os.fstat(anchor_fd).st_dev, 'inode': os.fstat(anchor_fd).st_ino}
        if not isinstance(anchor['keyId'], str) or not anchor['keyId']:
            refuse('public Manager key identity absent')
        module = types.ModuleType('installed_development_admission_core')
        # Execute only independently hash+verity pinned installed core bytes.
        exec(compile(loaded['core'], anchor['inputs']['core']['path'], 'exec'), module.__dict__)
        core = module.Core(module.ManagerVerifier())
        core.select(request_bytes, loaded['approvedRequest'], module.parse(loaded['schema']))
        receipt = module.parse(loaded['installationReceipt'])
        closed(receipt, ['version', 'inputRoles', 'helpers', 'candidateBinding'])
        if type(receipt['version']) is not int or receipt['version'] != 1 or core.request['authority']['installationReceiptSha256'] != table['installationReceipt']['sha256']:
            refuse('installation receipt differs from approved request')
        closed(receipt['inputRoles'], ['core', 'schema', 'managerChannel', 'sessionCustody', 'custodyPolicy', 'guardianConnection'])
        for role in receipt['inputRoles']:
            if receipt['inputRoles'][role] != anchor['inputs'][role]:
                refuse('installed input role differs from approved receipt')
        expected_helpers = core.request['installedHelpers']
        closed(anchor['helperInputs'], expected_helpers)
        if receipt['helpers'] != expected_helpers:
            refuse('helper versions differ from approved request')
        for role, expected in expected_helpers.items():
            entry = anchor['helperInputs'][role]
            if entry['path'] != expected['path'] or entry['sha256'] != expected['sha256']:
                refuse('installed helper role pin differs')
            fd, _, metadata = pin(entry)
            held.append(fd)
            table['helper:' + role] = dict(metadata, version=expected['version'])
        if anchor['inputs']['core']['path'] != expected_helpers['supervisor']['path'] or anchor['inputs']['core']['sha256'] != expected_helpers['supervisor']['sha256']:
            refuse('loaded core differs from selected supervisor role')
        # Independently pinned source and policy, not caller objects or paths.
        # Missing runtime custody refuses BEFORE reservation, flock or journal.
        primitives = types.ModuleType('installed_development_manager_channel')
        exec(compile(loaded['managerChannel'], anchor['inputs']['managerChannel']['path'], 'exec'), primitives.__dict__)
        custody_module = types.ModuleType('installed_development_session_custody')
        exec(compile(loaded['sessionCustody'], anchor['inputs']['sessionCustody']['path'], 'exec'), custody_module.__dict__)
        custody_policy = module.parse(loaded['custodyPolicy'])
        custody_module.validate_policy(primitives, custody_policy, core.request)
        connection_module = types.ModuleType('installed_development_guardian_connection')
        exec(compile(loaded['guardianConnection'], anchor['inputs']['guardianConnection']['path'], 'exec'), connection_module.__dict__)
        # Construct the private legacy journal holder only; never return it or
        # install its supplied-envelope verifier as the active entry point.
        session = Session(core, held, None, b'', anchor['keyId'], table)
        session.module = module
        session.candidate_binding = receipt['candidateBinding']
        session.nonce_directory = Path(anchor['nonceDirectory'])
        return custody_module.SerializedControl(session, primitives, custody_policy, connection_module)
    except BaseException as primary:
        if session is not None:
            session.abort()
            raise
        owned, held = held, []
        if core is not None:
            core.state = 'POISONED'
            owned.extend(core.inputs.fds.values())
            core.inputs.fds.clear()
            for attr in ['ledger_fd', 'lock_fd']:
                fd = getattr(core, attr, None)
                setattr(core, attr, None)
                if fd is not None:
                    owned.append(fd)
        if journal is not None:
            owned.append(journal)
            journal = None
        cleanup_errors = []
        for fd in owned:
            try:
                os.close(fd)
            except OSError as error:
                cleanup_errors.append(type(error).__name__)
        if cleanup_errors and hasattr(primary, 'add_note'):
            primary.add_note('Secondary descriptor cleanup errors: ' + ','.join(cleanup_errors))
        raise


class PersistedTerminal:
    """Read-only reconciliation under flock; never resumes a Core or old grant.

    Internal API: module/key/keyId/directory must come from independently pinned
    installation inputs. Actual Manager provisioning/transport and evidence-sink restart recovery remain external.
    """
    def __init__(self, module, directory, nonce, key, key_id, context):
        import re
        import secrets
        self.module, self.key, self.key_id = module, key, key_id
        self.fds = []
        self.closed = False
        self.context = context
        try:
            context_fields = {'inputTableSha256', 'requestSha256', 'maxOperationSeconds', 'managerContextId', 'evidenceDirectory'}
            if isinstance(context, dict) and 'candidateBinding' in context:
                context_fields.add('candidateBinding')
            closed(context, context_fields)
            if not all(isinstance(context[k], str) and re.fullmatch('[a-f0-9]{64}', context[k]) for k in ['inputTableSha256', 'requestSha256']) or type(context['maxOperationSeconds']) is not int or not 1 <= context['maxOperationSeconds'] <= 1800 or not isinstance(context['managerContextId'], str) or not 0 < len(context['managerContextId']) <= 128:
                refuse('independent reconstruction context invalid')
            if not re.fullmatch('[a-f0-9]{64}', nonce) or len(key) != 32:
                refuse('invalid persisted-session identity')
            lock = open_controlled(module.LOCK)
            self.fds.append(lock)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            directory = Path(directory)
            if directory.resolve(strict=True) != directory:
                refuse('noncanonical persisted namespace')
            for part in [directory, *directory.parents]:
                info = part.lstat()
                if info.st_uid != 0 or info.st_mode & 0o022:
                    refuse('persisted namespace custody absent')
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.fds.append(directory_fd)
            if set(os.listdir(directory_fd)) != {nonce, nonce + '.exchange'}:
                refuse('unknown or partial namespace records')
            blobs = {}
            for name in [nonce, nonce + '.exchange']:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory_fd)
                self.fds.append(fd)
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o077 or not 0 < before.st_size <= 4 * MAX:
                    refuse('persisted record custody/size invalid')
                data = bytearray()
                while chunk := os.read(fd, min(MAX, 4 * MAX + 1 - len(data))):
                    data.extend(chunk)
                    if len(data) > 4 * MAX:
                        refuse('persisted record limit')
                after = os.fstat(fd)
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or not data.endswith(b'\n'):
                    refuse('partial or changed persisted records')
                blobs[name] = bytes(data)
            def rows(data):
                lines = data.splitlines(keepends=True)
                if len(lines) > 4096:
                    refuse('persisted record-count limit')
                result = []
                for line in lines:
                    value = module.parse(line)
                    if module.canonical(value) + b'\n' != line:
                        refuse('noncanonical persisted row')
                    result.append((value, line))
                return result
            archive_evidence = None
            inventory_evidence = None
            def archive_receipt(link):
                closed(link, ['path', 'sha256', 'bytes'])
                candidate = context.get('candidateBinding')
                closed(candidate, ['evidenceDirectory', 'policySha256', 'sourceSha', 'treeSha', 'manifestSha256', 'helperSha256'])
                root = Path(candidate['evidenceDirectory'])
                expected_path = str(root / (nonce + '.archive-preflight.json'))
                if link['path'] != expected_path or root.resolve(strict=True) != root or not root.is_absolute() or type(link['bytes']) is not int or not 0 < link['bytes'] <= MAX:
                    refuse('archive evidence path/size differs from installed context')
                for part in [root, *root.parents]:
                    st = part.lstat()
                    if st.st_uid != 0 or st.st_mode & 0o022:
                        refuse('archive evidence root custody absent')
                root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                self.fds.append(root_fd)
                if os.fstat(root_fd).st_mode & 0o077:
                    refuse('archive evidence root must be private')
                evidence_fd = os.open(nonce + '.archive-preflight.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root_fd)
                self.fds.append(evidence_fd)
                before = os.fstat(evidence_fd)
                if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o077 or before.st_size != link['bytes']:
                    refuse('archive evidence custody differs')
                data = os.read(evidence_fd, MAX + 1)
                after = os.fstat(evidence_fd)
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(data) != link['bytes'] or hashlib.sha256(data).hexdigest() != link['sha256']:
                    refuse('archive evidence changed or hash differs')
                proof = module.parse(data)
                if module.canonical(proof) + b'\n' != data:
                    refuse('archive evidence is noncanonical')
                closed(proof, ['kind', 'nonce', 'requestSha256', 'candidatePolicySha256', 'supervisorArchiveIntegrityHashBytes', 'result'])
                if proof['kind'] != 'supervisor-fd-preflight-evidence' or proof['nonce'] != nonce or proof['requestSha256'] != request_digest or proof['candidatePolicySha256'] != candidate['policySha256'] or type(proof['supervisorArchiveIntegrityHashBytes']) is not int or not 0 <= proof['supervisorArchiveIntegrityHashBytes'] <= 64 * 1024**3:
                    refuse('archive evidence candidate/request differs')
                result = proof['result']
                closed(result, ['receipt', 'sha256', 'bytes'])
                nested = module.canonical(result['receipt'])
                if type(result['bytes']) is not int or len(nested) != result['bytes'] or len(nested) > MAX or hashlib.sha256(nested).hexdigest() != result['sha256']:
                    refuse('nested archive receipt identity differs')
                receipt = result['receipt']
                if receipt['kind'] != 'immutable-fd-archive-preflight' or receipt['sourceSha'] != candidate['sourceSha'] or receipt['treeSha'] != candidate['treeSha'] or receipt['manifest']['sha256'] != candidate['manifestSha256'] or receipt['helper']['sha256'] != candidate['helperSha256'] or receipt['inventoryStatus'] != 'pending-live-owner-custody' or receipt['loadAuthorized'] is not False:
                    refuse('archive receipt claims wrong candidate or authority')
                expected_services = {'proxy': 'proxy', 'web': 'web', 'api': 'api', 'webhook-replay': 'api', 'migrate': 'migrate', 'engine': 'engine', 'pdf-parser': 'worker', 'worker': 'worker', 'pgbouncer': 'pgbouncer', 'pitr-wal-provider': 'backup', 'api-v2': 'api-v2', 'pitr-lifecycle-audit': 'backup', 'postgres': 'postgres', 'redis': 'redis', 'rabbitmq': 'rabbitmq', 'control': 'control', 'autoheal': 'autoheal', 'prometheus': 'prometheus', 'backup': 'backup', 'pitr-base-backup': 'backup', 'pitr-restore': 'backup', 'alertmanager': 'alertmanager', 'node-exporter': 'node-exporter', 'loki': 'loki', 'promtail': 'otel-collector', 'otel-collector': 'otel-collector', 'tempo': 'tempo', 'grafana': 'grafana'}
                if set(receipt['services']) != set(expected_services) or set(receipt['archives']) != set(expected_services.values()) or any(receipt['services'][name]['artifact'] != artifact for name, artifact in expected_services.items()):
                    refuse('archive receipt scope differs')
                return {'link': link, 'resultSha256': result['sha256'], 'candidatePolicySha256': candidate['policySha256']}

            def inventory_receipt(link):
                closed(link, ['path', 'sha256', 'bytes'])
                root = Path(context['candidateBinding']['evidenceDirectory'])
                if link['path'] != str(root / (nonce + '.inventory-receipt.json')) or type(link['bytes']) is not int or not 0 < link['bytes'] <= MAX:
                    refuse('inventory receipt path/size differs')
                fd = open_controlled(link['path'])
                self.fds.append(fd)
                before = os.fstat(fd)
                if before.st_mode & 0o077 or before.st_size != link['bytes']:
                    refuse('inventory receipt privacy/size differs')
                data = os.read(fd, MAX + 1)
                after = os.fstat(fd)
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or hashlib.sha256(data).hexdigest() != link['sha256']:
                    refuse('inventory receipt changed')
                proof = module.parse(data)
                closed(proof, ['kind', 'nonce', 'requestSha256', 'managerGrant', 'preflightSha256', 'result'])
                if module.canonical(proof) + b'\n' != data or proof['kind'] != 'supervisor-read-only-inventory' or proof['nonce'] != nonce or proof['requestSha256'] != request_digest or proof['preflightSha256'] != archive_evidence['resultSha256']:
                    refuse('inventory receipt binding differs')
                result = proof['result']
                closed(result, ['receipt', 'sha256', 'bytes'])
                raw = module.canonical(result['receipt'])
                if type(result['bytes']) is not int or len(raw) != result['bytes'] or hashlib.sha256(raw).hexdigest() != result['sha256']:
                    refuse('nested inventory result differs')
                receipt = result['receipt']
                if receipt['kind'] != 'owner-gated-read-only-image-inventory' or receipt['candidateSha'] != context['candidateBinding']['sourceSha'] or receipt['preflightSha256'] != proof['preflightSha256'] or receipt['loadAuthorized'] is not False or len(receipt['associations']) != 21:
                    refuse('inventory candidate/authority differs')
                if any(x['status'] not in ('verified-current-daemon-association', 'pending-image-load-and-postload-readback') for x in receipt['associations'].values()):
                    refuse('inventory association status invalid')
                if any(type(receipt[k]) is not int or receipt[k] < 0 for k in ['stdoutBytes', 'stderrBytes', 'outputBytes']) or receipt['stdoutBytes'] + receipt['stderrBytes'] != receipt['outputBytes'] or receipt['outputBytes'] > 16 * MAX:
                    refuse('inventory output accounting differs')
                return {'link': link, 'resultSha256': result['sha256'], 'managerGrant': proof['managerGrant']}

            core_rows = rows(blobs[nonce])
            previous, events = '0' * 64, []
            grant = None
            for index, (row, line) in enumerate(core_rows):
                closed(row, ['sequence', 'previous', 'event', 'details'])
                if type(row['sequence']) is not int or row['sequence'] != index or row['previous'] != previous:
                    refuse('core hash chain differs')
                previous = hashlib.sha256(line).hexdigest()
                event, details = row['event'], row['details']
                events.append(event)
                if event == 'RESERVED':
                    closed(details, ['requestSha256', 'nonce'])
                    if index != 0 or details['nonce'] != nonce:
                        refuse('reservation identity differs')
                    request_digest = details['requestSha256']
                elif event == 'GRANT':
                    if grant is not None or details.get('nonce') != nonce or details.get('requestSha256') != request_digest:
                        refuse('persisted grant binding differs')
                    grant = details
                elif event == 'ARCHIVE_PREFLIGHT':
                    if grant is None or archive_evidence is not None or events[:-1] != ['RESERVED', 'GRANT']:
                        refuse('archive preflight event out of producer order')
                    archive_evidence = archive_receipt(details)
                elif event == 'IMAGE_INVENTORY':
                    if archive_evidence is None or inventory_evidence is not None or events[:-1] != ['RESERVED', 'GRANT', 'ARCHIVE_PREFLIGHT']:
                        refuse('inventory event out of order')
                    inventory_evidence = inventory_receipt(details)
                elif event == 'TERMINAL':
                    if module.canonical(details) != module.canonical({'outcome': 'no-execution', 'cliSettled': True, 'daemonRequestsDispatched': 0, 'survivors': []}):
                        refuse('unknown terminal side effects')
                    terminal_hash = previous
                elif event != 'ACK':
                    refuse('unknown core event')
            if events not in (['RESERVED', 'TERMINAL'], ['RESERVED', 'TERMINAL', 'ACK'], ['RESERVED', 'GRANT', 'TERMINAL'], ['RESERVED', 'GRANT', 'TERMINAL', 'ACK'], ['RESERVED', 'GRANT', 'ARCHIVE_PREFLIGHT', 'TERMINAL'], ['RESERVED', 'GRANT', 'ARCHIVE_PREFLIGHT', 'TERMINAL', 'ACK'], ['RESERVED', 'GRANT', 'ARCHIVE_PREFLIGHT', 'IMAGE_INVENTORY', 'TERMINAL'], ['RESERVED', 'GRANT', 'ARCHIVE_PREFLIGHT', 'IMAGE_INVENTORY', 'TERMINAL', 'ACK']):
                refuse('partial or unsupported core state')
            if request_digest != context['requestSha256']:
                refuse('reserved request differs from installed context')
            counts = {'supervisor': 0, 'manager': 0}
            phase = 'BOOTSTRAP_REQUIRED'
            request, terminal, authenticated_grant, authenticated_ack = None, None, None, None
            inventory_request = inventory_grant = None
            for index, (row, _) in enumerate(rows(blobs[nonce + '.exchange'])):
                closed(row, ['direction', 'message'])
                direction, envelope = row['direction'], row['message']
                if phase == 'BOOTSTRAP_REQUIRED':
                    if index != 0 or direction != 'bootstrap':
                        refuse('mandatory bootstrap header missing')
                    closed(envelope, ['requestSha256', 'inputTable'])
                    if envelope['requestSha256'] != request_digest or not isinstance(envelope['inputTable'], dict):
                        refuse('bootstrap exchange mismatch')
                    table = envelope['inputTable']
                    required_roles = {'core', 'schema', 'approvedRequest', 'managerKey', 'installationReceipt', 'anchor', 'helper:supervisor', 'helper:lifecycle', 'helper:backup', 'helper:archivePreflight', 'helper:privateTargetReader', 'helper:privateTargetDependency'}
                    closed(table, required_roles)
                    for role, entry in table.items():
                        fields = ['path', 'sha256', 'device', 'inode'] if role == 'anchor' else ['path', 'bytes', 'sha256', 'veritySha256', 'device', 'inode']
                        if role.startswith('helper:'):
                            fields.append('version')
                        closed(entry, fields)
                        if not isinstance(entry['path'], str) or not entry['path'].startswith('/') or any(c in entry['path'] for c in ('\x00', '\n', '\r')) or not re.fullmatch('[a-f0-9]{64}', entry['sha256']) or any(type(entry[k]) is not int or entry[k] < 0 for k in ['device', 'inode']):
                            refuse('invalid input-table identity')
                        if role != 'anchor' and (type(entry['bytes']) is not int or not 0 < entry['bytes'] <= MAX or not re.fullmatch('[a-f0-9]{64}', entry['veritySha256'])):
                            refuse('invalid pinned input metadata')
                        if role.startswith('helper:') and (not isinstance(entry['version'], str) or not entry['version']):
                            refuse('invalid helper version')
                    table_digest = module.digest(table)
                    if table_digest != context['inputTableSha256']:
                        refuse('bootstrap table differs from independent installed context')
                    phase = 'BEFORE_REQUEST'
                    continue
                if direction == 'bootstrap':
                    refuse('duplicate bootstrap header')
                if direction not in counts:
                    refuse('unknown exchange direction')
                closed(envelope, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
                expected_direction = 'supervisor-to-manager' if direction == 'supervisor' else 'manager-to-supervisor'
                if type(envelope['version']) is not int or envelope['version'] != 1 or envelope['domain'] != 'lunchlineup-development-admission-v1' or envelope['direction'] != expected_direction or envelope['keyId'] != key_id or type(envelope['sequence']) is not int or envelope['sequence'] != counts[direction]:
                    refuse('persisted authenticated sequence/domain differs')
                message = {k: envelope[k] for k in ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload']}
                mac = hmac.new(key, module.canonical(message), hashlib.sha256).hexdigest()
                if not isinstance(envelope['mac'], str) or not hmac.compare_digest(mac, envelope['mac']):
                    refuse('persisted MAC differs')
                counts[direction] += 1
                payload = envelope['payload']
                if not isinstance(payload, dict):
                    refuse('persisted payload invalid')
                kind = payload.get('type')
                if direction == 'supervisor' and kind == 'REQUEST':
                    if phase != 'BEFORE_REQUEST':
                        refuse('REQUEST out of producer order')
                    closed(payload, ['type', 'nonce', 'requestSha256', 'guestBootId', 'inputTableSha256'])
                    if payload['nonce'] != nonce or payload['requestSha256'] != request_digest or payload['inputTableSha256'] != table_digest or not isinstance(payload['guestBootId'], str) or not payload['guestBootId']:
                        refuse('REQUEST/header binding differs')
                    phase = 'AFTER_REQUEST'
                    request = payload
                elif direction == 'manager' and kind == 'GRANT':
                    if phase != 'AFTER_REQUEST':
                        refuse('GRANT out of producer order')
                    closed(payload, ['type', 'nonce', 'requestSha256', 'guestBootId', 'inputTableSha256', 'grantId', 'managerEpoch', 'sequence', 'durationMs', 'maxRoundTripMs'])
                    if any(payload[k] != request[k] for k in ['nonce', 'requestSha256', 'guestBootId', 'inputTableSha256']) or type(payload['sequence']) is not int or payload['sequence'] != 0 or any(not isinstance(payload[k], str) or not 0 < len(payload[k]) <= 128 for k in ['grantId', 'managerEpoch']) or type(payload['durationMs']) is not int or not 0 < payload['durationMs'] <= min(60000, context['maxOperationSeconds'] * 1000) or type(payload['maxRoundTripMs']) is not int or not 0 < payload['maxRoundTripMs'] <= 5000:
                        refuse('persisted grant shape/binding differs')
                    phase = 'AFTER_GRANT'
                    authenticated_grant = payload
                elif direction == 'supervisor' and kind == 'INVENTORY_REQUEST':
                    if phase != 'AFTER_GRANT' or archive_evidence is None:
                        refuse('inventory request out of order')
                    closed(payload, ['type', 'nonce', 'requestSha256', 'guestBootId', 'parentGrantId', 'binding'])
                    if payload['nonce'] != nonce or payload['requestSha256'] != request_digest or payload['parentGrantId'] != grant['grantId'] or payload['guestBootId'] != grant['guestBootId'] or payload['binding']['preflightSha256'] != archive_evidence['resultSha256']:
                        refuse('inventory request identity differs')
                    inventory_request = payload
                    phase = 'INVENTORY_REQUESTED'
                elif direction == 'manager' and kind == 'INVENTORY_GRANT':
                    if phase != 'INVENTORY_REQUESTED' or inventory_evidence is None or module.canonical(payload) != module.canonical(inventory_evidence['managerGrant']) or module.canonical(payload['request']) != module.canonical(inventory_request):
                        refuse('inventory grant/receipt differs')
                    inventory_grant = payload
                    phase = 'INVENTORY_RECORDED'
                elif direction == 'supervisor' and kind in ('TERMINAL', 'TERMINAL_QUERY'):
                    if kind == 'TERMINAL':
                        if phase not in ('BEFORE_REQUEST', 'AFTER_REQUEST', 'AFTER_GRANT', 'INVENTORY_RECORDED'):
                            refuse('TERMINAL out of producer order')
                        phase = 'AWAIT_ACK'
                    elif phase != 'AWAIT_ACK':
                        refuse('TERMINAL_QUERY before original terminal or after ACK')
                    normalized = dict(payload, type='TERMINAL')
                    if terminal is not None and module.canonical(terminal) != module.canonical(normalized):
                        refuse('contradictory terminals')
                    terminal = normalized
                elif direction == 'manager' and kind == 'ACK':
                    if phase != 'AWAIT_ACK':
                        refuse('ACK before terminal or duplicate ACK')
                    phase = 'ACKNOWLEDGED'
                    authenticated_ack = payload
                else:
                    # Namespace query/decision replay semantics are not inferred.
                    refuse('persisted exchange requires separate reconciliation')
            if phase not in ('AWAIT_ACK', 'ACKNOWLEDGED'):
                refuse('incomplete producer transcript')
            if terminal is None or terminal.get('nonce') != nonce or terminal.get('requestSha256') != request_digest or terminal.get('ledgerSha256') != terminal_hash or terminal.get('outcome') != 'no-execution':
                refuse('durable terminal not established')
            closed(terminal, ['type', 'nonce', 'requestSha256', 'ledgerSha256', 'outcome', 'grantId', 'managerEpoch', 'grantSequence', 'guestBootId'])
            if request is not None and (request.get('nonce') != nonce or request.get('requestSha256') != request_digest or terminal['guestBootId'] != request.get('guestBootId')):
                refuse('terminal/request binding differs')
            if grant is None and any(terminal[k] is not None for k in ['grantId', 'managerEpoch', 'grantSequence']):
                refuse('pre-grant terminal fabricates grant identity')
            if request is None and terminal['guestBootId'] is not None:
                refuse('unchallenged terminal fabricates boot identity')
            if module.canonical(grant) != module.canonical(authenticated_grant):
                refuse('received grant was not durably admitted')
            if grant is not None:
                if request is None or any(grant[k] != request[k] for k in ['nonce', 'requestSha256', 'guestBootId', 'inputTableSha256']):
                    refuse('persisted request/grant identity differs')
                if any(terminal[k] != grant[g] for k, g in [('grantId', 'grantId'), ('managerEpoch', 'managerEpoch'), ('grantSequence', 'sequence'), ('guestBootId', 'guestBootId')]):
                    refuse('terminal grant identity differs')
            if (authenticated_ack is not None) != (events[-1] == 'ACK'):
                refuse('partially committed terminal ACK')
            if authenticated_ack is not None:
                expected_ack = {k: v for k, v in terminal.items() if k != 'outcome'}
                expected_ack['type'] = 'ACK'
                if module.canonical(authenticated_ack) != module.canonical(expected_ack) or module.canonical(core_rows[-1][0]['details']) != module.canonical(expected_ack):
                    refuse('terminal ACK differs')
            if (inventory_evidence is None) != (inventory_grant is None):
                refuse('partial inventory receipt/exchange')
            self.snapshot = {'imageInventory': inventory_evidence, 'archivePreflight': archive_evidence, 'managerContextId': context['managerContextId'], 'inputTableSha256': table_digest, 'nonce': nonce, 'requestSha256': request_digest, 'terminal': terminal,
                'coreSha256': hashlib.sha256(blobs[nonce]).hexdigest(),
                'exchangeSha256': hashlib.sha256(blobs[nonce + '.exchange']).hexdigest(),
                'coreBytes': len(blobs[nonce]), 'exchangeBytes': len(blobs[nonce + '.exchange'])}
            self.query_id = secrets.token_hex(32)
            self.answered = False
            sink = Path(context['evidenceDirectory'])
            if not sink.is_absolute() or sink.resolve(strict=True) != sink:
                refuse('evidence sink path invalid')
            for part in [sink, *sink.parents]:
                info = part.lstat()
                if info.st_uid != 0 or info.st_mode & 0o022:
                    refuse('evidence sink custody absent')
            self.sink_fd = os.open(sink, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.fds.append(self.sink_fd)
            sink_stat, old_stat = os.fstat(self.sink_fd), os.fstat(directory_fd)
            if (sink_stat.st_dev, sink_stat.st_ino) == (old_stat.st_dev, old_stat.st_ino) or sink_stat.st_mode & 0o077:
                refuse('separate private evidence sink required')
            self.sink_path = str(sink)
            self.query_receipt = None
        except BaseException:
            self.close()
            raise

    def store_evidence(self, suffix, envelope):
        data = self.module.canonical(envelope) + b'\n'
        if len(data) > MAX:
            refuse('reconciliation evidence byte bound')
        name = self.query_id + '.' + suffix + '.json'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.sink_fd)
        try:
            pending = memoryview(data)
            while pending:
                count = os.write(fd, pending)
                if count <= 0:
                    refuse('reconciliation evidence short write')
                pending = pending[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self.sink_fd)
        return {'path': self.sink_path + '/' + name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def query(self):
        try:
            if self.closed or self.answered:
                refuse('reconstruction is closed')
            if self.query_receipt is not None:
                return self.query_envelope
            payload = {'type': 'PERSISTED_TERMINAL_QUERY', 'queryId': self.query_id,
                       'snapshot': self.snapshot, 'reuseOldNamespace': False}
            message = {'version': 1, 'domain': 'lunchlineup-development-reconciliation-v1',
                       'direction': 'supervisor-to-manager', 'keyId': self.key_id, 'sequence': 0, 'payload': payload}
            self.query_envelope = dict(message, mac=hmac.new(self.key, self.module.canonical(message), hashlib.sha256).hexdigest())
            self.query_receipt = self.store_evidence('query', self.query_envelope)
            return self.query_envelope
        except BaseException:
            self.close()
            raise

    def receive(self, data):
        try:
            if self.closed or self.answered:
                refuse('reconstruction is closed')
            if self.query_receipt is None:
                refuse('query is not durably recorded')
            envelope = self.module.parse(data)
            closed(envelope, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
            message = {k: envelope[k] for k in ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload']}
            if type(envelope['version']) is not int or envelope['version'] != 1 or type(envelope['sequence']) is not int or envelope['sequence'] != 0 or envelope['domain'] != 'lunchlineup-development-reconciliation-v1' or envelope['direction'] != 'manager-to-supervisor' or envelope['keyId'] != self.key_id:
                refuse('reconciliation envelope differs')
            mac = hmac.new(self.key, self.module.canonical(message), hashlib.sha256).hexdigest()
            if not isinstance(envelope['mac'], str) or not hmac.compare_digest(mac, envelope['mac']):
                refuse('reconciliation authentication differs')
            payload = envelope['payload']
            closed(payload, ['type', 'queryId', 'snapshot', 'decision', 'reuseOldNamespace'])
            if payload['type'] != 'PERSISTED_TERMINAL_DECISION' or payload['queryId'] != self.query_id or self.module.canonical(payload['snapshot']) != self.module.canonical(self.snapshot) or payload['decision'] not in ('preserve-unresolved', 'acknowledge-no-execution') or payload['reuseOldNamespace'] is not False:
                refuse('reconciliation decision differs')
            decision_receipt = self.store_evidence('decision', envelope)
            self.answered = True
            return {'query': self.query_receipt, 'decision': decision_receipt, 'outcome': payload['decision'], 'reuseOldNamespace': False}
        finally:
            self.close()

    def close(self):
        self.closed = True
        fds, self.fds = self.fds, []
        self.cleanup_errors = []
        for fd in fds:
            try:
                os.close(fd)
            except OSError as error:
                self.cleanup_errors.append(type(error).__name__)
        self.key = b''


if __name__ == '__main__':
    raise SystemExit('No-dispatch bootstrap is unintegrated; installation/activation refused.')
