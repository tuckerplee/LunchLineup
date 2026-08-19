import { Prisma } from '@prisma/client';
import type { TenantTransaction } from './database';
import { ProblemError } from './problem';

export type BillableFeature = 'lunch_breaks' | 'scheduling' | 'time_cards';

export type FeatureEntitlement = {
  feature: BillableFeature;
  creditCost: number;
};

const DEFAULT_FEATURES: Record<string, readonly BillableFeature[]> = {
  FREE: [],
  STARTER: ['scheduling'],
  GROWTH: ['scheduling', 'lunch_breaks', 'time_cards'],
  ENTERPRISE: ['scheduling', 'lunch_breaks', 'time_cards'],
};

const INTERNAL_BETA_ENTITLEMENT_KEY = 'internal_beta_entitlement';
const INTERNAL_BETA_ORIGIN = 'https://beta.lunchlineup.com';
const INTERNAL_BETA_MAX_CREDITS = 1_000;

type InternalBetaSchedulingEntitlement = {
  grantId: string;
  auditId: string;
  creditTransactionId: string;
  creditsGranted: number;
  ledgerReason: string;
  reason: string;
  approvedAt: string;
  approvedByUserId: string;
  expiresAt: string;
};

function internalBetaRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.INTERNAL_BETA_ENTITLEMENTS_ENABLED?.trim().toLowerCase() !== 'true') return false;
  try {
    const origin = new URL(env.APP_ORIGIN ?? '');
    return origin.origin === INTERNAL_BETA_ORIGIN
      && origin.pathname === '/'
      && !origin.search
      && !origin.hash
      && !origin.username
      && !origin.password;
  } catch {
    return false;
  }
}

function boundedPrintable(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function activeInternalBetaGrant(
  value: Prisma.JsonValue | null | undefined,
  now: Date,
): InternalBetaSchedulingEntitlement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const grant = value as Record<string, unknown>;
  const approvedAt = typeof grant.approvedAt === 'string' ? new Date(grant.approvedAt) : null;
  const expiresAt = typeof grant.expiresAt === 'string' ? new Date(grant.expiresAt) : null;
  if (
    grant.version !== 1
    || grant.source !== 'internal_beta'
    || grant.status !== 'ACTIVE'
    || !Array.isArray(grant.features)
    || grant.features.length !== 1
    || grant.features[0] !== 'scheduling'
    || !boundedPrintable(grant.grantId, 255)
    || grant.auditId !== `${grant.grantId}-internal-beta-audit`
    || grant.creditTransactionId !== grant.grantId
    || !Number.isSafeInteger(grant.creditsGranted)
    || Number(grant.creditsGranted) < 1
    || Number(grant.creditsGranted) > INTERNAL_BETA_MAX_CREDITS
    || !boundedPrintable(grant.ledgerReason, 500)
    || !boundedPrintable(grant.reason, 240)
    || !boundedPrintable(grant.approvedByUserId, 255)
    || !approvedAt
    || !Number.isFinite(approvedAt.getTime())
    || approvedAt > now
    || !expiresAt
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt <= now
    || expiresAt <= approvedAt
  ) {
    return null;
  }
  return grant as unknown as InternalBetaSchedulingEntitlement;
}

