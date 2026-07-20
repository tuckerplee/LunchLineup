import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';

export type BillableFeature = 'lunch_breaks' | 'scheduling';

export type FeatureEntitlement = {
  feature: BillableFeature;
  creditCost: number;
};

const DEFAULT_FEATURES: Record<string, readonly BillableFeature[]> = {
  FREE: [],
  STARTER: ['scheduling'],
  GROWTH: ['scheduling', 'lunch_breaks'],
  ENTERPRISE: ['scheduling', 'lunch_breaks'],
};

function featureDetail(feature: BillableFeature, billable: boolean): string {
  if (billable) {
    return feature === 'scheduling'
      ? 'Setup shifts require an active paid subscription and enough separately purchased usage credits.'
      : 'Lunch and break changes require an active paid subscription and enough separately purchased usage credits.';
  }
  return feature === 'scheduling'
    ? 'Scheduling requires an active paid subscription.'
    : 'Lunch and break planning requires an active paid subscription.';
}

function failure(feature: BillableFeature, billable: boolean): ProblemError {
  return new ProblemError(
    403,
    `${feature}_not_entitled`,
    featureDetail(feature, billable),
    'Feature unavailable',
  );
}

function planCode(value: string): keyof typeof DEFAULT_FEATURES {
  const normalized = value.trim().toUpperCase();
  return normalized in DEFAULT_FEATURES ? normalized as keyof typeof DEFAULT_FEATURES : 'FREE';
}

function planFeatures(metadata: Prisma.JsonValue | null, fallback: keyof typeof DEFAULT_FEATURES): readonly BillableFeature[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return DEFAULT_FEATURES[fallback];
  const values = (metadata as Record<string, unknown>).features;
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is BillableFeature => (
    value === 'scheduling' || value === 'lunch_breaks'
  )))];
}

function overrideFor(value: Prisma.JsonValue | null, feature: BillableFeature): {
  source?: string;
  enabled?: boolean;
  reason?: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const features = (value as Record<string, unknown>).features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return null;
  const override = (features as Record<string, unknown>)[feature];
  return override && typeof override === 'object' && !Array.isArray(override)
    ? override as { source?: string; enabled?: boolean; reason?: string }
    : null;
}

/**
 * API-v2 owns the authorization and credit settlement decision for native
 * Operations writes. It is intentionally separate from the retained billing
 * HTTP surface, but preserves the same immutable CreditTransaction ledger.
 */
export async function assertFeatureEntitled(
  transaction: TenantTransaction,
  tenantId: string,
  feature: BillableFeature,
  billable: boolean,
): Promise<FeatureEntitlement | null> {
  await lockTenantForScheduling(transaction, tenantId);
  const [tenant, setting] = await Promise.all([
    transaction.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: {
        planTier: true,
        status: true,
        stripeSubscriptionId: true,
        stripeSubscriptionCurrentPeriodEnd: true,
        usageCredits: true,
        creditDebt: true,
      },
    }),
    transaction.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: 'feature_access' } },
      select: { value: true },
    }),
  ]);
  if (!tenant) throw failure(feature, billable);

  const override = overrideFor(setting?.value ?? null, feature);
  if (override?.source === 'disabled' || override?.enabled === false) {
    throw new ProblemError(
      403,
      `${feature}_not_entitled`,
      typeof override.reason === 'string' && override.reason.trim()
        ? override.reason.trim().slice(0, 240)
        : featureDetail(feature, billable),
      'Feature unavailable',
    );
  }

  const activeSubscription = tenant.status === 'ACTIVE'
    && Boolean(tenant.stripeSubscriptionId?.trim())
    && tenant.stripeSubscriptionCurrentPeriodEnd instanceof Date
    && tenant.stripeSubscriptionCurrentPeriodEnd > new Date();
  if (!activeSubscription) throw failure(feature, billable);

  const code = planCode(tenant.planTier);
  const plan = await transaction.planDefinition.findUnique({
    where: { code },
    select: { metadata: true },
  });
  const overrideEnabled = override?.enabled === true
    && ['manual', 'stripe', 'credits'].includes(String(override.source));
  if (!overrideEnabled && !planFeatures(plan?.metadata ?? null, code).includes(feature)) {
    throw failure(feature, billable);
  }
  if (!billable) return null;
  if (!Number.isSafeInteger(tenant.creditDebt) || tenant.creditDebt !== 0) throw failure(feature, true);
  if (!Number.isSafeInteger(tenant.usageCredits) || tenant.usageCredits < 1) throw failure(feature, true);
  return { feature, creditCost: 1 };
}

export async function lockTenantForScheduling(transaction: TenantTransaction, tenantId: string): Promise<void> {
  await transaction.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
}

export async function lockSchedulingAggregate(transaction: TenantTransaction, tenantId: string): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:scheduling:${tenantId}`}, 0))
  `;
}

export async function debitFeatureCredit(
  transaction: TenantTransaction,
  args: {
    tenantId: string;
    entitlement: FeatureEntitlement;
    operationId: string;
    reason: string;
    transactionId?: string;
  },
): Promise<{ consumedCredits: number; newBalance: number }> {
  const transactionId = args.transactionId ?? `feature-usage-${args.operationId}`;
  await transaction.$executeRaw`LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE`;
  await transaction.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${args.tenantId} FOR UPDATE`;
  const existing = await transaction.creditTransaction.findUnique({
    where: { id: transactionId },
    select: { tenantId: true, amount: true, debtAmount: true, reason: true, balanceAfter: true, debtAfter: true },
  });
  if (existing) {
    if (
      existing.tenantId !== args.tenantId
      || existing.amount !== -args.entitlement.creditCost
      || existing.debtAmount !== 0
      || existing.reason !== args.reason
      || !Number.isSafeInteger(existing.balanceAfter)
      || Number(existing.balanceAfter) < 0
      || existing.debtAfter !== 0
    ) {
      throw new ProblemError(409, 'credit_settlement_conflict', 'The saved credit settlement does not match this operation.', 'Conflict');
    }
    return { consumedCredits: args.entitlement.creditCost, newBalance: Number(existing.balanceAfter) };
  }

  const debit = await transaction.tenant.updateMany({
    where: {
      id: args.tenantId,
      creditDebt: 0,
      usageCredits: { gte: args.entitlement.creditCost },
    },
    data: { usageCredits: { decrement: args.entitlement.creditCost } },
  });
  if (debit.count !== 1) throw failure(args.entitlement.feature, true);
  const tenant = await transaction.tenant.findUniqueOrThrow({
    where: { id: args.tenantId },
    select: { usageCredits: true, creditDebt: true },
  });
  if (!Number.isSafeInteger(tenant.usageCredits) || tenant.usageCredits < 0 || tenant.creditDebt !== 0) {
    throw new ProblemError(409, 'credit_settlement_conflict', 'Credit settlement produced an invalid wallet balance.', 'Conflict');
  }
  await transaction.creditTransaction.create({
    data: {
      id: transactionId,
      tenantId: args.tenantId,
      amount: -args.entitlement.creditCost,
      debtAmount: 0,
      reason: args.reason,
      balanceAfter: tenant.usageCredits,
      debtAfter: tenant.creditDebt,
    },
  });
  return { consumedCredits: args.entitlement.creditCost, newBalance: tenant.usageCredits };
}
