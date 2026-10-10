"""KPT243 non-authorizing persistent-handoff state reducer.

Pure bounded data checks for a future pinned caller in existing SerializedControl.
No CLI, files, socket, process, daemon, independent journal or grant exists here.
Declared evidence hashes are NOT authenticated evidence. The current caller
refuses: installed admission, evidence authentication and recovery are missing.
"""
import hashlib
import json
import re

MAX_BYTES = 1048576
SERVICES = frozenset(('proxy', 'web', 'api', 'webhook-replay', 'migrate', 'engine',
    'pdf-parser', 'worker', 'pgbouncer', 'pitr-wal-provider', 'api-v2',
    'pitr-lifecycle-audit', 'postgres', 'redis', 'rabbitmq', 'control', 'autoheal',
    'prometheus', 'backup', 'pitr-base-backup', 'pitr-restore', 'alertmanager',
    'node-exporter', 'loki', 'promtail', 'otel-collector', 'tempo', 'grafana'))
EFFECTS = frozenset(('cohort-access', 'application-writes', 'queue-consumption',
    'mail-delivery', 'webhook-delivery', 'export-jobs', 'deletion-jobs',
    'retention-jobs', 'billing-effects'))
PHASES = frozenset(('PROPOSED', 'ADMITTED', 'INSTALLING', 'AWAITING_ACCEPTANCE',
    'ACCEPTED_QUARANTINED', 'ACTIVATING', 'ACTIVE', 'OUTCOME_UNKNOWN',
    'FAILED_CLOSED', 'PAUSED', 'INCIDENT'))


