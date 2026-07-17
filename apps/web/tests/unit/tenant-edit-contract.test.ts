import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildTenantCreatePayload,
  buildTenantEditPayload,
  TENANT_CREATE_CREDIT_GUIDANCE,
  TENANT_CREDIT_EDIT_GUIDANCE,
  TENANT_PLAN_EDIT_GUIDANCE,
  TENANT_STATUS_EDIT_GUIDANCE,
} from '../../app/admin/tenants/tenant-edit-contract';

const FORBIDDEN_CREDIT_FIELDS = [
  'usageCredits',
  'creditQuotaLimit',
  'creditsLimit',
] as const;

describe('generic tenant edit contract', () => {
  it('only emits tenant creation fields and excludes balances and quotas', () => {
    const payload = buildTenantCreatePayload({
      name: 'Acme Dining',
      slug: 'acme-dining',
      planTier: 'GROWTH',
      status: 'TRIAL',
      ownerName: 'Alex Owner',
      ownerEmail: 'owner@example.com',
      usageCredits: 25,
      creditQuotaLimit: 100,
      creditsLimit: null,
    } as Parameters<typeof buildTenantCreatePayload>[0] & {
      usageCredits: number;
      creditQuotaLimit: number;
      creditsLimit: null;
    });

    expect(payload).toEqual({
      name: 'Acme Dining',
      slug: 'acme-dining',
      planTier: 'GROWTH',
      status: 'TRIAL',
      ownerName: 'Alex Owner',
      ownerEmail: 'owner@example.com',
    });

    for (const field of FORBIDDEN_CREDIT_FIELDS) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('only emits generic profile fields and excludes plans, balances, and quotas', () => {
    const payload = buildTenantEditPayload({
      name: 'Acme Dining',
      slug: 'acme-dining',
      usageCredits: 25,
      creditQuotaLimit: 100,
      creditsLimit: null,
      planTier: 'ENTERPRISE',
      status: 'ACTIVE',
    } as Parameters<typeof buildTenantEditPayload>[0] & {
      usageCredits: number;
      creditQuotaLimit: number;
      creditsLimit: null;
      planTier: string;
      status: string;
    });

    expect(payload).toEqual({
      name: 'Acme Dining',
      slug: 'acme-dining',
    });
    for (const field of FORBIDDEN_CREDIT_FIELDS) {
      expect(payload).not.toHaveProperty(field);
    }
    expect(payload).not.toHaveProperty('planTier');
    expect(payload).not.toHaveProperty('status');
  });


  it('directs plan, status, and credit changes to coordinated dedicated workflows', () => {
    expect(TENANT_PLAN_EDIT_GUIDANCE).toMatch(/billing workflow/i);
    expect(TENANT_PLAN_EDIT_GUIDANCE).toMatch(/Stripe/i);
    expect(TENANT_STATUS_EDIT_GUIDANCE).toMatch(/dedicated lifecycle actions/i);
    expect(TENANT_CREATE_CREDIT_GUIDANCE).toMatch(/does not grant credits/i);
    expect(TENANT_CREATE_CREDIT_GUIDANCE).toMatch(/Admin Credits/i);
    expect(TENANT_CREDIT_EDIT_GUIDANCE).toMatch(/read-only/i);
    expect(TENANT_CREDIT_EDIT_GUIDANCE).toMatch(/Admin Credits/i);
    expect(TENANT_CREDIT_EDIT_GUIDANCE).toMatch(/subscriptions and credits are separate/i);
    expect(TENANT_CREDIT_EDIT_GUIDANCE).toMatch(/never include recurring or unlimited credits/i);
  });

  it('wires create and edit forms to safe payloads and read-only wallet management', () => {
    const source = readFileSync(resolve(__dirname, '../../app/admin/tenants/TenantsClient.tsx'), 'utf8');

    expect(source).toContain('buildTenantCreatePayload({');
    expect(source).toContain('buildTenantEditPayload({');
    expect(source).not.toContain('usageCredits: credits');
    expect(source).not.toContain('createForm.usageCredits');
    expect(source).not.toContain('editForm.usageCredits');
    expect(source).not.toContain('creditQuotaLimit');
    expect(source).not.toContain('creditsLimit');
    expect(source).not.toContain('planTier: editForm.planTier');
    expect(source).toContain('value={tenantToEdit.planTier}');
    expect(source).toContain('value={tenantToEdit.status}');
    expect(source).toContain('<output');
    expect(source).toContain('{tenantToEdit.usageCredits.toLocaleString()} credits');
    expect(source.slice(
      source.indexOf('<span className="form-label">Wallet balance</span>'),
      source.indexOf('href="/admin/credits"'),
    )).not.toContain('<input');
    expect(source).toContain('href="/admin/credits"');
    expect(source).toContain('{TENANT_CREATE_CREDIT_GUIDANCE}');
    expect(source).toContain('{TENANT_CREDIT_EDIT_GUIDANCE}');
    expect(source).toContain('{TENANT_PLAN_EDIT_GUIDANCE}');
    expect(source).toContain('{TENANT_STATUS_EDIT_GUIDANCE}');
  });
});
