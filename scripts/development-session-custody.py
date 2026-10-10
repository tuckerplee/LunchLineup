#!/usr/bin/env python3
"""Pinned Session custody boundary; no service launcher or engine dispatch.

The fixed connection establishes real inherited peer/PID1/epoch/OFD custody.
Absent installed guardian authority refuses. No caller guardian/epoch object
is authority. Registered workers return peer-bound events; mutation remains unavailable.
"""
import os
import hashlib
import threading
import time
from collections import deque

MAX = 1048576


def refuse(reason):
    raise RuntimeError(reason)


def validate_policy(primitives, policy, request):
    primitives.closed(policy, ['version', 'selectionSha256', 'custodyPolicySha256',
                              'containmentRightsSha256', 'overallLimitMs', 'renewEveryMs',
                              'leaseTtlMs', 'maxRoundTripMs', 'mutationAllowed',
                              'wholeVmShutdownAllowed', 'guardianInstallation'])
    if type(policy['version']) is not int or policy['version'] != 1 or policy['mutationAllowed'] is not False or policy['wholeVmShutdownAllowed'] is not False:
        refuse('only uninstalled nonmutating custody policy is supported')
    if policy['selectionSha256'] != primitives.digest(request['selection']):
        refuse('custody selection differs from approved request')
    for key in ['custodyPolicySha256', 'containmentRightsSha256']:
        primitives.sha(policy[key])
    primitives.integer(policy['overallLimitMs'], 1, min(1800000, request['limits']['maxSeconds'] * 1000))
    for key, expected in [('renewEveryMs', 5000), ('leaseTtlMs', 15000), ('maxRoundTripMs', 5000)]:
        primitives.integer(policy[key], expected, expected)
    return {key: policy[key] for key in ['selectionSha256', 'custodyPolicySha256', 'containmentRightsSha256',
                                       'overallLimitMs', 'renewEveryMs', 'leaseTtlMs', 'maxRoundTripMs']}


def open_installed_guardian(primitives, policy, request, input_table, key_id, connection_module):
    """Fixed pinned implementation; no guardian/epoch/endpoint supplied by caller.

    connection_module is compiled only from the independently approved bootstrap
    hash+verity pin. Its open_fixed reads FD3 and validates actual installed and
    kernel custody. An absent service/proof/lock refuses before reservation.
    """
    validate_policy(primitives, policy, request)
    return connection_module.open_fixed(primitives, policy['guardianInstallation'],
                                        primitives.digest(request), primitives.digest(input_table),
                                        key_id)


class OneShotQueue:
    """Internal serialized mailbox filled solely from a registered peer.

    Construction is not peer admission: the fixed factory must obtain that peer
    from verified guardian/PID1 custody. No enqueue(bytes) or supplied-message API
    exists. Each received packet is consumed once, even on validation failure.
    """
    def __init__(self, primitives, registered_peer, initial_sequence, connection_module):
        if type(registered_peer) is not connection_module.GuardianPeer:
            refuse('registered installed peer class required')
        self.primitives, self.peer = primitives, registered_peer
        self.owner = threading.get_ident()
        self.pending = deque()
        self.bytes = 0
        self.failed = False
        self.sequence = primitives.integer(initial_sequence, 2, 2)

    def _owner(self):
        if self.failed or threading.get_ident() != self.owner:
            refuse('guardian queue unavailable or concurrent caller')

    def poll(self):
        self._owner()
        try:
            # Never drain indefinitely: one bounded packet per owner iteration.
            wire = self.peer.receive()
            if wire is None:
                return False
            if len(self.pending) >= 4 or self.bytes + len(wire) > 4 * MAX:
                refuse('guardian receive queue exhausted')
            packet = self.primitives.parse(wire)
            self.primitives.closed(packet, ['sequence', 'kind', 'body'])
            self.primitives.integer(packet['sequence'], self.sequence, self.sequence)
            if packet['kind'] not in ('manager', 'admission-outgoing', 'worker', 'channel-lost', 'custody-released', 'fence-retired') or type(packet['body']) is not dict:
                refuse('unknown guardian packet')
            self.sequence += 1
            self.pending.append((len(wire), packet))
            self.bytes += len(wire)
            return True
        except BaseException:
            self.failed = True
            raise

    def take(self, kind):
        self._owner()
        try:
            if not self.pending:
                refuse('guardian queue empty')
            size, packet = self.pending.popleft()
            self.bytes -= size
            if packet['kind'] != kind:
                refuse('unexpected guardian event order')
            return packet['body']
        except BaseException:
            self.failed = True
            raise

    def next_kind(self):
        self._owner()
        return self.pending[0][1]['kind'] if self.pending else None


