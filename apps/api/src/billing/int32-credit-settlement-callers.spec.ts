import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { PlanTier, Prisma, TenantStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalBetaEntitlementService } from '../admin/internal-beta-entitlement.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { BillingController } from './billing.controller';
import { MeteringService } from './metering.service';
import { StripeCreditPurchaseService } from './stripe-credit-purchase.service';
import { StripeService } from './stripe.service';

const M = 2_147_483_647;
const CAPACITY_MESSAGE = 'Credit amount exceeds the available wallet capacity. Refresh balances and enter a smaller amount.';
const TENANT = 'tenant-capacity';
const NOW = new Date('2026-08-18T12:00:00.000Z');
const CONTEXT = 'synthetic-unit-platform-context';
const originalContext = process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;
beforeEach(() => { process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET = CONTEXT; });
afterEach(() => {
    if (originalContext === undefined) delete process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;
    else process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET = originalContext;
    vi.clearAllMocks();
});

type Row = Record<string, any>;
type State = { tenant: Row; credits: Row[]; billing: Row[]; settings: Row[]; audits: Row[] };
const copy = <T,>(value: T): T => structuredClone(value);
function pick(row: Row | null, select?: Record<string, boolean>): Row | null {
    if (row === null) return null;
    if (!select) return copy(row);
    for (const [key, enabled] of Object.entries(select)) {
        if (enabled !== true || !(key in row)) throw new Error(`Unmodeled projection ${key}`);
    }
    return Object.fromEntries(Object.keys(select).map(key => [key, copy(row[key])]));
}

