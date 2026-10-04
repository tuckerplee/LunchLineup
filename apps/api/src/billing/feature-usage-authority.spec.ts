import { performance } from 'node:perf_hooks';
import { ForbiddenException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertCurrentMutationPolicy, captureCurrentMutationPolicy } from '../auth/current-mutation';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { FeatureAccessService } from './feature-access.service';
import { MeteringService } from './metering.service';

// Actual FeatureAccess -> Metering -> current-policy guard propagation, with
// closed selectors and staged wallet/ledger commit or rollback. The outer
// payroll authorizer owns actor locks; this isolated fixture does not qualify
// grants, PostgreSQL locks/RLS, Redis, Stripe or whole payroll authorization.
const actor = { userId: 'nested-actor', tenantId: 'nested-tenant', sessionId: 'nested-session' };
const epoch = Date.parse('2026-10-04T20:00:00Z');
const cost = 2;
type Boundary = 'table-lock' | 'tenant-lock' | 'receipt-read' | 'wallet-effect' | 'wallet-read' | 'ledger-effect';
type Lifetime = 'stored' | 'effective' | 'mfa-wall' | 'mfa-monotonic';
const boundaries: Boundary[] = ['table-lock', 'tenant-lock', 'receipt-read', 'wallet-effect', 'wallet-read', 'ledger-effect'];
const lifetimes: Lifetime[] = ['stored', 'effective', 'mfa-wall', 'mfa-monotonic'];
type Ledger = { id: string; tenantId: string; amount: number; debtAmount: number; reason: string; balanceAfter: number; debtAfter: number };
const copy = <T>(value: T): T => structuredClone(value);

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(epoch); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(lifetime: Lifetime = 'stored', expiredAt?: Boundary, replay = false) {
    let monotonic = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const transactionId = 'feature-usage-nested-operation';
    const saved: Ledger = { id: transactionId, tenantId: actor.tenantId, amount: -cost, debtAmount: 0,
        reason: 'Nested payroll export', balanceAfter: 18, debtAfter: 0 };
    let state = { wallet: { id: actor.tenantId, usageCredits: replay ? 9 : 20, creditDebt: 0 },
        foreign: { id: 'foreign-tenant', usageCredits: 77, creditDebt: 0 }, ledger: replay ? [saved] : [] as Ledger[] };
    let draft = copy(state), active = false;
    const attempts: string[] = [], committed: string[] = [], reached: Boundary[] = [];
    const session = { id: actor.sessionId, userId: actor.userId,
        createdAt: new Date(epoch - (lifetime === 'effective' ? 4 * 60_000 : 0)),
        expiresAt: new Date(epoch + (lifetime === 'stored' ? 1_000 : 3_600_000)), revokedAt: null };
    const observation = { sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId,
        expiresAtEpochMs: epoch + (lifetime === 'mfa-wall' ? 1_000 : 3_600_000),
        expiresAtMonotonicMs: monotonic + (lifetime === 'mfa-monotonic' ? 1_000 : 3_600_000) };
    function boundary(name: Boundary) {
        reached.push(name);
        if (name !== expiredAt) return;
        if (lifetime === 'mfa-monotonic') monotonic += 1_000;
        else vi.setSystemTime(epoch + (lifetime === 'effective' ? 60_000 : 1_000));
    }
    const tx: any = {
        $executeRaw: async (parts: TemplateStringsArray) => {
            expect(parts.join('')).toMatch(/LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE/);
            boundary('table-lock'); return 1;
        },
        $queryRaw: async (parts: TemplateStringsArray, tenantId: string) => {
            expect(parts.join('')).toMatch(/SELECT "id" FROM "Tenant" WHERE "id" = .* FOR UPDATE/);
            expect(tenantId).toBe(actor.tenantId); boundary('tenant-lock'); return [{ id: actor.tenantId }];
        },
        tenant: {
            findUnique: async ({ where }: any) => { expect(where).toEqual({ id: actor.tenantId });
                return { id: actor.tenantId, status: 'ACTIVE', deletedAt: null }; },
            updateMany: async (args: any) => {
                expect(args).toEqual({ where: { id: actor.tenantId, creditDebt: 0, usageCredits: { gte: cost } },
                    data: { usageCredits: { decrement: cost } } });
                expect(active).toBe(true); attempts.push('wallet'); draft.wallet.usageCredits -= cost;
                boundary('wallet-effect'); return { count: 1 };
            },
            findUniqueOrThrow: async (args: any) => {
                expect(args).toEqual({ where: { id: actor.tenantId }, select: { usageCredits: true, creditDebt: true } });
                boundary('wallet-read'); return copy(draft.wallet);
            },
        },
        user: { findFirst: async ({ where }: any) => {
            expect(where).toEqual({ id: actor.userId, tenantId: actor.tenantId, deletedAt: null, suspendedAt: null });
            return { id: actor.userId, tenantId: actor.tenantId, pinResetRequired: false, mfaEnabled: true,
                lockedUntil: null, pinLockedUntil: null };
        } },
        session: { findFirst: async ({ where }: any) => {
            expect(where).toEqual({ id: actor.sessionId, userId: actor.userId }); return copy(session);
        } },
        tenantSetting: { findUnique: async ({ where }: any) => {
            expect(where).toEqual({ tenantId_key: { tenantId: actor.tenantId, key: 'workspace_settings' } });
            return { value: { security: { sessionTimeoutMinutes: lifetime === 'effective' ? 5 : 480 } } };
        } },
        creditTransaction: {
            findUnique: async (args: any) => {
                expect(args).toEqual({ where: { id: transactionId }, select: {
                    id: true, tenantId: true, amount: true, debtAmount: true, reason: true, balanceAfter: true, debtAfter: true } });
                boundary('receipt-read'); return copy(draft.ledger.find(row => row.id === transactionId) ?? null);
            },
            create: async (args: any) => {
                expect(args.data).toEqual(saved); expect(active).toBe(true);
                attempts.push('ledger'); draft.ledger.push(copy(args.data)); boundary('ledger-effect'); return copy(args.data);
            },
        },
    };
    const database: any = { $transaction: async (operation: (transaction: any) => Promise<any>) => {
        expect(active).toBe(false); active = true; draft = copy(state); const first = attempts.length;
        try { const result = await operation(tx); state = draft; committed.push(...attempts.slice(first)); return result; }
        finally { active = false; }
    } };
    const tenantDb = new TenantPrismaService(database);
    const metering = new MeteringService(tenantDb);
    const access = new FeatureAccessService(metering, tenantDb);
    const run = async (explicit = false) => database.$transaction(async () => {
        const policy = await captureCurrentMutationPolicy(tx, actor, ['payroll:export']);
        const assertCurrent = () => assertCurrentMutationPolicy(policy, observation);
        assertCurrent();
        // Seventh append-only seam: original FeatureAccess and Metering ignore
        // this capability. No outer post-settlement guard can mask a missing
        // nested effect guard in these propagation tests.
        return (access.recordFeatureUsageInTransaction as any).call(access, tx, actor.tenantId,
            { enabled: true, source: 'credits', creditCost: cost, reason: 'controlled' },
            saved.reason, 'nested-operation', explicit ? transactionId : undefined, assertCurrent);
    });
    return { run, attempts, committed, reached, get state() { return state; }, get active() { return active; } };
}