class ControlJournal:
    """Existing Session exchange/core writes, with precharged actual-byte bounds.

    Uses the existing canonical wrappers, fsync paths and4MiB journals. No
    separate unbounded log. This is a single-owner adapter, never a ticker thread.
    Any failure permanently poisons the adapter; caller retains guardian custody.
    """
    def __init__(self, session, primitives):
        self.session, self.p = session, primitives
        self.owner = threading.get_ident()
        self.failed = False
        self.exchange = primitives.JournalBudget(session.bytes)
        self.core = primitives.JournalBudget(session.core.bytes_written)
        self.exchange_records = 0 if session.bytes == 0 else session.sequence + session.out_sequence + 1
        self.core_records = session.core.sequence
        self.tail = False
        self.tail_used = {'exchange': 0, 'core': 0}

    def _charge(self, which, payload, wire_bytes, wrapped_bytes):
        budget = getattr(self, which)
        kind = payload.get('type') if isinstance(payload, dict) else None
        if self.tail:
            if self.tail_used[which] + wrapped_bytes > MAX or budget.used + wrapped_bytes > 4 * MAX:
                refuse('terminal/revocation tail exhausted')
            self.tail_used[which] += wrapped_bytes
            budget.used += wrapped_bytes
        elif kind == 'RENEW':
            budget.begin_pair(wire_bytes, wrapped_bytes)
        elif kind == 'RENEWED':
            budget.end_pair(wire_bytes, wrapped_bytes)
        else:
            budget.reserve_other(wrapped_bytes)

    def enter_tail(self):
        self._check()
        self.tail = True
        # A durably written outstanding renewal request already occupies bytes.
        # Charge it before relinquishing unused renewal reservations.
        for budget in [self.exchange, self.core]:
            if budget.pending_bytes is not None:
                budget.used += budget.pending_bytes
                budget.pending_bytes = None

    def _check(self):
        if self.failed or threading.get_ident() != self.owner:
            refuse('journal unavailable or concurrent caller')

    def exchange_write(self, direction, envelope):
        self._check()
        try:
            wire = self.session.module.canonical(envelope)
            row = self.session.module.canonical({'direction': direction, 'message': envelope}) + b'\n'
            if self.exchange_records >= 4096 or len(row) > MAX:
                refuse('exchange record bound')
            self._charge('exchange', envelope.get('payload', {}), len(wire), len(row))
            # Legacy persist calls Session.abort on I/O failure and may close
            # the lock. Keep this write under guardian-retaining failure handling.
            if self.session.journal is None or self.session.poisoned:
                refuse('exchange descriptor unavailable')
            pending = memoryview(row)
            while pending:
                count = os.write(self.session.journal, pending)
                if count <= 0:
                    refuse('exchange short write')
                pending = pending[count:]
            os.fsync(self.session.journal)
            self.session.bytes += len(row)
            self.session.journal_hash.update(row)
            self.exchange_records += 1
        except BaseException:
            self.failed = True
            raise

    def core_write(self, event, details, control_payload=None, wire_bytes=0):
        self._check()
        try:
            core = self.session.core
            row = self.session.module.canonical({'sequence': core.sequence, 'previous': core.previous,
                                                 'event': event, 'details': details}) + b'\n'
            if self.core_records >= 4096 or len(row) > MAX:
                refuse('core record bound')
            # Exchange_write separately charges the complete signed envelope.
            # The core stores payload + envelope digest, so its actual wrapped
            # representation can be smaller than the original wire envelope.
            if control_payload and control_payload.get('type') in ('RENEW', 'RENEWED'):
                self.p.integer(wire_bytes, 1, 2048)
            payload_bytes = len(self.session.module.canonical(control_payload or {}))
            self._charge('core', control_payload or {}, payload_bytes, len(row))
            core.record(event, details)
            self.core_records += 1
        except BaseException:
            self.failed = True
            raise