// Finite staged transaction model, not PostgreSQL. Writes remain private until
// the real owner's callback resolves. Rejections discard every staged row.
// No database bounds are simulated: the real Metering guard must refuse overflow.
function stagedModel(wallet: number, debt = 0, beta = false) {
    let committed: State = {
        tenant: { id: TENANT, usageCredits: wallet, creditDebt: debt, planTier: PlanTier.STARTER,
            status: beta ? TenantStatus.TRIAL : TenantStatus.ACTIVE, deletedAt: null,
            trialEndsAt: new Date('2026-09-01T00:00:00.000Z'), stripeCustomerId: 'cus_capacity',
            stripeSubscriptionId: 'sub_capacity', stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z') },
        credits: [], billing: [], settings: [], audits: [],
    };
    let staged: State | null = null;
    const attempts: { outcome: 'committed' | 'rolledback'; state: State; error?: unknown }[] = [];
    let failLedger: Error | null = null;
    let failAudit: Error | null = null;
    const active = (): State => {
        if (!staged) throw new Error('Model access outside transaction');
        return staged;
    };
    const byId = (rows: Row[], args: Row): Row | null => {
        if (Object.keys(args.where).join(',') !== 'id' || typeof args.where.id !== 'string') {
            throw new Error('Unmodeled unique selector');
        }
        return pick(rows.find(row => row.id === args.where.id) ?? null, args.select);
    };
    const insert = (rows: Row[], args: Row): Row => {
        if (args.data.tenantId !== TENANT || typeof args.data.id !== 'string') throw new Error('Foreign insert');
        if (rows.some(row => row.id === args.data.id)) throw { code: 'P2002' };
        const row = copy({ ...args.data, createdAt: NOW });
        rows.push(row);
        return pick(row, args.select)!;
    };
    const tx = {
        $executeRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
            active();
            const text = sql.join('?').replace(/\s+/g, ' ').trim();
            const allowed = (text === 'SELECT set_current_tenant(?)' && values.length === 1 && values[0] === TENANT)
                || (text === 'SELECT set_current_platform_admin(true, ?)' && values.length === 1 && values[0] === CONTEXT)
                || (text === 'LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE' && values.length === 0)
                || (text === 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))' && values.length === 1 && values[0] === `billing-checkout:${TENANT}`);
            if (!allowed) throw new Error(`Unmodeled transaction command ${text}`);
            return 1;
        }),
        $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
            const text = sql.join('?').replace(/\s+/g, ' ').trim();
            if (text !== 'SELECT "id" FROM "Tenant" WHERE "id" = ? FOR UPDATE' || values.length !== 1 || values[0] !== TENANT) {
                throw new Error(`Unmodeled row lock ${text}`);
            }
            return [{ id: active().tenant.id }];
        }),
        tenant: {
            findUnique: vi.fn(async (args: Row) => {
                if (JSON.stringify(args.where) !== JSON.stringify({ id: TENANT })) throw new Error('Foreign tenant read');
                return pick(active().tenant, args.select);
            }),
            findUniqueOrThrow: vi.fn(async (args: Row) => {
                if (JSON.stringify(args.where) !== JSON.stringify({ id: TENANT })) throw new Error('Foreign wallet read');
                return pick(active().tenant, args.select)!;
            }),
            update: vi.fn(async (args: Row) => {
                if (JSON.stringify(args.where) !== JSON.stringify({ id: TENANT })
                    || JSON.stringify(Object.keys(args.data).sort()) !== JSON.stringify(['creditDebt', 'usageCredits'])) {
                    throw new Error('Unmodeled wallet mutation');
                }
                const state = active();
                state.tenant.usageCredits += args.data.usageCredits.increment;
                state.tenant.creditDebt -= args.data.creditDebt.decrement;
                return pick(state.tenant, args.select)!;
            }),
        },
        creditTransaction: {
            findUnique: vi.fn(async (args: Row) => byId(active().credits, args)),
            create: vi.fn(async (args: Row) => {
                if (failLedger) { const error = failLedger; failLedger = null; throw error; }
                return insert(active().credits, args);
            }),
        },
        billingEvent: {
            findUnique: vi.fn(async (args: Row) => byId(active().billing, args)),
            findFirst: vi.fn(async (args: Row) => {
                if (JSON.stringify(args.where) !== JSON.stringify({ tenantId: TENANT,
                    metadata: { path: ['checkoutSessionId'], equals: 'cs_capacity' } })
                    || JSON.stringify(args.orderBy) !== JSON.stringify({ createdAt: 'asc' })) {
                    throw new Error('Unmodeled legacy billing lookup');
                }
                return pick(active().billing.find(row => row.metadata?.checkoutSessionId === 'cs_capacity') ?? null, args.select);
            }),
            create: vi.fn(async (args: Row) => insert(active().billing, args)),
        },
        tenantSetting: {
            findUnique: vi.fn(async (args: Row) => {
                if (JSON.stringify(args.where) !== JSON.stringify({ tenantId_key: { tenantId: TENANT, key: 'internal_beta_entitlement' } })) {
                    throw new Error('Unmodeled entitlement read');
                }
                return pick(active().settings[0] ?? null, args.select);
            }),
            upsert: vi.fn(async (args: Row) => {
                if (JSON.stringify(args.where) !== JSON.stringify({ tenantId_key: { tenantId: TENANT, key: 'internal_beta_entitlement' } })) {
                    throw new Error('Unmodeled entitlement write');
                }
                const rows = active().settings;
                if (rows.length) rows[0] = { ...rows[0], ...copy(args.update) };
                else rows.push(copy(args.create));
                return copy(rows[0]);
            }),
        },
        auditLog: {
            findUnique: vi.fn(async (args: Row) => byId(active().audits, args)),
            create: vi.fn(async (args: Row) => {
                if (failAudit) { const error = failAudit; failAudit = null; throw error; }
                return insert(active().audits, args);
            }),
        },
        planDefinition: {
            findUnique: vi.fn(async (args: Row) => {
                active();
                if (JSON.stringify(args) !== JSON.stringify({ where: { code: 'STARTER' } })) throw new Error('Unmodeled plan lookup');
                return null;
            }),
        },
    };
    let tail = Promise.resolve();
    const prisma = {
        $transaction: vi.fn((operation: (transaction: typeof tx) => Promise<unknown>, _options?: unknown) => {
            const result = tail.then(async () => {
                if (staged) throw new Error('Overlapping modeled transaction');
                staged = copy(committed);
                try {
                    const value = await operation(tx);
                    committed = copy(staged);
                    attempts.push({ outcome: 'committed', state: copy(staged) });
                    return value;
                } catch (error) {
                    attempts.push({ outcome: 'rolledback', state: copy(staged), error });
                    throw error;
                } finally { staged = null; }
            });
            tail = result.then(() => undefined, () => undefined);
            return result;
        }),
    };
    const db = new TenantPrismaService(prisma as never);
    const metering = new MeteringService(db);
    return { db, metering, tx, prisma, attempts, read: () => copy(committed),
        failNextLedger: (error: Error) => { failLedger = error; },
        failNextAudit: (error: Error) => { failAudit = error; },
        setCurrentBalances: (walletValue: number, debtValue: number) => {
            if (staged) throw new Error('Cannot mutate committed state during modeled transaction');
            committed.tenant.usageCredits = walletValue;
            committed.tenant.creditDebt = debtValue;
        },
    };
}

