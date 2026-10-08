import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { ServiceUnavailableException } from '@nestjs/common';
import { MFA_MARKER_TTL_SCRIPT, isCurrentMfaObservation, observeMfaVerification } from '@lunchlineup/rbac';
import { AuthService } from '../auth/auth.service';
import { NativeIdentityAdapter, RedisMfaSessionStore } from '../../../api-v2/src/platform/native-identity';
import { loadConfig } from '../../../api-v2/src/config';

// Actual observers with controlled Redis commands; no network, Redis Lua,
// database, native admission or provider execution is qualified here.
const clients = vi.hoisted(() => [] as any[]);
vi.mock('ioredis', () => ({ default: vi.fn().mockImplementation(function RedisMock() {
    const client = { status: 'ready', on: vi.fn(), get: vi.fn(async () => '1'),
        eval: vi.fn(async () => 60_000), disconnect: vi.fn(), quit: vi.fn(async () => undefined),
        connect: vi.fn(async () => { client.status = 'ready'; }) };
    clients.push(client); return client;
}) }));
const ids = { sub: 'observer-user', tenantId: 'observer-tenant', sessionId: 'observer-session' };
const config = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'synthetic-test-key', LOG_LEVEL: 'silent',
    METRICS_TOKEN: 'synthetic-config-metrics-token-00000000000000000000', AUTH_STATE_TIMEOUT_MS: '250' });