class SerializedControl:
    """Concrete control-message integration, reachable only from fixed factory.

    All state/journal changes occur on the creator's owner loop. Guardian keeps
    its own loop, lock reference and fence. Blocking workers MUST be registered
    with it; this object never runs subprocesses or reconstructs live authority.
    """
    def __init__(self, session, primitives, policy, connection_module):
        # No externally supplied guardian parameter is admitted. The only route
        # is the fixed independently pinned guardian connection implementation.
        installed_guardian = open_installed_guardian(primitives, policy, session.core.request, session.table,
                                                     session.key_id, connection_module)
        session.guardian_custody = installed_guardian
        try:
            session.core.reserve(str(session.nonce_directory), guardian=installed_guardian)
            session.journal = os.open(session.nonce_directory / (session.core.nonce + '.exchange'),
                                      os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            directory_fd = os.open(session.nonce_directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except BaseException:
            session.abort()
            raise
        self.s, self.p, self.guardian = session, primitives, installed_guardian
        self.owner = threading.get_ident()
        self.policy = validate_policy(primitives, policy, session.core.request)
        self.journal = ControlJournal(session, primitives)
        self.queue = OneShotQueue(primitives, installed_guardian.registered_supervisor_peer(), installed_guardian.inbound_sequence, connection_module)
        self.epoch = installed_guardian.current_epoch()
        self.overall = installed_guardian.remaining_unit_deadline_ns()
        self.lease = None
        self.workers = {}
        self.worker_pending = None
        self.preflight_result = None
        self.inventory_result = None
        self.worker_roles = {}
        self.worker_results = {}
        self.fenced = False
        self.heartbeat_sequence = 0
        self.last_tick = None
        self.terminal_identity = None
        self.manager_ack = None
        self.local_release = None
        # Only guardian can sign/verify MACs. Supervisor tracks exact metadata
        # of envelopes arriving through its one-shot authenticated guardian peer.
        if session.key:
            refuse('supervisor must not possess Manager HMAC key')
        self.counts = {'manager-to-supervisor': session.sequence, 'supervisor-to-manager': session.out_sequence}
        self.pending_outgoing = None
        header = {'inputTable': session.table, 'requestSha256': session.core.request_digest}
        if len(session.module.canonical({'direction': 'bootstrap', 'message': header})) + 1 > 512 * 1024:
            refuse('initial exchange reservation exceeded')
        self.journal.exchange_write('bootstrap', header)

    def _owner(self):
        if threading.get_ident() != self.owner or self.fenced:
            refuse('control loop unavailable or concurrent caller')

    def _core_control(self, envelope, direction, now):
        self.journal.core_write('LEASE_CONTROL', {'direction': direction, 'observedNs': str(now),
                                                 'envelopeSha256': self.p.digest(envelope), 'payload': envelope['payload']},
                                envelope['payload'], len(self.p.canonical(envelope)))

    def start(self):
        self._owner()
        try:
            if self.lease is not None:
                refuse('one-shot control start')
            boot_id = self.epoch['guestBootId']
            message = self.s.core.challenge(boot_id, self.s.module.digest(self.s.table))
            self.lease = self.p.LeaseProtocol(message, self.epoch, self.policy,
                                               self.s.core.sent_ns, self.overall)
            self.journal.core_write('LEASE_CONTEXT', {'request': message, 'epoch': self.epoch,
                                                      'policy': self.policy, 'requestSentNs': str(self.s.core.sent_ns),
                                                      'unitDeadlineNs': str(self.overall)})
            return self._send(message)
        except BaseException:
            self.abort()
            raise

    def _peer_envelope(self, envelope, direction):
        self.p.closed(envelope, ['version', 'domain', 'direction', 'keyId', 'sequence', 'payload', 'mac'])
        if type(envelope['version']) is not int or envelope['version'] != 1 or envelope['domain'] != self.p.ADMISSION_DOMAIN or envelope['direction'] != direction or envelope['keyId'] != self.s.key_id or type(envelope['sequence']) is not int or envelope['sequence'] != self.counts[direction] or type(envelope['payload']) is not dict:
            refuse('guardian-authenticated envelope metadata differs')
        self.p.sha(envelope['mac'])
        return envelope['payload']

    def _send(self, payload):
        if self.pending_outgoing is not None:
            refuse('one outgoing admission request at a time')
        sent_ns = self.s.core.sent_ns if payload['type'] == 'REQUEST' else time.monotonic_ns()
        self.pending_outgoing = {'payload': self.p.parse(self.p.canonical(payload)), 'sentNs': sent_ns}
        if payload['type'] == 'RENEW':
            # Track the conservative request time while asynchronously waiting
            # for the guardian's signed frame. Failure still fences; no expiry
            # extension occurs until a separately authenticated RENEWED.
            self.lease.transition('supervisor-to-manager', payload, sent_ns)
        self.guardian.request_admission(payload, sent_ns)
        # No caller receives a signing API/key or locally manufactured MAC.
        return {'pending': payload['type']}

    def receive_outgoing(self):
        self._owner()
        try:
            envelope = self.queue.take('admission-outgoing')
            payload = self._peer_envelope(envelope, 'supervisor-to-manager')
            pending = self.pending_outgoing
            if pending is None or self.p.canonical(payload) != self.p.canonical(pending['payload']) or time.monotonic_ns() - pending['sentNs'] > 5_000_000_000:
                refuse('guardian outgoing response mismatched/late')
            self.journal.exchange_write('supervisor', envelope)
            self.counts['supervisor-to-manager'] += 1
            self.s.out_sequence += 1
            if payload['type'] == 'RENEW':
                self._core_control(envelope, 'supervisor-to-manager', pending['sentNs'])
            self.pending_outgoing = None
            # Guardian releases its already durable, exact signed frame only
            # after the supervisor's matching exchange/core write is fsynced.
            self.guardian.commit_admission(self.p.digest(envelope), self.s.core.previous)
        except BaseException:
            self.abort()
            raise

    def _terminal_deadline(self):
        # Terminal settlement does not renew the lease or run renewal cadence.
        # Keep the original TTL, operation and unit limits while awaiting ACK
        # and local release; expiry follows the existing unresolved abort path.
        if self.lease is None or time.monotonic_ns() >= min(self.lease.expiry_ns, self.lease.overall_ns, self.overall):
            refuse('terminal settlement original lease deadline elapsed')

    def receive_manager(self):
        self._owner()
        try:
            body = self.queue.take('manager')
            data = self.p.canonical(body)
            direction = 'manager-to-supervisor'
            payload = self._peer_envelope(body, direction)
            kind = payload.get('type')
            if kind not in ('GRANT', 'SESSION_BIND', 'RENEWED', 'REVOKE', 'ACK'):
                refuse('message not admitted by control slice')
            if kind == 'ACK':
                if self.terminal_identity is None or self.manager_ack is not None:
                    refuse('ACK without terminal or duplicate ACK')
                self._terminal_deadline()
                expected = {key: value for key, value in self.terminal_identity.items() if key != 'outcome'}
                expected['type'] = 'ACK'
                if self.p.canonical(payload) != self.p.canonical(expected):
                    refuse('ACK does not bind exact terminal')
                self.journal.exchange_write('manager', body)
                self.counts[direction] += 1
                self.s.sequence += 1
                self.journal.core_write('ACK', payload)
                self.manager_ack = self.p.parse(self.p.canonical(payload))
                self.s.core.state = 'WAIT_GUARDIAN_RELEASE'
                # Manager ACK is durable locally before forwarding; guardian
                # independently verifies/persists it and its own settlement.
                self._terminal_deadline()
                self.guardian.accept_terminal_ack(body)
                return kind
            if self.terminal_identity is not None:
                refuse('only exact ACK admitted after terminal')
            if kind == 'REVOKE':
                # Stop local admission BEFORE a possibly stalled journal fsync.
                self.fenced = True
                self.guardian.fence_new_work()
                self.journal.enter_tail()
            self.journal.exchange_write('manager', body)
            self.counts[direction] += 1
            self.s.sequence += 1
            now = time.monotonic_ns()
            self.lease.transition(direction, payload, now)
            self._core_control(body, direction, now)
            if kind == 'GRANT':
                self.s.core.grant = payload
                self.s.core.expiry_ns = self.lease.expiry_ns
                self.s.core.state = 'WAIT_SESSION_BIND'
            elif kind in ('SESSION_BIND', 'RENEWED'):
                self.s.core.expiry_ns = self.lease.expiry_ns
                self.s.core.state = 'CONTROL_BOUND_NO_EXECUTION'
            else:
                self.abort()
            return kind
        except BaseException:
            self.abort()
            raise

    def tick(self):
        """One owner iteration; no sleep, child wait, hashing loop or fsync thread."""
        self._owner()
        try:
            now = time.monotonic_ns()
            if self.last_tick is not None and now - self.last_tick >= 5_000_000_000:
                refuse('owner-loop heartbeat missed')
            self.guardian.assert_live()
            if self.pending_outgoing is not None and now - self.pending_outgoing['sentNs'] > 5_000_000_000:
                refuse('guardian outgoing admission response timed out')
            if self.terminal_identity is not None:
                self._terminal_deadline()
            self.queue.poll()
            if self.queue.next_kind() == 'channel-lost':
                self.queue.take('channel-lost')
                refuse('guardian channel lost')
            if self.queue.next_kind() == 'admission-outgoing':
                self.receive_outgoing()
            elif self.queue.next_kind() == 'manager':
                self.receive_manager()
                if self.fenced:
                    return
            elif self.queue.next_kind() == 'custody-released':
                self._terminal_deadline()
                receipt = self.queue.take('custody-released')
                self.p.closed(receipt, ['nonce', 'requestSha256', 'guardianSessionId', 'ackSha256', 'fenceReceiptSha256'])
                if self.manager_ack is None or receipt['nonce'] != self.s.core.nonce or receipt['requestSha256'] != self.s.core.request_digest or receipt['guardianSessionId'] != self.epoch['guardianSessionId'] or receipt['ackSha256'] != self.p.digest(self.manager_ack):
                    refuse('guardian release does not bind accepted ACK')
                self.p.sha(receipt['fenceReceiptSha256'])
                self.journal.core_write('GUARDIAN_RELEASE', receipt)
                self.local_release = receipt
                self.s.core.state = 'WAIT_HOST_CLEAR'
                # Keep the authenticated supervisor incarnation, control socket,
                # immutable descriptors and original unlocked OFD through host
                # clear/retirement. Local release is not terminal completion.
                self.guardian.commit_release(self.p.digest(receipt), self.s.core.previous)
            elif self.queue.next_kind() == 'fence-retired':
                self._terminal_deadline()
                receipt = self.queue.take('fence-retired')
                self.p.closed(receipt, ['grantId', 'managerEpoch', 'guestBootId', 'requestSha256',
                    'guardianSessionId', 'nonce', 'terminalSha256', 'ackSha256',
                    'releaseReceiptSha256', 'hostClearedEnvelopeSha256', 'clearedRecordSha256',
                    'retirementNonce', 'guestFenceSha256', 'retirementRecordSha256',
                    'guestFenceAbsent', 'authorityRestored', 'automaticRetryAllowed'])
                if self.local_release is None or any(receipt[key] != value for key, value in {
                    'grantId': self.lease.grant['grantId'], 'managerEpoch': self.epoch['managerEpoch'],
                    'guestBootId': self.lease.grant['guestBootId'], 'requestSha256': self.s.core.request_digest,
                    'guardianSessionId': self.epoch['guardianSessionId'], 'nonce': self.s.core.nonce,
                    'terminalSha256': self.p.digest(self.terminal_identity), 'ackSha256': self.p.digest(self.manager_ack),
                    'releaseReceiptSha256': self.p.digest(self.local_release)}.items()):
                    refuse('retirement notice differs from local terminal/release')
                for key in ['hostClearedEnvelopeSha256', 'clearedRecordSha256', 'retirementNonce',
                            'guestFenceSha256', 'retirementRecordSha256']:
                    self.p.sha(receipt[key])
                if receipt['guestFenceAbsent'] is not True or receipt['authorityRestored'] is not False or receipt['automaticRetryAllowed'] is not False:
                    refuse('retirement is not application/retry authority')
                # Protected guardian WAL retains the full authenticated notice
                # and reply; the supervisor never receives a signing credential.
                self.s.core.state = 'GUEST_RETIRED'
                self.fenced = True
                self.guardian.close_local_unresolved()
                self.s.close_inputs()
                for attribute in ['lock_fd', 'ledger_fd']:
                    fd = getattr(self.s.core, attribute)
                    setattr(self.s.core, attribute, None)
                    if fd is not None:
                        os.close(fd)
                self.s.core.inputs.close()
                return
            elif self.queue.next_kind() == 'worker':
                self.receive_worker()
            if self.terminal_identity is not None:
                self._terminal_deadline()
                self.guardian.owner_progress(self.heartbeat_sequence)
                self.heartbeat_sequence += 1
                self.last_tick = time.monotonic_ns()
                return
            if self.lease is not None and self.lease.state in ('WAIT_GRANT', 'WAIT_BIND'):
                if time.monotonic_ns() - self.lease.sent_ns > 5_000_000_000:
                    refuse('initial grant/bind deadline missed')
            if self.lease is not None and self.lease.state == 'BOUND':
                now = time.monotonic_ns()
                self.lease.check(now)
                if self.pending_outgoing is None and self.lease.pending is None and now >= self.lease.next_renew_ns - 1_000_000_000:
                    grant = self.lease.grant
                    payload = {k: grant[k] for k in ['grantId', 'managerEpoch', 'guestBootId', 'nonce', 'requestSha256', 'inputTableSha256']}
                    payload.update(type='RENEW', grantSequence=self.lease.sequence + 1,
                                   selectionSha256=self.policy['selectionSha256'], renewNonce=os.urandom(32).hex(),
                                   ledgerSha256=self.s.core.previous, unresolvedSummarySha256=self.p.digest(self.workers),
                                   supervisorHeartbeatSequence=self.heartbeat_sequence)
                    self._send(payload)
            # Heartbeat is after real iteration progress, never from a ticker.
            self.guardian.owner_progress(self.heartbeat_sequence)
            self.heartbeat_sequence += 1
            self.last_tick = time.monotonic_ns()
        except BaseException:
            self.abort()
            raise

    def _start_worker(self, role):
        self._owner()
        self.lease.check(time.monotonic_ns())
        if self.worker_pending is not None or any(phase != 'settled' for phase in self.workers.values()) or role in self.worker_roles.values():
            refuse('worker already pending/running/consumed')
        if role == 'image-inventory' and self.preflight_result is None:
            refuse('inventory requires settled archive preflight')
        self.worker_pending = role
        self.guardian.start_worker(role)

    def start_preflight(self):
        self._start_worker('archive-preflight')

    def start_inventory(self):
        self._start_worker('image-inventory')

    def receive_worker(self):
        message = self.queue.take('worker')
        self.p.closed(message, ['event', 'guardianRecordSha256'])
        self.p.sha(message['guardianRecordSha256'])
        event = message['event']
        self.p.closed(event, ['type', 'workerNonce', 'body'])
        nonce, kind, body = event['workerNonce'], event['type'], event['body']
        self.p.sha(nonce)
        if kind == 'prepared':
            if nonce in self.workers or self.worker_pending is None or body['role'] != self.worker_pending or body['workerNonce'] != nonce:
                refuse('unsolicited worker registration')
            self.worker_roles[nonce] = self.worker_pending
            self.worker_pending = None
            self.workers[nonce] = 'prepared'
        elif nonce not in self.workers:
            refuse('unregistered worker event')
        elif kind == 'authenticated':
            if self.workers[nonce] != 'prepared':
                refuse('worker authentication phase')
            self.workers[nonce] = 'running'
        elif kind in ('diagnostic', 'broker-prepared', 'broker-settled'):
            if self.workers[nonce] != 'running':
                refuse('worker observation phase')
        elif kind == 'result':
            if self.workers[nonce] != 'running':
                refuse('worker result phase')
            self.worker_results[nonce] = body
            self.workers[nonce] = 'result'
        elif kind == 'settled':
            if self.workers[nonce] != 'result' or body['outcome'] != 'observed' or body['cgroupEmpty'] is not True or type(body['exitCode']) is not int or body['exitCode'] != 0 or self.p.digest(body['result']) != self.p.digest(self.worker_results[nonce]):
                refuse('worker unsuccessful or mismatched settlement')
            self.workers[nonce] = 'settled'
            if self.worker_roles[nonce] == 'archive-preflight':
                self.preflight_result = self.worker_results[nonce]
            else:
                self.inventory_result = self.worker_results[nonce]
        else:
            refuse('unknown worker observation')
        # Full bounded results/diagnostics live in the guardian's private journal;
        # core keeps exact hash links, not duplicate unbounded diagnostic output.
        self.journal.core_write('WORKER_EVENT', {'workerNonce': nonce, 'type': kind,
            'eventSha256': self.p.digest(event), 'guardianRecordSha256': message['guardianRecordSha256'],
            'phase': self.workers[nonce]})

    def lifecycle_preflight_observation(self):
        """Internal adapter view of actual authenticated settled worker results.

        Not a grant, exported credential, shell interface or replacement owner.
        Only the existing pinned bootstrap constructs this control. A future
        lifecycle adapter must remain in this loop and obtain separate mutation
        admission; copying this return value never transfers live custody.
        """
        self._owner()
        if (self.lease is None or self.terminal_identity is not None or
                self.worker_pending is not None or len(self.workers) != 2 or
                set(self.worker_roles.values()) != {'archive-preflight', 'image-inventory'} or
                any(phase != 'settled' for phase in self.workers.values()) or
                self.preflight_result is None or self.inventory_result is None or
                self.pending_outgoing is not None or self.lease.pending is not None):
            refuse('lifecycle observation requires authenticated settled read-only workers')
        self.lease.check(time.monotonic_ns())
        results = self.p.parse(self.p.canonical({'preflight': self.preflight_result,
                                               'inventory': self.inventory_result}))
        for result in results.values():
            self.p.closed(result, ['receipt', 'sha256', 'bytes'])
            encoded = self.p.canonical(result['receipt'])
            if (type(result['bytes']) is not int or len(encoded) != result['bytes'] or
                    self.p.digest(result['receipt']) != result['sha256'] or
                    result['receipt'].get('loadAuthorized') is not False):
                refuse('settled result identity or non-authority changed')
        preflight, inventory = results['preflight'], results['inventory']
        if (preflight['receipt']['kind'] != 'immutable-fd-archive-preflight' or
                inventory['receipt']['kind'] != 'owner-gated-read-only-image-inventory' or
                inventory['receipt']['preflightSha256'] != preflight['sha256'] or
                inventory['receipt']['candidateSha'] != preflight['receipt']['sourceSha']):
            refuse('settled lifecycle prerequisite linkage differs')
        self.lease.check(time.monotonic_ns())
        return {'kind': 'lifecycle-readonly-prerequisites',
                'requestSha256': self.s.core.request_digest,
                'grantId': self.lease.grant['grantId'],
                'managerEpoch': self.lease.grant['managerEpoch'],
                'workerSummarySha256': self.p.digest(self.workers),
                'results': results, 'loadAuthorized': False, 'mutationAuthorized': False}

    def request_persistent_handoff(self):
        """Fixed owner-side refusal; no shell/caller evidence is accepted.

        Reuses the real settled-worker observation and existing custody. The
        pure handoff reducer is deliberately not registered/loaded: current
        guardian policy/peer has no persistent admission/effect/ACK role.
        Future reviewed integration must consume authenticated retained events,
        append full bounded predecessor/event/successor through ControlJournal,
        obtain independent durable owner ACK, then advance. Never accept a
        Python object or environment flag as installed authority.
        """
        self.lifecycle_preflight_observation()
        self.guardian.assert_live()
        self.lease.check(time.monotonic_ns())
        refuse('persistent handoff unavailable: installed owner/recovery admission and authenticated activation adapter missing')

    def finish_readonly_observation(self):
        self._owner()
        if self.terminal_identity is not None or self.worker_pending is not None or len(self.workers) != 2 or set(self.worker_roles.values()) != {'archive-preflight', 'image-inventory'} or any(phase != 'settled' for phase in self.workers.values()) or self.inventory_result is None or self.pending_outgoing is not None or self.lease.pending is not None:
            refuse('read-only terminal requires settled workers and control')
        self.lease.check(time.monotonic_ns())
        self.journal.enter_tail()
        self.journal.core_write('READONLY_TERMINAL', {'outcome': 'readonly-observed',
            'workerSummarySha256': self.p.digest(self.workers), 'preflightSha256': self.p.digest(self.preflight_result),
            'inventorySha256': self.p.digest(self.inventory_result), 'mutationRequestsDispatched': 0,
            'authorityRestored': False, 'fenceClearAuthorized': False})
        grant = self.lease.grant
        self.terminal_identity = {'type': 'TERMINAL', 'nonce': self.s.core.nonce,
            'requestSha256': self.s.core.request_digest, 'ledgerSha256': self.s.core.previous,
            'outcome': 'readonly-observed', 'grantId': grant['grantId'], 'managerEpoch': grant['managerEpoch'],
            'grantSequence': self.lease.sequence, 'guestBootId': grant['guestBootId']}
        self.s.core.state = 'TERMINAL_PENDING_ACK'
        return self._send(self.terminal_identity)

    def terminal(self):
        self._owner()
        try:
            if self.terminal_identity is not None or self.lease is None or self.workers or self.lease.pending is not None or self.pending_outgoing is not None:
                refuse('terminal requires one settled control lease and no outstanding work')
            self.guardian.assert_live()
            self.lease.check(time.monotonic_ns())
            # Fixed no-execution workflow; worker completion uses its distinct
            # READONLY_TERMINAL row and independently verified host156 protocol.
            self.journal.enter_tail()
            details = {'outcome': 'no-execution', 'cliSettled': True, 'daemonRequestsDispatched': 0, 'survivors': []}
            self.journal.core_write('TERMINAL', details)
            grant = self.lease.grant
            self.terminal_identity = {'type': 'TERMINAL', 'nonce': self.s.core.nonce,
                'requestSha256': self.s.core.request_digest, 'ledgerSha256': self.s.core.previous,
                'outcome': 'no-execution', 'grantId': grant['grantId'], 'managerEpoch': grant['managerEpoch'],
                'grantSequence': self.lease.sequence, 'guestBootId': grant['guestBootId']}
            self.s.core.state = 'TERMINAL_PENDING_ACK'
            return self._send(self.terminal_identity)
        except BaseException:
            self.abort()
            raise


    def abort(self):
        self.fenced = True
        self.s.poisoned = True
        self.s.core.state = 'GUARDIAN_UNRESOLVED'
        # Never invoke legacy Session.abort here: it assumed no registered work
        # and closes the flock. Guardian/host fence survives our own failure.
        # If notification fails, absence of owner heartbeat invokes independent
        # installed containment. No success receipt or custody release is claimed.
        try:
            self.guardian.retain_unresolved(self.s.core.nonce, self.s.core.request_digest)
        except BaseException as error:
            self.abort_notice_error = type(error).__name__


def reconstruct_control(primitives, context, control_rows):
    """Historical reducer only; NEVER returns a Session or live guardian handle.

    Caller must first verify complete core hash chain, all exchange envelope
    MACs/sequences and exact independent context. Incomplete histories produce
    unresolved-only observations; no terminal ACK or replay renewal is emitted.
    For complete control-only file/MAC verification use verify_control_history.
    Worker histories remain unsupported and restore no authority.
    """
    primitives.closed(context, ['request', 'epoch', 'policy', 'requestSentNs', 'unitDeadlineNs'])
    state = primitives.LeaseProtocol(context['request'], context['epoch'], context['policy'],
                                     primitives.local_nanoseconds(context['requestSentNs']),
                                     primitives.local_nanoseconds(context['unitDeadlineNs']))
    if len(control_rows) > 724:
        refuse('control replay record bound')
    for details in control_rows:
        primitives.closed(details, ['direction', 'observedNs', 'envelopeSha256', 'payload'])
        primitives.sha(details['envelopeSha256'])
        state.transition(details['direction'], details['payload'], primitives.local_nanoseconds(details['observedNs']))
    return {'historicalControlState': state.state, 'grantSequence': state.sequence,
            'sessionBindSha256': primitives.digest(state.binding) if state.binding is not None else None,
            'authorityRestored': False, 'terminalAcknowledgementAllowed': False,
            'outcome': 'unresolved-requires-guardian-reconciliation'}


def verify_control_history(primitives, key, key_id, core_bytes, exchange_bytes, expected, *, worker_records=None):
    """Verify complete control-only history without creating live authority.

    expected comes from independently approved historical installation/Manager
    context, never from either log. The caller must first establish private-file
    custody and stable reads. Missing/partial/unrecognized history refuses;
    refusal means retained unresolved ownership, never permission to retry work.
    No worker/mutation terminal is accepted by this control-only grammar.
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
        p.closed(record, ['guardianRecordSha256', 'event'])
        identity = p.sha(record['guardianRecordSha256'])
        if identity in protected_ids:
            refuse('reused protected worker record identity')
        protected_ids.add(identity)
    worker_cursor = 0
    for index, (row, raw) in enumerate(core_rows):
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
    auth = p.Authenticator(key, key_id, p.ADMISSION_DOMAIN)
    control_index = 0
    wire_phase = 'BOOTSTRAP'
    terminal = manager_ack = None
    # Reconstruct byte reservations from actual historical wrappers. A failure
    # is retained unresolved history, not a retroactive grant or truncated log.
    budgets = {'exchange': p.JournalBudget(0), 'core': p.JournalBudget(0)}
    for index, (row, raw) in enumerate(exchange_rows):
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
        budget = budgets[name]
        tail = False
        tail_bytes = 0
        for row, raw in source:
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
                if budget.pending_bytes is not None:
                    budget.used += budget.pending_bytes
                    budget.pending_bytes = None
            if tail:
                tail_bytes += len(raw)
                budget.used += len(raw)
                if tail_bytes > MAX or budget.used > 4 * MAX:
                    refuse('historical terminal tail exceeds reserve')
            elif kind == 'RENEW':
                budget.begin_pair(wire_size, len(raw))
            elif kind == 'RENEWED':
                budget.end_pair(wire_size, len(raw))
            else:
                budget.reserve_other(len(raw))
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


def read_control_snapshot(core_module, primitives, directory, nonce, key, key_id, expected):
    """Stable private-file read under existing flock; returns observation only.

    Called only by the independently installed reconciliation path. A live
    guardian holding the lock prevents this reader from claiming a quiescent
    namespace. The host fence still requires separate Manager reconciliation.
    """
    import fcntl
    import stat
    from pathlib import Path
    primitives.sha(nonce)
    if expected['nonce'] != nonce:
        refuse('wrong reconciliation nonce')
    root = Path(directory)
    if not root.is_absolute() or root.resolve(strict=True) != root:
        refuse('noncanonical historical namespace')
    for parent in [root, *root.parents]:
        info = parent.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            refuse('historical directory custody absent')
    owned = []
    try:
        lock = core_module.open_root_file(core_module.LOCK)
        owned.append(lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        owned.append(root_fd)
        if os.fstat(root_fd).st_mode & 0o077 or set(os.listdir(root_fd)) != {nonce, nonce + '.exchange'}:
            refuse('unknown/nonprivate historical namespace')
        blobs = []
        for name in [nonce, nonce + '.exchange']:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root_fd)
            owned.append(fd)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o077 or not 0 < before.st_size <= 4 * MAX:
                refuse('historical file custody/size absent')
            data = bytearray()
            while chunk := os.read(fd, min(MAX, 4 * MAX + 1 - len(data))):
                data.extend(chunk)
                if len(data) > 4 * MAX:
                    refuse('historical file grew beyond bound')
            after = os.fstat(fd)
            fields = ['st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid']
            if any(getattr(before, field) != getattr(after, field) for field in fields) or len(data) != before.st_size:
                refuse('historical file changed')
            blobs.append(bytes(data))
        return verify_control_history(primitives, key, key_id, blobs[0], blobs[1], expected)
    finally:
        # Closing the read-only observer's flock is not clearing a Manager fence.
        for fd in reversed(owned):
            try:
                os.close(fd)
            except OSError:
                pass


if __name__ == '__main__':
    raise SystemExit('Guardian Session adapter uninstalled; CLI execution refused.')
