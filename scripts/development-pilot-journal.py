"""Pinned guardian-only signed handoff history; no public/key/dispatch interface.

Writer uses the existing guardian WAL. Verification authenticates recorded
statements, not host truth. Installed truth adapters still refuse in Guardian.
No unsigned receipt, hash-shaped stand-in, partial genesis or replay grants work.
"""
import hashlib
import hmac

MAX = 1048576
DOMAIN = 'lunchlineup.private-pilot-history.v1'
# Release a producer only after the entire conjunction is durably read back.
PRODUCER_GATES = {
    'web': ('cohort-access',),
    'api': ('application-writes', 'queue-consumption', 'mail-delivery',
            'webhook-delivery', 'export-jobs', 'deletion-jobs', 'retention-jobs', 'billing-effects'),
    'api-v2': ('application-writes', 'queue-consumption', 'mail-delivery'),
    'worker': ('application-writes', 'queue-consumption', 'mail-delivery', 'retention-jobs', 'billing-effects'),
    'webhook-replay': ('application-writes', 'queue-consumption', 'webhook-delivery'),
    'engine': ('application-writes', 'queue-consumption'),
    'pdf-parser': ('application-writes', 'queue-consumption'),
}
# There is no reviewed live runtime-gate recipe yet. These only describe safe
# preacceptance startup dispositions; no stopped producer can be released here.
STARTUP_RECIPES = frozenset(('remain-stopped-v1', 'separate-scheduled-owner-v1',
                             'explicitly-unavailable-v1'))


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


def signed_payload(p, key, key_id, value, purpose):
    p.closed(value, ['domain', 'purpose', 'keyId', 'payload', 'mac'])
    require(type(key) is bytes and len(key) == 32 and value['domain'] == DOMAIN and
            value['purpose'] == purpose and value['keyId'] == key_id, 'fixed signed history identity')
    p.sha(value['mac'])
    unsigned = {name: value[name] for name in ('domain', 'purpose', 'keyId', 'payload')}
    wire = p.canonical(unsigned)
    require(len(wire) <= MAX, 'signed history bound')
    expected = hmac.new(key, wire, hashlib.sha256).hexdigest()
    require(hmac.compare_digest(expected, value['mac']), 'handoff history MAC mismatch')
    return value['payload']