function purchaseHarness(wallet: number, debt = 0) {
    const h = stagedModel(wallet, debt);
    const config = { get: vi.fn((key: string): string | undefined => ({
        STRIPE_SECRET_KEY: 'sk_test_unit_capacity', STRIPE_WEBHOOK_SECRET: 'whsec_unit_capacity',
        STRIPE_PRICE_STARTER: 'price_plan_starter', STRIPE_PRICE_CREDIT_PACK_100: 'price_credit_100',
    } as Record<string, string>)[key]) };
    const session = { id: 'cs_capacity', mode: 'payment', status: 'complete', payment_status: 'paid',
        payment_intent: 'pi_capacity', customer: 'cus_capacity', client_reference_id: TENANT,
        amount_subtotal: 1200, amount_total: 1200, currency: 'usd',
        metadata: { purchaseType: 'credit_pack', tenantId: TENANT, creditPackCode: 'CREDITS_100',
            creditAmount: '100', priceId: 'price_credit_100', unitAmount: '1200', currency: 'usd', quantity: '1' } };
    const event = { id: 'evt_capacity', type: 'checkout.session.completed', data: { object: session } };
    const stripe = {
        checkout: { sessions: {
            retrieve: vi.fn(async (id: string) => { expect(id).toBe(session.id); return copy(session); }),
            listLineItems: vi.fn(async (id: string) => { expect(id).toBe(session.id); return { data: [{
                id: 'li_capacity', price: { id: 'price_credit_100' }, quantity: 1,
                amount_subtotal: 1200, amount_total: 1200, currency: 'usd' }], has_more: false }; }),
        } },
        prices: { retrieve: vi.fn(async (id: string) => {
            expect(id).toBe('price_credit_100');
            return { id, active: true, type: 'one_time', unit_amount: 1200, currency: 'usd' };
        }) },
        subscriptions: { retrieve: vi.fn(async (id: string) => {
            expect(id).toBe('sub_capacity');
            return { id, status: 'active', customer: 'cus_capacity', metadata: { tenantId: TENANT },
                items: { data: [{ price: { id: 'price_plan_starter' } }] } };
        }) },
        webhooks: { constructEvent: vi.fn((raw: Buffer, signature: string, secret: string) => {
            expect(raw).toEqual(Buffer.from('synthetic paid checkout bytes'));
            expect(signature).toBe('synthetic-signature');
            expect(secret).toBe('whsec_unit_capacity');
            return copy(event);
        }) },
        refunds: { create: vi.fn(() => { throw new Error('Unexpected provider refund'); }) },
    };
    const purchase = new StripeCreditPurchaseService(config as never, h.db, h.metering);
    const dispatcher = new StripeService(config as never, h.db, purchase);
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    Object.assign(purchase, { stripe, logger });
    Object.assign(dispatcher, { stripe, logger });
    const controller = new BillingController(dispatcher, {} as never, {} as never);
    return { ...h, purchase, dispatcher, controller, stripe, event,
        callWebhook: () => controller.handleStripeWebhook({ rawBody: Buffer.from('synthetic paid checkout bytes') } as never, 'synthetic-signature') };
}

