import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  startingStatusForPlan,
  tenantProvisioningDescription,
} from '../../app/admin/tenants/tenant-provisioning-contract';

describe('tenant provisioning UI contract', () => {
  it('shows FREE as active without implying paid access', () => {
    expect(startingStatusForPlan('FREE')).toBe('ACTIVE');
    expect(tenantProvisioningDescription('FREE')).toMatch(/free-tier entitlements/i);
  });

  it.each(['STARTER', 'GROWTH', 'ENTERPRISE'] as const)(
    'forces %s provisioning through a bounded trial',
    (planTier) => {
      expect(startingStatusForPlan(planTier)).toBe('TRIAL');
      expect(tenantProvisioningDescription(planTier)).toMatch(/14 days by default/i);
      expect(tenantProvisioningDescription(planTier)).toMatch(/ACTIVE requires verified billing/i);
    },
  );

  it('wires the selected plan to its truthful starting status', () => {
    const source = readFileSync(resolve(__dirname, '../../app/admin/tenants/TenantsClient.tsx'), 'utf8');

    expect(source).toContain('status: startingStatusForPlan(planTier)');
    expect(source).toContain('tenantProvisioningDescription(createForm.planTier)');
    expect(source).toContain('Paid trial ends ${formatDateTime(result.trialEndsAt)}');
  });
});
