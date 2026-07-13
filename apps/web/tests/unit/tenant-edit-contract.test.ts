import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildTenantEditPayload,
  TENANT_PLAN_EDIT_GUIDANCE,
  TENANT_STATUS_EDIT_GUIDANCE,
} from '../../app/admin/tenants/tenant-edit-contract';

describe('generic tenant edit contract', () => {
  it('only emits generic profile and credit fields', () => {
    const payload = buildTenantEditPayload({
      name: 'Acme Dining',
      slug: 'acme-dining',
      usageCredits: 25,
      planTier: 'ENTERPRISE',
      status: 'ACTIVE',
    } as Parameters<typeof buildTenantEditPayload>[0] & {
      planTier: string;
      status: string;
    });

    expect(payload).toEqual({
      name: 'Acme Dining',
      slug: 'acme-dining',
      usageCredits: 25,
    });
    expect(payload).not.toHaveProperty('planTier');
    expect(payload).not.toHaveProperty('status');
  });

  it('directs plan and status changes to coordinated dedicated workflows', () => {
    expect(TENANT_PLAN_EDIT_GUIDANCE).toMatch(/billing workflow/i);
    expect(TENANT_PLAN_EDIT_GUIDANCE).toMatch(/Stripe/i);
    expect(TENANT_STATUS_EDIT_GUIDANCE).toMatch(/dedicated lifecycle actions/i);
  });

  it('wires the generic edit form to the safe payload and read-only entitlement fields', () => {
    const source = readFileSync(resolve(__dirname, '../../app/admin/tenants/TenantsClient.tsx'), 'utf8');

    expect(source).toContain('buildTenantEditPayload({');
    expect(source).not.toContain('planTier: editForm.planTier');
    expect(source).toContain('value={tenantToEdit.planTier}');
    expect(source).toContain('value={tenantToEdit.status}');
    expect(source.match(/readOnly/g)).toHaveLength(3);
    expect(source).toContain('{TENANT_PLAN_EDIT_GUIDANCE}');
    expect(source).toContain('{TENANT_STATUS_EDIT_GUIDANCE}');
  });
});
