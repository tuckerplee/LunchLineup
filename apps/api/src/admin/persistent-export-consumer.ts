import { SchedulePublishedEmailService } from '../email-delivery/schedule-published-email.service';
import { NotificationOutboxProcessor } from '../notifications/notification-outbox.processor';
import { AvailabilityImportPublisher } from '../availability-imports/availability-imports.publisher';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:net';
import { TenantExportService } from './tenant-export.service';
import { ScheduleSolveOutboxPublisher } from '../schedules/schedule-solve-outbox.publisher';

const CONFIG = '/etc/lunchlineup/trust/persistent-export-consumer.json';
const SOCKET = '/run/lunchlineup-persistent-export/owner.sock';
type Effect = 'generate-exact-export' | 'publish-exact-schedule' | 'publish-exact-import' | 'reconcile-exact-import-acceptance' | 'persist-exact-notification' | 'fanout-exact-notification' | 'deliver-exact-notification-email';
const permits = new WeakMap<object, { service: object; effect: Effect; jobId: string; tenantId: string; expires: number; recipientId?: string; recipientEmailSha256?: string; intentSha256: string }>();
const providerPermits = new WeakMap<object, { service: object; owner: NotificationOutboxProcessor; jobId: string; recipientEmailSha256: string; expires: number }>();

/** Only the authenticated, sequence-bound consumer below can mint a permit. */
export function consumePersistentExportPermit(service: object, permit: object) {
    const value = permits.get(permit);
    permits.delete(permit);
    if (!value || value.service !== service || value.effect !== 'generate-exact-export' || performance.now() >= value.expires) {
        throw new Error('Persistent export permit is absent, consumed or expired.');
    }
    return { jobId: value.jobId, tenantId: value.tenantId };
}

export function consumePersistentSchedulePermit(service: object, permit: object) {
    const value = permits.get(permit);
    permits.delete(permit);
    if (!value || value.service !== service || value.effect !== 'publish-exact-schedule' || performance.now() >= value.expires) {
        throw new Error('Persistent schedule permit is absent, consumed or expired.');
    }
    return { jobId: value.jobId, tenantId: value.tenantId, expires: value.expires };
}

export function consumePersistentImportPermit(service: object, permit: object) {
    const value = permits.get(permit);
    permits.delete(permit);
    if (!value || value.service !== service || (value.effect !== 'publish-exact-import' && value.effect !== 'reconcile-exact-import-acceptance') || performance.now() >= value.expires) {
        throw new Error('Persistent import permit is absent, consumed or expired.');
    }
    return { jobId: value.jobId, tenantId: value.tenantId, expires: value.expires, effect: value.effect };
}

export function consumePersistentNotificationPermit(service: object, permit: object) {
    const value = permits.get(permit);
    permits.delete(permit);
    if (!value || value.service !== service
        || (value.effect !== 'persist-exact-notification' && value.effect !== 'fanout-exact-notification' && value.effect !== 'deliver-exact-notification-email')
        || typeof value.recipientId !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(value.recipientId)
        || performance.now() >= value.expires) throw new Error('Persistent notification permit is absent, consumed or expired.');
    return { jobId: value.jobId, tenantId: value.tenantId, recipientId: value.recipientId, expires: value.expires, effect: value.effect, recipientEmailSha256: value.recipientEmailSha256, intentSha256: value.intentSha256 };
}

export function consumePersistentEmailPermit(service: object, permit: object) {
    const value = providerPermits.get(permit);
    providerPermits.delete(permit);
    if (!value || value.service !== service || performance.now() >= value.expires) {
        throw new Error('Fixed email provider permit is absent, consumed or expired.');
    }
    return { jobId: value.jobId, recipientEmailSha256: value.recipientEmailSha256, expires: value.expires, owner: value.owner };
}