def scope_contents(p, reducer, scope, expected):
    p.closed(scope, ['version', 'handoffId', 'requestSha256', 'selectionSha256',
        'sourceSha', 'treeSha', 'guestBootId', 'managerEpoch', 'guardianSessionId',
        'machineId', 'vmid', 'origin', 'project', 'operator', 'approvalReference',
        'dataMode', 'cohortSha256', 'approvedEffects', 'producerPolicies',
        'installedEngineSha256', 'resourceInventorySha256', 'recoveryOwnerSha256',
        'originalStartNs', 'originalDeadlineNs', 'terminalReserveMs'])
    require(type(scope['version']) is int and scope['version'] == 1, 'scope version')
    p.closed(expected, ['scopeSha256', 'requestSha256', 'selectionSha256', 'sourceSha', 'treeSha',
        'guestBootId', 'managerEpoch', 'guardianSessionId', 'originalStartNs', 'originalDeadlineNs'])
    require(p.digest(scope) == expected['scopeSha256'] and all(scope[key] == expected[key]
        for key in expected if key != 'scopeSha256'), 'independently pinned scope and actual custody differ')
    for name in ('handoffId', 'requestSha256', 'selectionSha256', 'cohortSha256',
                 'installedEngineSha256', 'resourceInventorySha256', 'recoveryOwnerSha256'):
        p.sha(scope[name])
    require(scope['machineId'] == '80a9dfd43bbc6a074cf9148daa5335c2' and type(scope['vmid']) is int and
        scope['vmid'] == 107 and scope['origin'] == 'https://dev.lunchlineup.com', 'exact private target')
    require(type(scope['project']) is str and scope['project'].startswith('lunchlineup-dev-') and
        len(scope['project']) <= 63 and all(c in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in scope['project']),
        'scoped private project')
    for name in ('operator', 'approvalReference'):
        require(type(scope[name]) is str and 1 <= len(scope[name]) <= 256 and
                scope[name] != 'UNFILLED', 'named prior human authority')
    require(scope['dataMode'] in ('synthetic', 'shadow', 'authoritative'), 'explicit data mode')
    start = p.local_nanoseconds(scope['originalStartNs']); end = p.local_nanoseconds(scope['originalDeadlineNs'])
    require(0 < end - start <= 180000000000, 'original maintenance ceiling')
    p.integer(scope['terminalReserveMs'], 5000, 180000)
    require(scope['terminalReserveMs'] * 1000000 < end - start, 'terminal reserve inside original lifetime')
    effects = scope['approvedEffects']
    require(type(effects) is list and all(type(x) is str and x in reducer.EFFECTS for x in effects)
        and effects == sorted(set(effects)), 'approved scope exact finite effects')
    policies = scope['producerPolicies']
    require(type(policies) is dict and set(policies) == reducer.SERVICES, 'full startup inventory')
    for service, policy in policies.items():
        p.closed(policy, ['startupRecipe', 'requiredEffects', 'dbScopeSha256', 'queueScopeSha256',
            'egressScopeSha256', 'secretScopeSha256', 'restrictionApprovalSha256'])
        require(policy['startupRecipe'] in STARTUP_RECIPES, 'unimplemented live producer gate recipe')
        wanted = sorted(PRODUCER_GATES.get(service, ()))
        require(policy['requiredEffects'] == wanted, 'producer gate conjunction cannot be weakened')
        for field in ('dbScopeSha256', 'queueScopeSha256', 'egressScopeSha256', 'secretScopeSha256', 'restrictionApprovalSha256'):
            p.sha(policy[field])
    return scope


