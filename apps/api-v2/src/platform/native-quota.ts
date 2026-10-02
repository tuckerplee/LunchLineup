import { createHash } from 'node:crypto';
import { resolveRateLimits } from '@lunchlineup/config';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { FastifyReply } from 'fastify';
import type { TenantDatabase } from './database';
import { NATIVE_QUOTA_OWNERS, type NativeQuotaOperation } from './native-quota-owners';
import type { NativeQuotaStorage } from './native-quota-storage';
import { ProblemError } from './problem';

type PlanTier = Parameters<typeof resolveRateLimits>[0];
type PlanSnapshot = {
  planTier: string | null;
  status: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionCurrentPeriodEnd: Date | string | null;
};

const WINDOW_MS = 60_000;
const TENANT_MULTIPLIER = 10;
// Explicit interactive transaction budgets; these are not a claim that
// Fastify's requestTimeout cancels application work or Redis transports.
const PLAN_MAX_WAIT_MS = 500;
const PLAN_TRANSACTION_TIMEOUT_MS = 1500;

export type NativeQuotaAdapter = {
  ready(): Promise<void>;
  consume(operation: NativeQuotaOperation, identity: SessionIdentity, reply: FastifyReply): Promise<void>;
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function nativeQuotaKey(operation: NativeQuotaOperation, tenantId: string, subject: string, bucket: 'default' | 'tenantCeiling'): string {
  const owner = NATIVE_QUOTA_OWNERS[operation];
  const tracker = 'sha256:' + digest(bucket === 'default'
    ? 'api-principal:' + tenantId.trim() + ':' + subject.trim()
    : 'api-tenant:' + tenantId.trim());
  // This is the installed retained Nest ThrottlerGuard key protocol.
  return digest(owner.className + '-' + owner.handlerName + '-' + bucket + '-' + tracker);
}

export function nativeRateLimitPlan(snapshot: PlanSnapshot, now: Date): PlanTier {
  let plan: PlanTier;
  switch ((snapshot.planTier ?? '').trim().toUpperCase()) {
    case 'STARTER':
    case 'BASIC': plan = 'starter'; break;
    case 'GROWTH':
    case 'PRO': plan = 'growth'; break;
    case 'ENTERPRISE': plan = 'enterprise'; break;
    default: return 'free';
  }
  const paidThrough = snapshot.stripeSubscriptionCurrentPeriodEnd;
  const paidThroughEpoch = paidThrough instanceof Date
    ? paidThrough.getTime()
    : typeof paidThrough === 'string' ? new Date(paidThrough).getTime() : Number.NaN;
  return (snapshot.status ?? '').trim().toUpperCase() === 'ACTIVE'
    && Boolean(snapshot.stripeSubscriptionId?.trim())
    && Number.isFinite(paidThroughEpoch)
    && paidThroughEpoch > now.getTime()
    ? plan : 'free';
}

export class NativePlanQuota implements NativeQuotaAdapter {
  constructor(private readonly database: TenantDatabase, private readonly storage: NativeQuotaStorage) {}

  ready(): Promise<void> {
    return this.storage.ready();
  }

  async consume(operation: NativeQuotaOperation, identity: SessionIdentity, reply: FastifyReply): Promise<void> {
    const tenantId = identity.tenantId.trim();
    const subject = identity.sub.trim();
    if (!tenantId || !subject) {
      throw new ProblemError(401, 'invalid_session', 'A valid application session is required.', 'Unauthorized');
    }
    let snapshot: PlanSnapshot | null;
    try {
      snapshot = await this.database.withTenant(tenantId, (transaction) => transaction.tenant.findUnique({
        where: { id: tenantId },
        select: {
          planTier: true,
          status: true,
          stripeSubscriptionId: true,
          stripeSubscriptionCurrentPeriodEnd: true,
        },
      }), { maxWait: PLAN_MAX_WAIT_MS, timeout: PLAN_TRANSACTION_TIMEOUT_MS });
    } catch {
      // Do not log database/provider messages or silently guess a paid budget.
      throw new ProblemError(503, 'rate_limit_plan_unavailable', 'Request limits are temporarily unavailable.', 'Service unavailable');
    }
    if (!snapshot) {
      throw new ProblemError(503, 'rate_limit_plan_unavailable', 'Request limits are temporarily unavailable.', 'Service unavailable');
    }
    // No cache: a fresh tenant snapshot is evaluated after the lookup.
    const limit = resolveRateLimits(nativeRateLimitPlan(snapshot, new Date())).apiReqPerMin;
    await this.consumeBucket(operation, tenantId, subject, reply, 'default', limit);
    await this.consumeBucket(operation, tenantId, subject, reply, 'tenantCeiling', limit * TENANT_MULTIPLIER);
  }

  private async consumeBucket(operation: NativeQuotaOperation, tenantId: string, subject: string, reply: FastifyReply, bucket: 'default' | 'tenantCeiling', limit: number): Promise<void> {
    const key = nativeQuotaKey(operation, tenantId, subject, bucket);
    const result = await this.storage.increment(key, WINDOW_MS, limit, WINDOW_MS, bucket);
    const suffix = bucket === 'default' ? '' : '-' + bucket;
    reply.header('X-RateLimit-Limit' + suffix, limit);
    reply.header('X-RateLimit-Remaining' + suffix, Math.max(0, limit - result.totalHits));
    reply.header('X-RateLimit-Reset' + suffix, result.timeToExpire);
    if (result.isBlocked) {
      const retryAfterSeconds = Math.max(1, result.timeToBlockExpire);
      reply.header('Retry-After', retryAfterSeconds);
      if (suffix) reply.header('Retry-After' + suffix, retryAfterSeconds);
      throw new ProblemError(429, 'rate_limited', 'Too many requests. Try again later.', 'Too many requests', undefined, undefined, { retryAfterSeconds });
    }
  }
}
