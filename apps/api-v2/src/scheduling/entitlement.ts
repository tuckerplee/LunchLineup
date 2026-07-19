import type { Prisma } from '@prisma/client';
import type { TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';

const DEFAULT_SCHEDULING_PLANS = new Set(['STARTER', 'GROWTH', 'ENTERPRISE']);

type FeatureOverride = {
  source?: string;
  enabled?: boolean;
  reason?: string;
};

function schedulingIncluded(metadata: Prisma.JsonValue | null, planCode: string): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('features' in metadata)) {
    return DEFAULT_SCHEDULING_PLANS.has(planCode);
  }
  const features = (metadata as Record<string, unknown>).features;
  return Array.isArray(features) && features.includes('scheduling');
}

function schedulingOverride(value: Prisma.JsonValue | null | undefined): FeatureOverride | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const features = (value as Record<string, unknown>).features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return null;
  const scheduling = (features as Record<string, unknown>).scheduling;
  if (!scheduling || typeof scheduling !== 'object' || Array.isArray(scheduling)) return null;
  return scheduling as FeatureOverride;
}

export async function assertSchedulingEntitled(
  transaction: TenantTransaction,
  tenantId: string,
  now = new Date(),
): Promise<void> {
  await transaction.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
  const [tenant, setting] = await Promise.all([
    transaction.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: {
        planTier: true,
        status: true,
        stripeSubscriptionId: true,
        stripeSubscriptionCurrentPeriodEnd: true,
      },
    }),
    transaction.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: 'feature_access' } },
      select: { value: true },
    }),
  ]);
  if (!tenant) {
    throw new ProblemError(403, 'tenant_unavailable', 'The current workspace is unavailable.', 'Forbidden');
  }

  const override = schedulingOverride(setting?.value);
  if (override?.source === 'disabled' || override?.enabled === false) {
    throw new ProblemError(
      403,
      'scheduling_not_entitled',
      override.reason?.slice(0, 240) || 'Scheduling is disabled for this workspace.',
      'Scheduling unavailable',
    );
  }
  const paidThrough = tenant.stripeSubscriptionCurrentPeriodEnd;
  const activeSubscription = tenant.status === 'ACTIVE'
    && Boolean(tenant.stripeSubscriptionId?.trim())
    && paidThrough instanceof Date
    && paidThrough > now;
  if (!activeSubscription) {
    throw new ProblemError(
      403,
      'scheduling_not_entitled',
      'Scheduling requires a current active paid subscription.',
      'Scheduling unavailable',
    );
  }

  const planCode = String(tenant.planTier).toUpperCase();
  const plan = await transaction.planDefinition.findUnique({
    where: { code: planCode },
    select: { metadata: true },
  });
  const overrideEnabled = override?.enabled === true
    && ['manual', 'stripe', 'credits'].includes(String(override.source));
  if (!schedulingIncluded(plan?.metadata ?? null, planCode) && !overrideEnabled) {
    throw new ProblemError(
      403,
      'scheduling_not_entitled',
      'The active subscription does not include scheduling.',
      'Scheduling unavailable',
    );
  }
}

export async function lockSchedulingAggregate(transaction: TenantTransaction, tenantId: string): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:scheduling:${tenantId}`}, 0))
  `;
}