# Exact content types for every digest reference emitted by the243 reducer.
EVIDENCE_FIELDS = {
    'human-approval': ('operator', 'approvalReference', 'scopeSha256', 'approvedEffects'),
    'installation': ('engineSha256', 'resourceInventorySha256', 'guestBootId', 'sourceSha', 'treeSha'),
    'recovery-admission': ('recoveryOwnerSha256', 'engineSha256', 'scopeSha256', 'independentOfMaintenance'),
    'install-intent': ('engineSha256', 'resourceInventorySha256', 'scopeSha256', 'noDispatch'),
    'quarantine': ('producerPolicies', 'cohortClosed', 'businessWritesClosed', 'queueConsumersStopped', 'readinessSends'),
    'recovery-armed': ('recoveryOwnerSha256', 'engineSha256', 'scopeSha256', 'armedBeforeAnyCreate'),
    'readiness': ('inventorySha256', 'scopeSha256', 'selectedChecksSha256', 'unavailableServices'),
    'temporary-settlement': ('inventorySha256', 'pendingChildren', 'pendingCli', 'originalDeadlineNs'),
    'backend-settlement': ('inventorySha256', 'pendingDbBackends', 'pendingQueueDeliveries', 'unknownEffects'),
    'owner-ack': ('inventorySha256', 'scopeSha256', 'operator', 'recoveryOwnerSha256'),
    'durable-ack': ('inventorySha256', 'ownerAckSha256', 'scopeSha256', 'durableRecordSha256'),
    'activation-intent': ('inventorySha256', 'scopeSha256', 'effect', 'producerServices', 'recipe'),
    'activation-readback': ('inventorySha256', 'scopeSha256', 'effect', 'intentSha256', 'producerServices', 'recipe', 'released'),
    'active-commit': ('inventorySha256', 'scopeSha256', 'activationReadbackSetSha256', 'durableRecordSha256'),
    'unknown': ('inventorySha256', 'scopeSha256', 'unresolvedOperations', 'retryAllowed'),
    'recovery-settlement': ('inventorySha256', 'recoveryOwnerSha256', 'exactStoppedIds', 'unknownEffects'),
    'data-preserved': ('inventorySha256', 'resourceInventorySha256', 'backupPositionSha256', 'dataDeleted'),
    'fresh-admission': ('inventorySha256', 'scopeSha256', 'action', 'originalStartNs', 'originalDeadlineNs'),
    'drain-settlement': ('inventorySha256', 'pendingDbBackends', 'pendingQueueDeliveries', 'unknownEffects'),
    'stop-settlement': ('inventorySha256', 'exactStoppedIds', 'unknownEffects', 'unrelatedStoppedIds'),
}
EVENT_REFERENCES = {
    'admit': {'humanApprovalSha256': 'human-approval', 'installationSha256': 'installation', 'recoveryAdmissionSha256': 'recovery-admission'},
    'install-intent': {'intentSha256': 'install-intent', 'quarantineSha256': 'quarantine', 'independentRecoveryArmedSha256': 'recovery-armed'},
    'observe-inventory': {'readinessSha256': 'readiness', 'quarantineReadbackSha256': 'quarantine',
        'temporarySettlementSha256': 'temporary-settlement', 'backendSettlementSha256': 'backend-settlement'},
    'mechanical-acceptance': {'ownerAckSha256': 'owner-ack', 'durableAckSha256': 'durable-ack'},
    'activation-intent': {'intentSha256': 'activation-intent'},
    'activation-readback': {'readbackSha256': 'activation-readback'},
    'commit-active': {'ownerDurableCommitSha256': 'active-commit'},
    'outcome-unknown': {'unresolvedEvidenceSha256': 'unknown'},
    'failed-closed': {'independentRecoverySettlementSha256': 'recovery-settlement',
        'quarantineReadbackSha256': 'quarantine', 'dataPreservedSha256': 'data-preserved'},
    'pause': {'freshAdmissionSha256': 'fresh-admission', 'drainSettlementSha256': 'drain-settlement',
        'exactStopSettlementSha256': 'stop-settlement', 'dataAndBackupPositionSha256': 'data-preserved'},
    'incident': {'freshAdmissionSha256': 'fresh-admission', 'drainSettlementSha256': 'drain-settlement',
        'exactStopSettlementSha256': 'stop-settlement', 'dataAndBackupPositionSha256': 'data-preserved'},
}