class Refusal(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise Refusal(reason)


def closed(value, fields):
    require(type(value) is dict and set(value) == set(fields), 'closed handoff fields')


def sha(value):
    require(type(value) is str and re.fullmatch('[a-f0-9]{64}', value), 'SHA256 required')


def integer(value, low, high):
    require(type(value) is int and low <= value <= high, 'finite integer required')


def canonical(value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                     allow_nan=False).encode('ascii')
    require(0 < len(raw) <= MAX_BYTES, 'aggregate handoff byte bound')
    return raw


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def parse(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, 'canonical input byte bound')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate field')
            result[key] = value
        return result
    def invalid(_):
        raise Refusal('noninteger number')
    value = json.loads(raw.decode('ascii'), object_pairs_hook=pairs,
                       parse_float=invalid, parse_constant=invalid)
    require(canonical(value) == raw, 'canonical record required')
    return value


def inventory(value):
    require(type(value) is dict and set(value) == SERVICES, 'full 28-service inventory')
    for name, item in value.items():
        closed(item, ('disposition', 'configSha256', 'imageSha256', 'containerId',
            'runtimeIdentitySha256', 'resourceIdentitySha256', 'restrictionDecisionSha256'))
        require(item['disposition'] in ('running-quarantined', 'stopped', 'unavailable',
                                       'separate-scheduled'), 'explicit service disposition')
        for key in ('configSha256', 'imageSha256', 'restrictionDecisionSha256'):
            sha(item[key])
        if item['disposition'] in ('running-quarantined', 'stopped'):
            for key in ('containerId', 'runtimeIdentitySha256', 'resourceIdentitySha256'):
                sha(item[key])
        else:
            require(all(item[key] == '' for key in
                ('containerId', 'runtimeIdentitySha256', 'resourceIdentitySha256')),
                'unavailable/scheduled service cannot invent a current container')
        if name == 'autoheal':
            require(item['disposition'] == 'unavailable', 'all-container autoheal remains unsupported')
    ids = [item['containerId'] for item in value.values() if item['containerId']]
    require(len(ids) == len(set(ids)), 'distinct actual container identities')


def validate_record(record):
    closed(record, ('version', 'kind', 'handoffId', 'sequence', 'previousSha256',
        'state', 'scopeSha256', 'humanApprovalSha256', 'installationSha256',
        'recoveryAdmissionSha256', 'inventory', 'inventorySha256', 'acceptanceSha256',
        'approvedEffects', 'effects', 'lastEventSha256'))
    require(type(record['version']) is int and record['version'] == 1 and
            record['kind'] == 'private-pilot-handoff', 'record version/kind')
    sha(record['handoffId']); sha(record['scopeSha256'])
    integer(record['sequence'], 0, 128)
    require(type(record['state']) is str and record['state'] in PHASES, 'handoff phase')
    for key in ('previousSha256', 'humanApprovalSha256', 'installationSha256',
                'recoveryAdmissionSha256', 'inventorySha256', 'acceptanceSha256', 'lastEventSha256'):
        if record[key] != '':
            sha(record[key])
    approved = record['approvedEffects']
    require(type(approved) is list and all(type(x) is str and x in EFFECTS for x in approved)
            and approved == sorted(set(approved)), 'closed finite prior-approved effect scope')
    effects = record['effects']
    require(type(effects) is dict and set(effects).issubset(approved), 'effect subset')
    for name, effect in effects.items():
        closed(effect, ('intentSha256', 'readbackSha256'))
        sha(effect['intentSha256'])
        if effect['readbackSha256'] != '':
            sha(effect['readbackSha256'])
    if record['inventory'] is None:
        require(record['inventorySha256'] == record['acceptanceSha256'] == '', 'no invented acceptance')
    else:
        inventory(record['inventory'])
        require(record['inventorySha256'] == digest(record['inventory']), 'inventory digest')
    if record['sequence'] == 0:
        require(record['state'] == 'PROPOSED' and record['previousSha256'] == record['lastEventSha256'] == ''
            and record['humanApprovalSha256'] == record['installationSha256'] == record['recoveryAdmissionSha256'] == ''
            and record['inventory'] is None and not effects, 'exact initial state')
    else:
        sha(record['previousSha256']); sha(record['lastEventSha256'])
    if record['state'] not in ('PROPOSED', 'FAILED_CLOSED', 'OUTCOME_UNKNOWN'):
        for key in ('humanApprovalSha256', 'installationSha256', 'recoveryAdmissionSha256'):
            sha(record[key])
    if record['state'] in ('AWAITING_ACCEPTANCE', 'ACCEPTED_QUARANTINED', 'ACTIVATING', 'ACTIVE', 'PAUSED', 'INCIDENT'):
        require(record['inventory'] is not None, 'actual inventory required')
    if record['state'] in ('ACCEPTED_QUARANTINED', 'ACTIVATING', 'ACTIVE', 'PAUSED', 'INCIDENT'):
        sha(record['acceptanceSha256'])
    if record['state'] in ('PROPOSED', 'ADMITTED', 'INSTALLING', 'AWAITING_ACCEPTANCE', 'ACCEPTED_QUARANTINED'):
        require(not effects, 'no preacceptance activation effects')
    if record['state'] == 'ACTIVE':
        require(set(effects) == set(approved) and all(e['readbackSha256'] for e in effects.values()),
                'ACTIVE requires every approved release readback')


def reduce_declarations(previous_raw, event_raw):
    """Return proposed successor bytes, never persist/accept/grant/dispatch them.

    A future fixed caller must obtain both records from authenticated existing
    guardian custody, verify complete retained lineage and typed receipt contents,
    enforce original time/lock and persist through ControlJournal before acting.
    Caller-supplied hashes and a successful return are never authority.
    """
    previous = parse(previous_raw); event = parse(event_raw)
    validate_record(previous)
    closed(event, ('handoffId', 'previousSha256', 'sequence', 'kind', 'body'))
    require(event['handoffId'] == previous['handoffId'] and
            event['previousSha256'] == digest(previous), 'exact immutable predecessor')
    integer(event['sequence'], previous['sequence'] + 1, previous['sequence'] + 1)
    require(previous['state'] not in ('OUTCOME_UNKNOWN', 'FAILED_CLOSED', 'PAUSED', 'INCIDENT'),
            'terminal/unknown cannot replay; separately admitted reconciliation required')
    result = parse(previous_raw); body = event['body']; kind = event['kind']; state = previous['state']
    if kind == 'admit':
        require(state == 'PROPOSED', 'admit once')
        closed(body, ('scopeSha256', 'humanApprovalSha256', 'installationSha256', 'recoveryAdmissionSha256'))
        require(body['scopeSha256'] == previous['scopeSha256'], 'human scope fixed before installation')
        for key in ('humanApprovalSha256', 'installationSha256', 'recoveryAdmissionSha256'):
            sha(body[key]); result[key] = body[key]
        result['state'] = 'ADMITTED'
    elif kind == 'install-intent':
        require(state == 'ADMITTED', 'install after independent crash recovery admission')
        closed(body, ('intentSha256', 'quarantineSha256', 'independentRecoveryArmedSha256'))
        for value in body.values(): sha(value)
        result['state'] = 'INSTALLING'
    elif kind == 'observe-inventory':
        require(state == 'INSTALLING', 'observe only after install intent')
        closed(body, ('inventory', 'readinessSha256', 'quarantineReadbackSha256',
            'temporarySettlementSha256', 'backendSettlementSha256'))
        inventory(body['inventory'])
        for key in ('readinessSha256', 'quarantineReadbackSha256', 'temporarySettlementSha256', 'backendSettlementSha256'):
            sha(body[key])
        result['inventory'] = body['inventory']; result['inventorySha256'] = digest(body['inventory'])
        result['state'] = 'AWAITING_ACCEPTANCE'
    elif kind == 'mechanical-acceptance':
        require(state == 'AWAITING_ACCEPTANCE', 'mechanical ACK follows exact observed inventory')
        closed(body, ('inventorySha256', 'humanApprovalSha256', 'scopeSha256', 'ownerAckSha256', 'durableAckSha256'))
        for key in ('inventorySha256', 'humanApprovalSha256', 'scopeSha256'):
            require(body[key] == previous[key], 'ACK exact prior-approved actual scope')
        sha(body['ownerAckSha256']); sha(body['durableAckSha256'])
        result['acceptanceSha256'] = digest(body); result['state'] = 'ACCEPTED_QUARANTINED'
    elif kind == 'activation-intent':
        require(state in ('ACCEPTED_QUARANTINED', 'ACTIVATING'), 'activation after durable ACK')
        closed(body, ('effect', 'inventorySha256', 'acceptanceSha256', 'intentSha256'))
        require(type(body['effect']) is str and body['effect'] in previous['approvedEffects']
            and body['effect'] not in previous['effects'], 'no extra/replayed activation effect')
        require(all(e['readbackSha256'] for e in previous['effects'].values()), 'settle preceding effect first')
        for key in ('inventorySha256', 'acceptanceSha256'):
            require(body[key] == previous[key], 'activation binds accepted incarnation')
        sha(body['intentSha256'])
        result['effects'][body['effect']] = {'intentSha256': body['intentSha256'], 'readbackSha256': ''}
        result['state'] = 'ACTIVATING'
    elif kind == 'activation-readback':
        require(state == 'ACTIVATING', 'readback requires pending activation')
        closed(body, ('effect', 'inventorySha256', 'intentSha256', 'readbackSha256'))
        require(type(body['effect']) is str and body['effect'] in previous['effects'], 'exact pending effect')
        effect = previous['effects'][body['effect']]
        require(not effect['readbackSha256'] and body['intentSha256'] == effect['intentSha256']
            and body['inventorySha256'] == previous['inventorySha256'], 'unchanged actual incarnation and intent')
        sha(body['readbackSha256']); result['effects'][body['effect']]['readbackSha256'] = body['readbackSha256']
    elif kind == 'commit-active':
        require(state in ('ACCEPTED_QUARANTINED', 'ACTIVATING'), 'activation commit phase')
        closed(body, ('inventorySha256', 'activationReadbackSetSha256', 'ownerDurableCommitSha256'))
        require(body['inventorySha256'] == previous['inventorySha256'] and
            body['activationReadbackSetSha256'] == digest(previous['effects']), 'commit exact settled effect set')
        require(set(previous['effects']) == set(previous['approvedEffects']) and
            all(e['readbackSha256'] for e in previous['effects'].values()), 'no partial ACTIVE commit')
        sha(body['ownerDurableCommitSha256']); result['state'] = 'ACTIVE'
    elif kind == 'outcome-unknown':
        closed(body, ('unresolvedEvidenceSha256',)); sha(body['unresolvedEvidenceSha256'])
        result['state'] = 'OUTCOME_UNKNOWN'
    elif kind == 'failed-closed':
        require(state in ('PROPOSED', 'ADMITTED', 'INSTALLING', 'AWAITING_ACCEPTANCE'), 'no rollback after possible acceptance')
        closed(body, ('independentRecoverySettlementSha256', 'quarantineReadbackSha256', 'dataPreservedSha256'))
        for value in body.values(): sha(value)
        result['state'] = 'FAILED_CLOSED'
    elif kind in ('pause', 'incident'):
        require(state == 'ACTIVE', 'separate maintenance after activation')
        closed(body, ('freshAdmissionSha256', 'inventorySha256', 'drainSettlementSha256',
            'exactStopSettlementSha256', 'dataAndBackupPositionSha256'))
        require(body['inventorySha256'] == previous['inventorySha256'], 'stop exact accepted inventory')
        for value in body.values(): sha(value)
        result['state'] = 'PAUSED' if kind == 'pause' else 'INCIDENT'
    else:
        raise Refusal('unsupported event')
    result['sequence'] = event['sequence']; result['previousSha256'] = event['previousSha256']
    result['lastEventSha256'] = digest(event); validate_record(result)
    return {'record': result, 'recordSha256': digest(result), 'authorityVerified': False,
        'durable': False, 'mutationAuthorized': False, 'lockReleaseAuthorized': False}


def dispatch(*_args, **_kwargs):
    raise Refusal('persistent dispatch unavailable: installed admission, authenticated evidence and recovery missing')


if __name__ == '__main__':
    raise SystemExit('No public handoff CLI or persistent authority.')
