import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

export function canonicalObservation(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalObservation).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const row = value as Record<string, unknown>;
        return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalObservation(row[key])}`).join(',')}}`;
    }
    const result = JSON.stringify(value);
    requireEvidence(typeof result === 'string', 'Unsupported observation evidence.');
    return result;
}
export const observationDigest = (value: unknown) => createHash('sha256').update(canonicalObservation(value)).digest('hex');
const canonicalHistory = (value: unknown) => canonicalObservation(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const historyDigest = (value: unknown) => createHash('sha256').update(canonicalHistory(value)).digest('hex');
function requireEvidence(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function closed(row: any, fields: string[]): void {
    requireEvidence(row && typeof row === 'object' && !Array.isArray(row)
        && Object.keys(row).sort().join('\0') === fields.sort().join('\0'), 'Closed predecessor evidence required.');
}

export type CancellationObservationSelection = Readonly<{
    jobId: string; tenantId: string; observationId: string; predecessorIntentSha256: string;
    providerIntentSha256: string; originalPolicySha256: string; originalOwnerKeySha256: string; originalRecoveryKeySha256: string; priorReceiptSha256: string | null; recoveryEvidenceSha256: string;
    customerId: string; subscriptionId: string;
}>;
export type CancellationProcessFence = Readonly<{
    evidenceSha256: string; historySha256: string; recoveryFenceSha256: string;
    applicationProcessSettled: true; backendSettlementProved: false; retryAllowed: false;
}>;

/** Exact bytes (including both original public keys) are pinned by the new root-owned
 * policy and authenticated HELLO. Keys carried in an unpinned file are not trusted.
 * This proves original process termination only; a remote POST can still complete. */
export function readCancellationProcessFence(selected: CancellationObservationSelection): CancellationProcessFence {
    const path = '/etc/lunchlineup/trust/cancellation-observation-predecessor.json';
    requireEvidence(realpathSync(path) === path, 'Canonical predecessor evidence path required.');
    for (let current = path; ; current = dirname(current)) {
        const info = lstatSync(current);
        requireEvidence(info.uid === 0 && !(info.mode & 0o022) && !info.isSymbolicLink(), 'Root-controlled predecessor path required.');
        if (current === '/') break;
    }
    const info = lstatSync(path);
    requireEvidence(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 262144
        && !(info.mode & 0o007) && info.gid === process.getgid?.(), 'Private bounded predecessor evidence required.');
    const bytes = readFileSync(path);
    requireEvidence(createHash('sha256').update(bytes).digest('hex') === selected.recoveryEvidenceSha256,
        'Pinned predecessor bytes differ.');
    const input = JSON.parse(bytes.toString('utf8'));
    requireEvidence(bytes.toString('utf8') === `${canonicalHistory(input)}\n`, 'Canonical predecessor file required; duplicate fields refused.');
    closed(input, ['history', 'recovery', 'ownerPublicKey', 'recoveryPublicKey', 'originalPolicy']);
    requireEvidence(typeof input.history === 'string' && /^[\x00-\x7f]+$/.test(input.history)
        && input.history.endsWith('\n') && typeof input.ownerPublicKey === 'string'
        && typeof input.recoveryPublicKey === 'string', 'Exact ASCII history and original keys required.');
    requireEvidence(createHash('sha256').update(input.ownerPublicKey).digest('hex') === selected.originalOwnerKeySha256
        && createHash('sha256').update(input.recoveryPublicKey).digest('hex') === selected.originalRecoveryKeySha256,
        'Independently pinned original trust roots differ.');
    const owner = createPublicKey(input.ownerPublicKey); const recovery = createPublicKey(input.recoveryPublicKey);
    requireEvidence(owner.asymmetricKeyType === 'ed25519' && recovery.asymmetricKeyType === 'ed25519'
        && !owner.export({ format: 'der', type: 'spki' }).equals(recovery.export({ format: 'der', type: 'spki' })),
        'Distinct original owner/recovery keys required.');
    const verifyEnvelope = (envelope: any, key: typeof owner) => {
        closed(envelope, ['body', 'signature']);
        requireEvidence(typeof envelope.signature === 'string' && /^[a-f0-9]{128}$/.test(envelope.signature)
            && verify(null, Buffer.from(canonicalHistory(envelope.body)), key, Buffer.from(envelope.signature, 'hex')),
            'Original evidence signature differs.');
        return envelope.body;
    };
    const lines = input.history.slice(0, -1).split('\n') as string[];
    requireEvidence(lines.length >= 3 && lines.length <= 5, 'Original provider INTENT history required.');
    const rows: any[] = []; const hashes: string[] = [];
    let previous = '0'.repeat(64);
    for (const [sequence, line] of lines.entries()) {
        requireEvidence(line.length > 0 && line.length <= 17408, 'Original journal record bound exceeded.');
        const record = JSON.parse(line);
        closed(record, ['sequence', 'previous', 'kind', 'body']);
        requireEvidence(record.sequence === sequence && record.previous === previous && record.kind === 'PERSISTENT_EXPORT'
            && canonicalHistory(record) === line, 'Original canonical history chain differs.');
        previous = createHash('sha256').update(`${line}\n`).digest('hex'); hashes.push(previous);
        const row = verifyEnvelope(record.body, owner);
        closed(row, ['kind', 'session', 'scopeSha256', 'jobId', 'tenantId', 'body']);
        requireEvidence(row.jobId === selected.jobId && row.tenantId === selected.tenantId
            && typeof row.session === 'string' && /^[a-f0-9]{64}$/.test(row.session)
            && typeof row.scopeSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.scopeSha256)
            && (sequence === 0 || (row.session === rows[0].session && row.scopeSha256 === rows[0].scopeSha256)),
            'Original signed operation/scope differs.');
        rows.push(row);
    }
    requireEvidence(['OWNER,ADOPTED,INTENT', 'OWNER,ADOPTED,INTENT,READBACK', 'OWNER,ADOPTED,INTENT,READBACK,COMPLETE']
        .includes(rows.map(row => row.kind).join(',')) && hashes[2] === selected.providerIntentSha256,
        'Exact original provider INTENT membership required.');
    closed(rows[0].body, ['identity', 'policySha256']); closed(rows[1].body, ['app']);
    const identity = (value: any, unit: string) => {
        closed(value, ['pid', 'starttime', 'bootId', 'unit']);
        requireEvidence(Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.starttime === 'string'
            && /^[0-9]+$/.test(value.starttime) && value.bootId === readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
            && value.unit === unit, 'Same-boot original process identity required; cross-boot recovery is separate.');
    };
    identity(rows[0].body.identity, 'lunchlineup-persistent-export-owner.service');
    identity(rows[1].body.app, 'lunchlineup-persistent-export-consumer.service');
    const policy = input.originalPolicy;
    requireEvidence(policy && historyDigest(policy) === selected.originalPolicySha256
        && selected.originalPolicySha256 === rows[0].body.policySha256
        && typeof policy.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(policy.sourceSha)
        && policy.jobId === selected.jobId && policy.tenantId === selected.tenantId
        && policy.scopeSha256 === rows[0].scopeSha256 && policy.effect === 'apply-exact-customer-cancellation'
        && policy.ownerPublicKey?.sha256 === createHash('sha256').update(input.ownerPublicKey).digest('hex')
        && policy.recoveryPublicKey?.sha256 === createHash('sha256').update(input.recoveryPublicKey).digest('hex'),
        'Exact original signed policy/key bindings required.');
    // The preserved original environment is staged privately at this fixed path,
    // with its exact old bytes/hash. Never log, serialize, or copy its secrets into
    // the observation receipt. Rotation requires separate enrollment, not guessing.
    const environmentPath = '/etc/lunchlineup/trust/cancellation-observation-original-environment.json';
    requireEvidence(realpathSync(environmentPath) === environmentPath, 'Canonical original environment required.');
    const environmentInfo = lstatSync(environmentPath);
    requireEvidence(environmentInfo.isFile() && environmentInfo.uid === 0 && environmentInfo.nlink === 1
        && !(environmentInfo.mode & 0o027) && environmentInfo.gid === process.getgid?.()
        && environmentInfo.size > 0 && environmentInfo.size <= 16384, 'Private original environment required.');
    const environmentBytes = readFileSync(environmentPath);
    requireEvidence(createHash('sha256').update(environmentBytes).digest('hex') === policy.appEnvironment?.sha256,
        'Original owner environment bytes differ.');
    const environment = JSON.parse(environmentBytes.toString('utf8'));
    closed(environment, ['DATABASE_URL', 'PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'TENANT_EXPORT_PILOT_MODE',
        'STRIPE_SECRET_KEY', 'STRIPE_SELECTED_REQUEST_TIMEOUT_MS']);
    requireEvidence(Object.entries(environment).every(([key, value]) => typeof value === 'string'
        && value.length > 0 && process.env[key] === value), 'Original database/provider environment differs.');
    const intent = rows[2].body;
    closed(intent, ['app', 'effect', 'operationMs', 'predecessorIntentSha256', 'customerId', 'subscriptionId']);
    requireEvidence(intent.effect === 'apply-exact-customer-cancellation' && intent.operationMs === policy.operationMs
        && policy.predecessorIntentSha256 === selected.predecessorIntentSha256
        && policy.customerId === selected.customerId && policy.subscriptionId === selected.subscriptionId
        && intent.predecessorIntentSha256 === selected.predecessorIntentSha256
        && intent.customerId === selected.customerId && intent.subscriptionId === selected.subscriptionId
        && Number.isSafeInteger(intent.operationMs) && intent.operationMs >= 1000 && intent.operationMs <= 3600000
        && canonicalObservation(intent.app) === canonicalObservation(rows[1].body.app), 'Original provider authority differs.');
    if (rows[3]) {
        closed(rows[3].body, ['app', 'intentSha256', 'outcome', 'processed']);
        requireEvidence(rows[3].body.intentSha256 === hashes[2] && ['settled', 'unknown'].includes(rows[3].body.outcome)
            && typeof rows[3].body.processed === 'boolean'
            && canonicalObservation(rows[3].body.app) === canonicalObservation(intent.app), 'Original readback differs.');
    }
    if (rows[4]) {
        closed(rows[4].body, ['intentSha256']);
        requireEvidence(rows[4].body.intentSha256 === hashes[2] && rows[3].body.outcome === 'settled', 'Original completion differs.');
    }
    const fence = verifyEnvelope(input.recovery, recovery);
    closed(fence, ['kind', 'scopeSha256', 'jobId', 'ownerHistorySha256', 'lastOwnerEvent',
        'applicationProcessSettled', 'backendSettlementProved', 'outcome', 'retryAllowed']);
    const historySha256 = createHash('sha256').update(input.history).digest('hex');
    requireEvidence(fence.kind === 'RECOVERY_FENCE' && fence.scopeSha256 === rows[0].scopeSha256
        && fence.jobId === selected.jobId && fence.ownerHistorySha256 === historySha256
        && fence.lastOwnerEvent === rows[rows.length - 1].kind && fence.applicationProcessSettled === true
        && fence.backendSettlementProved === false && fence.outcome === 'requires-independent-reconciliation'
        && fence.retryAllowed === false, 'Exact process-only original recovery fence required.');
    return Object.freeze({ evidenceSha256: selected.recoveryEvidenceSha256, historySha256,
        recoveryFenceSha256: historyDigest(input.recovery), applicationProcessSettled: true,
        backendSettlementProved: false, retryAllowed: false });
}