def evidence_contents(p, reducer, receipt, kind, scope, previous, event):
    p.closed(receipt, ['kind', 'scopeSha256', 'eventSha256', 'body'])
    require(receipt['kind'] == kind and receipt['scopeSha256'] == p.digest(scope) and
        receipt['eventSha256'] == p.digest({**event, 'body': {name: value for name, value in event['body'].items()
            if name not in EVENT_REFERENCES[event['kind']]}}), 'typed receipt binds exact event and scope')
    body = receipt['body']; p.closed(body, EVIDENCE_FIELDS[kind])
    inventory_sha = p.digest(event['body']['inventory']) if event['kind'] == 'observe-inventory' else previous['inventorySha256']
    expected_values = {'scopeSha256': p.digest(scope), 'inventorySha256': inventory_sha,
        'operator': scope['operator'], 'approvalReference': scope['approvalReference'],
        'approvedEffects': scope['approvedEffects'], 'engineSha256': scope['installedEngineSha256'],
        'resourceInventorySha256': scope['resourceInventorySha256'], 'guestBootId': scope['guestBootId'],
        'sourceSha': scope['sourceSha'], 'treeSha': scope['treeSha'], 'recoveryOwnerSha256': scope['recoveryOwnerSha256'],
        'producerPolicies': scope['producerPolicies'], 'originalDeadlineNs': scope['originalDeadlineNs']}
    for key, value in body.items():
        if key in expected_values:
            require(value == expected_values[key], 'typed evidence content/custody differs: ' + key)
        elif key.endswith('Sha256'):
            p.sha(value)
    for key in ('pendingChildren', 'pendingCli', 'pendingDbBackends', 'pendingQueueDeliveries', 'unknownEffects', 'unrelatedStoppedIds', 'readinessSends'):
        if key in body: require(body[key] == [] and type(body[key]) is list, 'unsettled or unapproved effect')
    for key in ('independentOfMaintenance', 'noDispatch', 'cohortClosed', 'businessWritesClosed', 'queueConsumersStopped', 'armedBeforeAnyCreate'):
        if key in body: require(body[key] is True, 'required declared quarantine/ownership fact')
    for key in ('retryAllowed', 'dataDeleted'):
        if key in body: require(body[key] is False, 'no retry/deletion authority')
    if 'exactStoppedIds' in body:
        wanted = sorted(item['containerId'] for item in (previous['inventory'] or {}).values() if item['containerId'])
        require(body['exactStoppedIds'] == wanted, 'exact accepted stop inventory')
    if kind == 'readiness':
        wanted = sorted(name for name, item in event['body']['inventory'].items() if item['disposition'] in ('unavailable', 'separate-scheduled'))
        require(body['unavailableServices'] == wanted, 'readiness preserves unavailable scope')
    if kind == 'durable-ack':
        require(body['ownerAckSha256'] == event['body']['ownerAckSha256'], 'durable ACK exact owner ACK')
    if kind == 'active-commit':
        require(body['activationReadbackSetSha256'] == event['body']['activationReadbackSetSha256'], 'durable commit exact effects')
    if kind in ('activation-intent', 'activation-readback'):
        require(body['effect'] == event['body']['effect'], 'exact activation effect')
        require(type(body['producerServices']) is list and body['producerServices'] == [],
                'no live producer runtime gate recipe implemented')
        require(body['recipe'] == 'no-producer-release-v1', 'only explicit no-release observation')
        if kind == 'activation-readback':
            require(body['intentSha256'] == event['body']['intentSha256'] and body['released'] is False,
                    'no producer release claim')
        # A no-release observation cannot satisfy a selected business effect.
        raise RuntimeError('activation truth/runtime gate adapter unavailable')
    if kind == 'fresh-admission':
        require(body['action'] == event['kind'], 'exact pause/incident admission')
        require(p.local_nanoseconds(body['originalStartNs']) < p.local_nanoseconds(body['originalDeadlineNs']), 'stop lifetime')
    if kind == 'unknown':
        require(type(body['unresolvedOperations']) is list and 1 <= len(body['unresolvedOperations']) <= 128 and
            all(type(x) is str and 1 <= len(x) <= 128 for x in body['unresolvedOperations']), 'bounded unresolved inventory')