beforeEach(() => { clients.length = 0; vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('process-local MFA observation', () => {
    it.each([-2, -1, 0, -10, '60000', null, undefined, NaN, Infinity, 0.5,
        Number.MAX_SAFE_INTEGER + 1, 1440 * 60_000 + 1001])('refuses invalid/unbounded PTTL %s', async ttl => {
        await expect(observeMfaVerification(ids, async () => ttl)).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('reads the exact marker with the atomic read-only script and preserves binding', async () => {
        const read = vi.fn(async () => 60_000);
        const observation = await observeMfaVerification(ids, read);
        expect(read).toHaveBeenCalledExactlyOnceWith(MFA_MARKER_TTL_SCRIPT, 'session_mfa:observer-session');
        expect(observation).toMatchObject(ids); expect(isCurrentMfaObservation(observation, ids)).toBe(true);
        for (const key of ['sub', 'tenantId', 'sessionId'] as const) {
            expect(isCurrentMfaObservation(observation, { ...ids, [key]: 'other' })).toBe(false);
        }
        expect(vi.getTimerCount()).toBe(0);
    });
    it('charges readiness/read latency against both deadlines', async () => {
        let monotonic = 100;
        vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
        const started = Date.now();
        const observation = await observeMfaVerification(ids, async () => {
            vi.setSystemTime(started + 50); monotonic += 50; return 100;
        });
        expect(observation).toEqual({ ...ids, expiresAtEpochMs: started + 100, expiresAtMonotonicMs: 200 });
        monotonic = 200; vi.setSystemTime(started - 3_600_000);
        expect(isCurrentMfaObservation(observation, ids)).toBe(false);
    });
    it('refuses verification exhausted during the read itself', async () => {
        await expect(observeMfaVerification(ids, async () => {
            vi.setSystemTime(Date.now() + 100); return 100;
        })).resolves.toBeNull();
    });
    it('accepts the supported maximum rounded policy lifetime', async () => {
        expect(await observeMfaVerification(ids, async () => 1440 * 60_000 + 1000)).not.toBeNull();
    });
    it.each([0, 249, 15_001, 500.5, NaN])('refuses invalid observation timeout %s before reading', async timeout => {
        const read = vi.fn(async () => 60_000);
        await expect(observeMfaVerification(ids, read, timeout)).rejects.toThrow('Invalid MFA observation timeout');
        expect(read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });
    it('settles a stalled observation at its bounded deadline and clears its timer', async () => {
        let settle!: (ttl: number) => void;
        const read = new Promise<number>(resolve => { settle = resolve; });
        const result = observeMfaVerification(ids, () => read, 250).then(value => ({ value }), error => ({ error }));
        await vi.advanceTimersByTimeAsync(250);
        expect(await result).toHaveProperty('error.message', 'MFA observation timed out');
        settle(60_000); await read; expect(vi.getTimerCount()).toBe(0);
        // Decision timeout does not claim cancellation of the underlying read.
    });
    it('clears its timer on reader rejection without exposing a proof', async () => {
        await expect(observeMfaVerification(ids, async () => { throw new Error('reader sentinel'); }))
            .rejects.toThrow('reader sentinel');
        expect(vi.getTimerCount()).toBe(0);
    });
});

function legacy() {
    return new AuthService({ get: (_key: string, fallback: string) => fallback } as never, {} as never, {} as never);
}
describe('lifecycle-owned MFA providers', () => {
    it('Nest reuses its managed client for observation and legacy verification, then disconnects it', async () => {
        const service = legacy();
        await expect(service.observeSessionMfa(ids)).resolves.toMatchObject(ids);
        const client = clients[0];
        expect(client.eval).toHaveBeenCalledExactlyOnceWith(MFA_MARKER_TTL_SCRIPT, 1, 'session_mfa:observer-session');
        await expect((service as any).isSessionMfaVerified(ids.sessionId)).resolves.toBe(true);
        expect(client.get).toHaveBeenCalledExactlyOnceWith('session_mfa:observer-session');
        expect(clients).toHaveLength(1); service.onModuleDestroy();
        expect(client.disconnect).toHaveBeenCalledExactlyOnceWith(false);
    });
    it.each(['wait', 'connecting', 'reconnecting', 'end'])('Nest refuses offline status %s before EVAL', async status => {
        const service = legacy(); const client = (service as any).getRedis(); client.status = status;
        await expect(service.observeSessionMfa(ids)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(client.eval).not.toHaveBeenCalled(); expect(clients).toHaveLength(1); service.onModuleDestroy();
    });
    it('Nest returns generic 503 for a rejected read', async () => {
        const service = legacy(); const client = (service as any).getRedis();
        client.eval.mockRejectedValueOnce(new Error('private redis credentials sentinel'));
        await expect(service.observeSessionMfa(ids)).rejects.toMatchObject({ message: 'MFA verification is temporarily unavailable' });
        service.onModuleDestroy();
    });
    it('Nest bounds stalled reads at five seconds', async () => {
        const service = legacy(); const client = (service as any).getRedis();
        let settle!: (value: number) => void;
        const read = new Promise<number>(resolve => { settle = resolve; }); client.eval.mockReturnValueOnce(read);
        const outcome = service.observeSessionMfa(ids).catch(error => error);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await outcome).toBeInstanceOf(ServiceUnavailableException);
        settle(60_000); await read; expect(vi.getTimerCount()).toBe(0); service.onModuleDestroy();
    });
    it('native Redis observation reuses the store used by legacy isVerified and close', async () => {
        const store = new RedisMfaSessionStore(config); const client = clients[0];
        await expect(store.observeSessionMfa(ids)).resolves.toMatchObject(ids);
        await expect(store.isVerified(ids.sessionId)).resolves.toBe(true);
        expect(client.eval).toHaveBeenCalledExactlyOnceWith(MFA_MARKER_TTL_SCRIPT, 1, 'session_mfa:observer-session');
        expect(client.get).toHaveBeenCalledExactlyOnceWith('session_mfa:observer-session');
        expect(clients).toHaveLength(1); await store.close(); expect(client.quit).toHaveBeenCalledOnce();
    });
    it('native readiness time consumes verification lifetime', async () => {
        const store = new RedisMfaSessionStore(config); const client = clients[0]; client.status = 'wait';
        client.connect.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 60_000); client.status = 'ready'; });
        await expect(store.observeSessionMfa(ids)).resolves.toBeNull();
        expect(client.connect).toHaveBeenCalledOnce(); await store.close();
    });
    it('native observation bounds stalled readiness and issues no EVAL afterward', async () => {
        const store = new RedisMfaSessionStore(config); const client = clients[0]; client.status = 'wait';
        // A terminal connection rejection after the decision deadline avoids a
        // deferred EVAL; the timeout itself does not cancel underlying I/O.
        let reject!: (error: Error) => void;
        const connect = new Promise<void>((_resolve, fail) => { reject = fail; }); client.connect.mockReturnValueOnce(connect);
        const outcome = store.observeSessionMfa(ids).catch(error => error);
        await vi.advanceTimersByTimeAsync(250);
        expect(await outcome).toHaveProperty('message', 'MFA observation timed out');
        reject(new Error('readiness failed')); await connect.catch(() => undefined);
        await Promise.resolve(); expect(client.eval).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
        await store.close();
    });
    it('native adapter delegates the exact identity to the existing store without database work', async () => {
        const database = { withTenant: vi.fn() };
        const observation = { ...ids, expiresAtEpochMs: Date.now() + 60_000, expiresAtMonotonicMs: performance.now() + 60_000 };
        const store = { isVerified: vi.fn(), observeSessionMfa: vi.fn(async () => observation), close: vi.fn() };
        const adapter = new NativeIdentityAdapter(config, database as never, store);
        await expect(adapter.observeSessionMfa(ids)).resolves.toBe(observation);
        expect(store.observeSessionMfa).toHaveBeenCalledExactlyOnceWith(ids);
        expect(database.withTenant).not.toHaveBeenCalled(); expect(store.isVerified).not.toHaveBeenCalled();
        await adapter.close(); expect(store.close).toHaveBeenCalledOnce(); expect(clients).toHaveLength(0);
    });
    it.each(['missing', 'rejected'] as const)('native adapter refuses %s observation capability with generic 503', async kind => {
        const store = { isVerified: vi.fn(), ...(kind === 'rejected' ? {
            observeSessionMfa: vi.fn(async () => { throw new Error('private store sentinel'); }),
        } : {}) };
        const adapter = new NativeIdentityAdapter(config, { withTenant: vi.fn() } as never, store);
        await expect(adapter.observeSessionMfa(ids)).rejects.toMatchObject({ status: 503, code: 'identity_service_unavailable' });
        expect(store.isVerified).not.toHaveBeenCalled(); expect(clients).toHaveLength(0);
    });
});