// Inspection selects only one fixed implementation. It does not mint authority.
export function selectedPersistentProducer(): Effect {
    protectedPath(CONFIG);
    const info = lstatSync(CONFIG);
    requireValue(info.isFile() && info.nlink === 1 && info.size <= 16384
        && !(info.mode & 0o007) && info.gid === process.getgid?.(), 'Private installed consumer configuration required.');
    const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const effect = config.effect ?? 'generate-exact-export';
    requireValue(effect === 'generate-exact-export' || effect === 'publish-exact-schedule' || effect === 'publish-exact-import' || effect === 'reconcile-exact-import-acceptance' || effect === 'persist-exact-notification' || effect === 'fanout-exact-notification' || effect === 'deliver-exact-notification-email', 'Fixed producer effect required.');
    return effect;
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const fields = value as Record<string, unknown>;
        return `{${Object.keys(fields).sort().map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`).join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    requireValue(typeof encoded === "string", "Unsupported canonical value.");
    return encoded;
}

function requireValue(ok: unknown, reason: string): asserts ok {
    if (!ok) throw new Error(reason);
}

function closed(value: any, keys: string[]): void {
    requireValue(value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join('\0') === keys.sort().join('\0'), 'Closed protocol fields required.');
}

function protectedPath(path: string): void {
    requireValue(realpathSync(path) === path, 'Noncanonical protected path.');
    let current = path;
    while (true) {
        const info = lstatSync(current);
        requireValue(info.uid === 0 && !(info.mode & 0o022) && !info.isSymbolicLink(), 'Path is not root controlled.');
        if (current === '/') break;
        current = dirname(current);
    }
}