describe('actual nested feature debit current authority propagation', () => {
    for (const explicit of [false, true]) {
        it(`commits the current-authority wallet and immutable debit through ${explicit ? 'explicit transaction identity' : 'feature usage'}`, async () => {
            const f = fixture(); await expect(f.run(explicit)).resolves.toEqual({ consumedCredits: cost, newBalance: 18 });
            expect(f.reached).toEqual(boundaries); expect(f.attempts).toEqual(['wallet', 'ledger']);
            expect(f.committed).toEqual(f.attempts); expect(f.state.foreign.usageCredits).toBe(77); expect(f.active).toBe(false);
        });
    }
    it('replays the original debit balance after later wallet changes with no debit or ledger write', async () => {
        const f = fixture('stored', undefined, true);
        await expect(f.run()).resolves.toEqual({ consumedCredits: cost, newBalance: 18 });
        expect(f.state.wallet.usageCredits).toBe(9); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]);
    });
    for (const lifetime of lifetimes) {
        for (const gate of boundaries) {
            it(`refuses ${lifetime} expiry at ${gate} and rolls back the exact attempted prefix`, async () => {
                const f = fixture(lifetime, gate); const original = copy(f.state);
                await expect(f.run()).rejects.toBeInstanceOf(ForbiddenException);
                const prefix = gate === 'ledger-effect' ? ['wallet', 'ledger']
                    : ['wallet-effect', 'wallet-read'].includes(gate) ? ['wallet'] : [];
                expect(f.attempts).toEqual(prefix); expect(f.committed).toEqual([]);
                expect(f.state).toEqual(original); expect(f.active).toBe(false);
                expect(f.reached.at(-1)).toBe(gate);
            });
        }
        it(`refuses ${lifetime} expiry on a saved debit receipt read without returning old settlement`, async () => {
            const f = fixture(lifetime, 'receipt-read', true); const original = copy(f.state);
            await expect(f.run()).rejects.toBeInstanceOf(ForbiddenException);
            expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.state).toEqual(original); expect(f.active).toBe(false);
        });
    }
});