function betaHarness(wallet: number) {
    const h = stagedModel(wallet, 0, true);
    const config = { get: vi.fn((key: string): string | undefined => ({
        INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true', APP_ORIGIN: 'https://beta.lunchlineup.com',
    } as Record<string, string>)[key]) };
    const rbac = { authorizePlatformAdminTenantMutationInTransaction: vi.fn(async (tx: unknown, tenant: string, actor: unknown) => {
        expect(tx).toBe(h.tx); expect(tenant).toBe(TENANT); expect(actor).toEqual(ACTOR);
    }) };
    const service = new InternalBetaEntitlementService(config as never, h.metering, h.db, rbac as never, () => new Date(NOW));
    return { ...h, rbac, service, grant: () => service.grant(TENANT, BETA_INPUT, 'capacity-beta', ACTOR) };
}
const ACTOR = { userId: 'admin-unit', tenantId: 'platform-unit', sessionId: 'session-unit', ipAddress: null, userAgent: 'unit' };
const BETA_INPUT = { credits: 25, expiresAt: '2026-08-25T12:00:00.000Z', reason: 'Capacity pilot' };
function expectCapacity(error: unknown) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    expect((error as Error).message).toBe(CAPACITY_MESSAGE);
}

describe('Int32 settlement shared callers (staged unit model)', () => {
    it.each([
        { label: 'last100walletcredits', wallet: M - 100, debt: 0, spendable: 100, repaid: 0, debtAfter: 0 },
        { label: 'fullwalletdebtonly', wallet: M, debt: 150, spendable: 0, repaid: 100, debtAfter: 50 },
    ])('commits a paid purchase at the boundary $label', async ({ wallet, debt, spendable, repaid, debtAfter }) => {
        const h = purchaseHarness(wallet, debt);
        await expect(h.purchase.handleCheckoutSessionCompleted(h.event as never)).resolves.toEqual({
            transactionId: 'stripe-credit-purchase-cs_capacity', newBalance: M, replayed: false });
        expect(h.read().tenant).toMatchObject({ usageCredits: M, creditDebt: debtAfter });
        expect(h.read().credits).toEqual([expect.objectContaining({ amount: spendable, debtAmount: repaid ? -repaid : 0,
            balanceAfter: M, debtAfter, reason: 'Stripe credit pack purchase CREDITS_100' })]);
        expect(h.read().billing).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ outcomeState: 'complete', disposition: 'applied' }) })]);
        expect(h.read().settings).toEqual([]); expect(h.read().audits).toEqual([]);
        expect(h.attempts.map(row => row.outcome)).toEqual(['committed']);
    });

    it('rolls back a staged paid BillingEvent when the locked wallet rejects capacity', async () => {
        const h = purchaseHarness(M - 99);
        const before = h.read();
        const error = await h.purchase.handleCheckoutSessionCompleted(h.event as never).catch((value: unknown) => value);
        expectCapacity(error);
        expect(h.read()).toEqual(before);
        expect(h.attempts.map(row => row.outcome)).toEqual(['rolledback']);
        expect(h.attempts[0].state.billing).toHaveLength(1);
        expect(h.attempts[0].state.billing[0].metadata).toMatchObject({ outcomeState: 'complete', disposition: 'applied' });
        expect(h.tx.tenant.update).not.toHaveBeenCalled(); expect(h.tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    });

    it('rolls back staged wallet debt and BillingEvent when paid ledger insertion fails', async () => {
        const h = purchaseHarness(M - 60, 40); const before = h.read(); const failure = new Error('unit ledger write failure');
        h.failNextLedger(failure);
        await expect(h.purchase.handleCheckoutSessionCompleted(h.event as never)).rejects.toBe(failure);
        expect(h.read()).toEqual(before);
        expect(h.attempts[0]).toMatchObject({ outcome: 'rolledback', error: failure });
        expect(h.attempts[0].state.tenant).toMatchObject({ usageCredits: M, creditDebt: 0 });
        expect(h.attempts[0].state.billing).toHaveLength(1); expect(h.attempts[0].state.credits).toEqual([]);
        expect(h.tx.tenant.update).toHaveBeenCalledOnce(); expect(h.stripe.refunds.create).not.toHaveBeenCalled();
    });

    it('replays the paid immutable result after later wallet and debt changes without a fresh capacity read', async () => {
        const h = purchaseHarness(10, 40);
        const first = await h.purchase.handleCheckoutSessionCompleted(h.event as never);
        h.setCurrentBalances(M, 0); const before = h.read();
        h.tx.tenant.findUniqueOrThrow.mockClear();
        await expect(h.purchase.handleCheckoutSessionCompleted({ ...h.event, id: 'evt_capacity_replay' } as never)).resolves.toEqual({ ...first, replayed: true });
        expect(first).toMatchObject({ newBalance: 70, replayed: false });
        expect(h.read()).toEqual(before);
        expect(h.tx.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
        expect(h.tx.tenant.update).toHaveBeenCalledOnce(); expect(h.tx.creditTransaction.create).toHaveBeenCalledOnce();
        expect(h.tx.billingEvent.create).toHaveBeenCalledOnce();
    });

    it('propagates the same native400 through real paid dispatcher and webhook without a received acknowledgement', async () => {
        const h = purchaseHarness(M - 99); const before = h.read();
        const error = await h.callWebhook().catch((value: unknown) => value);
        expectCapacity(error);
        expect(h.attempts[0].error).toBe(error);
        expect(h.stripe.webhooks.constructEvent).toHaveBeenCalledOnce();
        expect(h.stripe.checkout.sessions.retrieve).toHaveBeenCalledOnce();
        expect(h.read()).toEqual(before); expect(h.attempts[0].outcome).toBe('rolledback');
        expect(h.prisma.$transaction).toHaveBeenCalledOnce();
    });

    it('acknowledges the paid webhook only after the real owner commits its exact boundary settlement', async () => {
        const h = purchaseHarness(M - 100);
        await expect(h.callWebhook()).resolves.toEqual({ received: true });
        expect(h.read().tenant).toMatchObject({ usageCredits: M, creditDebt: 0 });
        expect(h.read().credits).toHaveLength(1); expect(h.read().billing).toHaveLength(1);
        expect(h.attempts.map(row => row.outcome)).toEqual(['committed']);
    });

    it('commits and replays an exact beta boundary grant without regranting or republishing its entitlement', async () => {
        const h = betaHarness(M - 25);
        const first = await h.grant(); const firstState = h.read();
        expect(first).toMatchObject({ newBalance: M, creditsGranted: 25 });
        expect(firstState.credits).toHaveLength(1); expect(firstState.settings).toHaveLength(1); expect(firstState.audits).toHaveLength(1);
        expect(firstState.audits[0]).toMatchObject({ actorUserId: ACTOR.userId, actorTenantId: ACTOR.tenantId,
            action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED', newValue: { response: first } });
        h.setCurrentBalances(M, 5); const before = h.read();
        await expect(h.grant()).resolves.toEqual(first);
        expect(h.read()).toEqual(before);
        expect(h.tx.tenant.update).toHaveBeenCalledOnce(); expect(h.tx.tenantSetting.upsert).toHaveBeenCalledOnce();
        expect(h.tx.auditLog.create).toHaveBeenCalledOnce();
        expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    });

    it('refuses beta capacity before entitlement audit or wallet publication without an automatic retry', async () => {
        const h = betaHarness(M - 24); const before = h.read();
        const error = await h.grant().catch((value: unknown) => value);
        expectCapacity(error); expect(h.read()).toEqual(before);
        expect(h.prisma.$transaction).toHaveBeenCalledOnce();
        expect(h.rbac.authorizePlatformAdminTenantMutationInTransaction).toHaveBeenCalledOnce();
        expect(h.tx.tenant.update).not.toHaveBeenCalled(); expect(h.tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(h.tx.tenantSetting.upsert).not.toHaveBeenCalled(); expect(h.tx.auditLog.create).not.toHaveBeenCalled();
        expect(h.attempts.map(row => row.outcome)).toEqual(['rolledback']);
    });

    it('rolls back beta wallet ledger and entitlement when the later attributed audit fails', async () => {
        const h = betaHarness(M - 25); const before = h.read(); const failure = new Error('unit audit failure');
        h.failNextAudit(failure);
        await expect(h.grant()).rejects.toBe(failure);
        expect(h.read()).toEqual(before);
        expect(h.attempts[0]).toMatchObject({ outcome: 'rolledback', error: failure });
        expect(h.attempts[0].state.tenant.usageCredits).toBe(M);
        expect(h.attempts[0].state.credits).toHaveLength(1); expect(h.attempts[0].state.settings).toHaveLength(1);
        expect(h.attempts[0].state.audits).toEqual([]);
        expect(h.prisma.$transaction).toHaveBeenCalledOnce();
    });
});