async function hasActiveInternalBetaSchedulingEntitlement(
  transaction: TenantTransaction,
  tenantId: string,
  tenant: {
    planTier: string;
    status: string;
    trialEndsAt: Date | null;
  },
  setting: { value: Prisma.JsonValue } | null,
  now: Date,
): Promise<boolean> {
  if (!internalBetaRuntimeEnabled()) return false;
  const grant = activeInternalBetaGrant(setting?.value, now);
  if (
    !grant
    || planCode(tenant.planTier) === 'FREE'
    || tenant.status !== 'TRIAL'
    || !(tenant.trialEndsAt instanceof Date)
    || tenant.trialEndsAt <= now
    || new Date(grant.expiresAt) > tenant.trialEndsAt
  ) {
    return false;
  }
  const [credit, audit] = await Promise.all([
    transaction.creditTransaction.findUnique({
      where: { id: grant.creditTransactionId },
      select: {
        tenantId: true,
        amount: true,
        debtAmount: true,
        reason: true,
        balanceAfter: true,
        debtAfter: true,
      },
    }),
    transaction.auditLog.findUnique({
      where: { id: grant.auditId },
      select: {
        tenantId: true,
        action: true,
        resource: true,
        resourceId: true,
        newValue: true,
      },
    }),
  ]);
  const auditValue = audit?.newValue;
  const auditedGrant = auditValue
    && typeof auditValue === 'object'
    && !Array.isArray(auditValue)
    && auditValue.entitlement
    && typeof auditValue.entitlement === 'object'
    && !Array.isArray(auditValue.entitlement)
    ? auditValue.entitlement as Record<string, unknown>
    : null;
  return credit?.tenantId === tenantId
    && credit.amount === grant.creditsGranted
    && credit.debtAmount === 0
    && credit.reason === grant.ledgerReason
    && Number.isSafeInteger(credit.balanceAfter)
    && Number(credit.balanceAfter) >= 0
    && credit.debtAfter === 0
    && audit?.tenantId === tenantId
    && audit.action === 'INTERNAL_BETA_ENTITLEMENT_GRANTED'
    && audit.resource === 'TenantSetting'
    && audit.resourceId === grant.grantId
    && auditedGrant?.grantId === grant.grantId
    && auditedGrant.auditId === grant.auditId
    && auditedGrant.creditTransactionId === grant.creditTransactionId
    && auditedGrant.creditsGranted === grant.creditsGranted
    && auditedGrant.ledgerReason === grant.ledgerReason
    && auditedGrant.reason === grant.reason
    && auditedGrant.approvedAt === grant.approvedAt
    && auditedGrant.approvedByUserId === grant.approvedByUserId
    && auditedGrant.expiresAt === grant.expiresAt;
}

function featureDetail(feature: BillableFeature, billable: boolean): string {
  if (feature === 'time_cards') {
    return billable
      ? 'Clock-in requires an active paid subscription and enough separately purchased usage credits.'
      : 'Time cards require an active paid subscription.';
  }
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
    value === 'scheduling' || value === 'lunch_breaks' || value === 'time_cards'
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
 * Native API-v2 feature access and immutable credit settlement. This is a
 * database boundary shared by native domain modules; it never calls retained
 * billing HTTP routes.
 */
export async function assertFeatureEntitled(
  transaction: TenantTransaction,
  tenantId: string,
  feature: BillableFeature,
  billable: boolean,
): Promise<FeatureEntitlement | null> {
  await lockTenantForFeature(transaction, tenantId);
  const [tenant, setting, internalBetaSetting] = await Promise.all([
    transaction.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: {
        planTier: true,
        status: true,
        stripeSubscriptionId: true,
        stripeSubscriptionCurrentPeriodEnd: true,
        trialEndsAt: true,
        usageCredits: true,
        creditDebt: true,
      },
    }),
    transaction.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: 'feature_access' } },
      select: { value: true },
    }),
    internalBetaRuntimeEnabled()
      ? transaction.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: INTERNAL_BETA_ENTITLEMENT_KEY } },
        select: { value: true },
      })
      : Promise.resolve(null),
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

  const now = new Date();
  const activeSubscription = tenant.status === 'ACTIVE'
    && Boolean(tenant.stripeSubscriptionId?.trim())
    && tenant.stripeSubscriptionCurrentPeriodEnd instanceof Date
    && tenant.stripeSubscriptionCurrentPeriodEnd > now;
  const internalBetaActive = feature === 'scheduling'
    && await hasActiveInternalBetaSchedulingEntitlement(
      transaction,
      tenantId,
      tenant,
      internalBetaSetting,
      now,
    );
  if (!activeSubscription && !internalBetaActive) throw failure(feature, billable);

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

export async function lockTenantForFeature(transaction: TenantTransaction, tenantId: string): Promise<void> {
  await transaction.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
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