export async function runPersistentExportConsumer(service: TenantExportService | ScheduleSolveOutboxPublisher | AvailabilityImportPublisher | NotificationOutboxProcessor): Promise<void> {
    requireValue(process.env.TENANT_EXPORT_PILOT_MODE === 'true', 'Dedicated consumer requires closed pilot startup.');
    protectedPath(CONFIG);
    const info = lstatSync(CONFIG);
    requireValue(info.isFile() && info.nlink === 1 && info.size <= 16384
        && !(info.mode & 0o007) && info.gid === process.getgid?.(), 'Private installed consumer configuration required.');
    const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
    closed(config, ['jobId', 'tenantId', 'scopeSha256', 'sourceSha', 'keyHex', 'operationMs', 'lossMs',
        ...(Object.prototype.hasOwnProperty.call(config, 'effect') ? ['effect'] : []),
        ...(['persist-exact-notification', 'fanout-exact-notification', 'deliver-exact-notification-email'].includes(config.effect) ? ['recipientId'] : []),
        ...(config.effect === 'deliver-exact-notification-email' ? ['recipientEmailSha256'] : [])]);
    config.effect ??= 'generate-exact-export';
    requireValue((config.effect === 'generate-exact-export' && service instanceof TenantExportService)
        || (config.effect === 'publish-exact-schedule' && service instanceof ScheduleSolveOutboxPublisher)
        || ((config.effect === 'publish-exact-import' || config.effect === 'reconcile-exact-import-acceptance')
            && service instanceof AvailabilityImportPublisher)
        || ((config.effect === 'persist-exact-notification' || config.effect === 'fanout-exact-notification' || config.effect === 'deliver-exact-notification-email')
            && service instanceof NotificationOutboxProcessor), 'Fixed producer implementation differs.');
    const recipientFields = ['persist-exact-notification', 'fanout-exact-notification', 'deliver-exact-notification-email'].includes(config.effect) ? ['recipientId'] : [];
    if (config.effect === 'deliver-exact-notification-email') {
        requireValue(typeof config.recipientEmailSha256 === 'string' && /^[a-f0-9]{64}$/.test(config.recipientEmailSha256), 'Exact email recipient digest required.');
        recipientFields.push('recipientEmailSha256');
    }
    for (const name of recipientFields) requireValue(typeof config[name] === 'string' && /^[\x20-\x7e]{1,128}$/.test(config[name]), 'Exact notification recipient required.');
    const fixedEmail = config.effect === 'deliver-exact-notification-email' && service instanceof NotificationOutboxProcessor
        ? service.persistentOwnerEmailService() : undefined;
    if (config.effect === 'deliver-exact-notification-email') requireValue(fixedEmail instanceof SchedulePublishedEmailService
        && process.env.SCHEDULE_PUBLISHED_EMAIL_ENABLED === 'true', 'Fixed enabled email provider required.');
    if (config.effect === 'fanout-exact-notification') requireValue(process.env.REDIS_URL, 'Explicit admitted Redis endpoint required.');
    for (const name of ['jobId', 'tenantId']) requireValue(typeof config[name] === 'string'
        && /^[\x20-\x7e]{1,128}$/.test(config[name]), 'Exact selected operation/tenant required.');
    if (config.effect === 'publish-exact-schedule' || config.effect === 'publish-exact-import') requireValue(process.env.RABBITMQ_URL
        && process.env.WORKER_QUEUE_NAME, 'Explicit installed broker and queue required.');
    requireValue(/^[a-f0-9]{64}$/.test(config.keyHex) && /^[a-f0-9]{64}$/.test(config.scopeSha256)
        && /^[a-f0-9]{40}$/.test(config.sourceSha), 'Pinned consumer identity required.');
    requireValue(Number.isSafeInteger(config.operationMs) && config.operationMs >= 1000 && config.operationMs <= 3600000
        && Number.isSafeInteger(config.lossMs) && config.lossMs >= 100 && config.lossMs <= 10000, 'Finite consumer limits required.');
    // The root-owned parent cannot be replaced by this nonroot service; socket itself is group writable for connect.
    protectedPath(dirname(SOCKET));
    const socketInfo = lstatSync(SOCKET);
    requireValue(socketInfo.isSocket() && socketInfo.uid === 0 && socketInfo.gid === process.getgid?.()
        && (socketInfo.mode & 0o777) === 0o660, 'Installed owner socket required.');
    const key = Buffer.from(config.keyHex, 'hex');
    const socket = connect(SOCKET);
    let buffer = ''; let session = ''; let incoming = 0; let generated = false; let stopped = false;
    let resultSent = false; let complete = false; let intentSha256 = ''; let settled = false; let owned: Promise<void> | undefined;
    let currentPermit: object | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const close = (reason: string) => {
        if (stopped) return;
        stopped = true;
        if (currentPermit) { permits.delete(currentPermit); providerPermits.delete(currentPermit); }
        clearTimeout(timer); if (operationTimer) clearTimeout(operationTimer);
        // Invoke synchronously before socket teardown or awaiting task settlement.
        const draining = service.closeAdmission();
        socket.destroy();
        void draining.catch(() => undefined);
        rejectDone(new Error(reason));
    };
    const signal = () => close('Persistent owner consumer stopped; reconciliation required.');
    process.once('SIGTERM', signal); process.once('SIGINT', signal);
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => close('Owner heartbeat lost.'), config.lossMs); };
    const send = (sequence: number, kind: string, body: object) => {
        const value = { session, sequence, kind, body };
        const mac = createHmac('sha256', key).update(canonical(value)).digest('hex');
        const wire = canonical({ value, mac }) + '\n';
        requireValue(Buffer.byteLength(wire) <= 16384 && !stopped, 'Closed or oversized consumer write.');
        socket.write(wire);
    };
    const handle = (line: string) => {
        const envelope = JSON.parse(line);
        requireValue(canonical(envelope) === line, 'Canonical owner frame required.');
        closed(envelope, ['value', 'mac']);
        closed(envelope.value, ['session', 'sequence', 'kind', 'body']);
        const value = envelope.value;
        requireValue(typeof envelope.mac === 'string' && /^[a-f0-9]{64}$/.test(envelope.mac), 'Owner MAC format.');
        const expected = createHmac('sha256', key).update(canonical(value)).digest();
        requireValue(timingSafeEqual(Buffer.from(envelope.mac, 'hex'), expected)
            && value.sequence === incoming && /^[a-f0-9]{64}$/.test(value.session), 'Owner authentication/sequence failed.');
        if (incoming === 0) {
            requireValue(value.kind === 'HELLO', 'Owner hello required.');
            closed(value.body, ['jobId', 'tenantId', 'scopeSha256', 'sourceSha', 'operationMs', 'lossMs', 'effect', ...recipientFields]);
            for (const name of Object.keys(value.body)) requireValue(value.body[name] === config[name], 'Owner selected scope differs.');
            service.assertPersistentOwnerReady();
            session = value.session;
            send(0, 'READY', { generation: 'closed', cleanup: 'closed' });
        } else {
            requireValue(value.session === session, 'Owner incarnation changed.');
            if (value.kind === 'GENERATE') {
                closed(value.body, ['intentSha256']);
                requireValue(!generated && incoming === 1 && /^[a-f0-9]{64}$/.test(value.body.intentSha256), 'One durable intent required.');
                generated = true; intentSha256 = value.body.intentSha256;
                const permit = Object.freeze({ nonce: randomUUID() });
                currentPermit = permit;
                const expires = performance.now() + config.operationMs;
                permits.set(permit, { service, effect: config.effect, jobId: config.jobId, tenantId: config.tenantId,
                    recipientId: config.recipientId, recipientEmailSha256: config.recipientEmailSha256, intentSha256, expires });
                if (fixedEmail && service instanceof NotificationOutboxProcessor) providerPermits.set(permit, { service: fixedEmail, owner: service, jobId: config.jobId,
                    recipientEmailSha256: config.recipientEmailSha256, expires });
                operationTimer = setTimeout(() => close('Original producer operation deadline exceeded.'), config.operationMs);
                owned = (async () => {
                    let outcome: 'settled' | 'unknown' = 'unknown'; let processed = false;
                    try {
                        processed = service instanceof TenantExportService
                            ? await service.runPersistentOwnerExport(permit)
                            : service instanceof ScheduleSolveOutboxPublisher
                                ? await service.runPersistentOwnerSchedule(permit)
                                : service instanceof AvailabilityImportPublisher
                                    ? await service.runPersistentOwnerImport(permit)
                                    : await service.runPersistentOwnerNotification(permit);
                        await service.closeAdmission();
                        outcome = 'settled';
                    } catch { /* Unresolved remains unknown; no replay or cleanup permission. */ }
                    if (!stopped) { settled = outcome === 'settled'; resultSent = true; send(1, 'RESULT', { outcome, processed }); }
                })();
            } else if (value.kind === 'PING') {
                closed(value.body, []);
                requireValue(generated && !complete, 'Unexpected heartbeat.');
            } else if (value.kind === 'COMMITTED') {
                closed(value.body, ['intentSha256']);
                requireValue(resultSent && generated && settled && value.body.intentSha256 === intentSha256, 'Commit differs or precedes local settlement.');
                complete = true; clearTimeout(timer); if (operationTimer) clearTimeout(operationTimer);
                resolveDone();
            } else throw new Error('Unsupported owner effect.');
        }
        incoming += 1;
        if (!complete) refresh();
    };
    refresh();
    socket.on('data', (chunk) => {
        try {
            requireValue([...chunk].every((byte) => byte <= 127), 'ASCII owner wire required.');
            buffer += chunk.toString('ascii');
            requireValue(Buffer.byteLength(buffer) <= 16384, 'Owner frame buffer bound.');
            while (buffer.includes('\n')) {
                const index = buffer.indexOf('\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
                handle(line);
            }
        } catch { close('Owner protocol rejected; reconciliation required.'); }
    });
    socket.on('error', () => close('Owner connection failed.'));
    socket.on('close', () => { if (!complete) close('Owner disconnected.'); });
    try { await done; if (owned) await owned; }
    finally {
        clearTimeout(timer); if (operationTimer) clearTimeout(operationTimer);
        process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal);
        socket.destroy(); key.fill(0);
        if (currentPermit) { permits.delete(currentPermit); providerPermits.delete(currentPermit); }
        await service.closeAdmission();
    }
}