def replay(p, reducer, key, key_id, bundle, expected):
    """Cryptographically verify a complete signed declaration history from genesis.

    Caller supplies only independently pinned private input bytes/actual context.
    Result cannot attest host truth, restore authority or authorize dispatch.
    """
    p.closed(bundle, ['scope', 'genesis', 'records'])
    scope = scope_contents(p, reducer, signed_payload(p, key, key_id, bundle['scope'], 'scope'), expected)
    genesis = signed_payload(p, key, key_id, bundle['genesis'], 'genesis')
    reducer.validate_record(genesis)
    require(genesis['sequence'] == 0 and genesis['handoffId'] == scope['handoffId'] and
        genesis['scopeSha256'] == p.digest(scope) and genesis['approvedEffects'] == scope['approvedEffects'],
        'full genesis binds prior-approved effects')
    records = bundle['records']; require(type(records) is list and len(records) <= 128, 'bounded full event history')
    previous = genesis; receipt_tail = p.digest(bundle['genesis']); observed = p.local_nanoseconds(scope['originalStartNs'])
    total = len(p.canonical(bundle)); require(total <= MAX, 'aggregate signed bundle bound')
    for sequence, envelope in enumerate(records):
        payload = signed_payload(p, key, key_id, envelope, 'event')
        p.closed(payload, ['sequence', 'previousReceiptSha256', 'actor', 'observedNs', 'event', 'evidence', 'successor'])
        p.integer(payload['sequence'], sequence, sequence)
        require(payload['previousReceiptSha256'] == receipt_tail and payload['actor'] == scope['guardianSessionId'],
                'signed actor and full receipt lineage')
        now = p.local_nanoseconds(payload['observedNs'])
        require(observed <= now < p.local_nanoseconds(scope['originalDeadlineNs']) - scope['terminalReserveMs'] * 1000000,
                'historical event outside original reserved lifetime')
        event = payload['event']; require(type(event) is dict and event.get('kind') in EVENT_REFERENCES, 'typed event')
        # Reducer validates complete event before typed receipts dereference it.
        result = reducer.reduce_declarations(p.canonical(previous), p.canonical(event))
        references = EVENT_REFERENCES[event['kind']]; evidence = payload['evidence']
        p.closed(evidence, references)
        for field, kind in references.items():
            require(p.digest(evidence[field]) == event['body'][field], 'full receipt content hash required')
            evidence_contents(p, reducer, evidence[field], kind, scope, previous, event)
        require(p.canonical(payload['successor']) == p.canonical(result['record']), 'signed successor differs from full replay')
        previous = result['record']; receipt_tail = p.digest(envelope); observed = now
    return {'scope': scope, 'record': previous, 'receiptTailSha256': receipt_tail,
        'signedHistoryVerified': True, 'hostTruthVerified': False, 'authorityRestored': False,
        'mutationAuthorized': False, 'lockReleaseAuthorized': False}


def append_to_existing_wal(guardian):
    """Fixed Guardian-only call; no request record, key or callback argument.

    The pinned actual owner reads its independently held inputs; missing truth
    refuses before any write. This function does not sign receipts or dispatch.
    """
    guardian.require_pilot_custody()
    bundle, expected = guardian.read_pinned_pilot_inputs()
    result = replay(guardian.p, guardian.modules['pilotReducer'], guardian.key,
                    guardian.a['keyId'], bundle, expected)
    guardian.require_pilot_truth(result)  # Current fixed implementation refuses.
    guardian.require_pilot_custody()
    snapshot = guardian.protected_history()
    prior = [row for row in snapshot['rows'] if row['row']['kind'] == 'PILOT_HISTORY']
    if prior:
        last = prior[-1]['row']['body']['bundle']
        require(bundle['scope'] == last['scope'] and bundle['genesis'] == last['genesis'] and
                bundle['records'][:-1] == last['records'] and len(bundle['records']) == len(last['records']) + 1,
                'append exactly one signed event to exact committed genesis/history')
    else:
        require(bundle['records'] == [], 'first durable row must contain signed genesis only')
    body = {'bundle': bundle, 'expected': expected, 'receiptTailSha256': result['receiptTailSha256'],
            'authorityRestored': False, 'mutationAuthorized': False}
    # Journal.append itself precharges the fully wrapped row and aggregate16MiB.
    # Do not write a second core log or consume its reserved4MiB/tail implicitly.
    wrapped = {'sequence': guardian.journal.sequence, 'previous': guardian.journal.previous,
               'kind': 'PILOT_HISTORY', 'body': body}
    require(len(guardian.p.canonical(wrapped)) + 1 <= MAX + 1024 and
            guardian.journal.bytes + len(guardian.p.canonical(wrapped)) + 1 + MAX <= 16 * MAX,
            'wrapped guardian WAL plus terminal reserve')
    receipt = guardian.journal.append('PILOT_HISTORY', body)
    guardian.require_pilot_custody()
    return {'guardianRecordSha256': receipt, 'authorityRestored': False, 'mutationAuthorized': False}


if __name__ == '__main__':
    raise SystemExit('Pinned guardian history library only; no CLI.')
