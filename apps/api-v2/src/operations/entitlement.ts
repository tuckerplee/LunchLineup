export {
  assertFeatureEntitled,
  debitFeatureCredit,
  lockTenantForFeature as lockTenantForScheduling,
  type BillableFeature,
  type FeatureEntitlement,
} from '../platform/feature-entitlement';

import type { TenantTransaction } from '../platform/database';

export async function lockSchedulingAggregate(transaction: TenantTransaction, tenantId: string): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:scheduling:${tenantId}`}, 0))
  `;
}
