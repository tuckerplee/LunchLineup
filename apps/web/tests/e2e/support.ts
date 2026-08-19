import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

export const repoRoot = path.resolve(process.cwd(), '../..');
export const runFullStack = process.env.E2E_FULL_STACK === '1';
export const e2eTenantSlug = process.env.E2E_TENANT_SLUG ?? 'e2e-operations';
export const e2eAdminUsername = process.env.E2E_ADMIN_USERNAME ?? 'e2e.admin';
export const e2eAdminPin = process.env.E2E_ADMIN_PIN ?? '246810';
export const e2eManagerUsername = process.env.E2E_MANAGER_USERNAME ?? 'e2e.manager';
export const e2eManagerPin = process.env.E2E_MANAGER_PIN ?? '112233';
export const e2eSuperAdminUsername = process.env.E2E_SUPER_ADMIN_USERNAME ?? 'e2e.superadmin';
export const e2eSuperAdminPin = process.env.E2E_SUPER_ADMIN_PIN ?? '864200';
export const e2eAdminMfaSecret = process.env.E2E_ADMIN_MFA_SECRET ?? 'JBSWY3DPEHPK3PXP';
export const e2eSuperAdminMfaSecret = process.env.E2E_SUPER_ADMIN_MFA_SECRET ?? 'JBSWY3DPEHPK3PXP';

export function seedTenant() {
  const seedCommand = process.env.E2E_SEED_COMMAND;
  if (!seedCommand) {
    throw new Error('E2E_SEED_COMMAND is required when E2E_FULL_STACK=1.');
  }
  execSync(seedCommand, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
}

export function dayWindow(date = new Date(), days = 1): { startDate: string; endDate: string } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + days);
  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeBase32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = secret.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('E2E MFA secret is not valid base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(value % 1_000_000).padStart(6, '0');
}

export async function loginWithPin(
  page: Page,
  options: {
    username: string;
    pin: string;
    next?: string;
    expectedPath?: string;
  },
) {
  const next = options.next ?? '/dashboard/staff';
  const expectedPath = options.expectedPath ?? next;

  await page.goto(`/auth/login?tenantSlug=${encodeURIComponent(e2eTenantSlug)}&next=${encodeURIComponent(next)}`);
  await page.getByLabel('Work email or username').fill(options.username);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: /Enter your (?:PIN|password)/i })).toBeVisible();
  const passwordStep = page.getByPlaceholder('Enter password');
  if (await passwordStep.isVisible()) {
    // Account-blind resolution intentionally selects the migrated-password
    // compatibility step for usernames. PIN-only E2E fixtures are accepted
    // by the password endpoint as a numeric credential, so keep this helper
    // valid for both the staged browser flow and legacy PIN fixtures.
    await passwordStep.fill(options.pin);
    await page.getByRole('button', { name: 'Sign in with password' }).click();
  } else {
    await page.getByLabel('PIN').fill(options.pin);
    await page.getByRole('button', { name: 'Sign in with PIN' }).click();
  }
  await page.waitForURL(/\/(?:mfa|dashboard|admin)(?:[/?#].*)?$/, { timeout: 10_000 });
  if (new URL(page.url()).pathname === '/mfa') {
    const secret = options.username === e2eSuperAdminUsername
      ? e2eSuperAdminMfaSecret
      : e2eAdminMfaSecret;
    await page.getByLabel('Authentication code').fill(totpCode(secret));
    await page.getByRole('button', { name: 'Verify and continue' }).click();
  }
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(expectedPath)}(?:[?#].*)?$`));
}

export async function loginAsSeedAdmin(page: Page, next = '/dashboard/staff') {
  await loginWithPin(page, {
    username: e2eAdminUsername,
    pin: e2eAdminPin,
    next,
  });
}

export async function loginAsSeedManager(page: Page, next = '/dashboard/staff') {
  await loginWithPin(page, {
    username: e2eManagerUsername,
    pin: e2eManagerPin,
    next,
  });
}

export async function loginAsSeedSuperAdmin(page: Page, next = '/admin') {
  await loginWithPin(page, {
    username: e2eSuperAdminUsername,
    pin: e2eSuperAdminPin,
    next,
  });
}

export async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrfToken = (await page.context().cookies()).find((cookie) => cookie.name === 'csrf_token')?.value;
  expect(csrfToken, 'CSRF token after login').toBeTruthy();
  return { 'x-csrf-token': csrfToken ?? '' };
}

export async function apiJson<T>(
  page: Page,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  data?: unknown,
  expectedStatus?: number,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const expected = expectedStatus ?? (method === 'GET' ? 200 : method === 'DELETE' ? 204 : 201);
  const headers = method === 'GET'
    ? extraHeaders
    : { ...(await csrfHeaders(page)), ...extraHeaders };
  const response = method === 'GET'
    ? await page.request.get(url)
    : method === 'POST'
      ? await page.request.post(url, { headers, data })
      : await page.request.delete(url, { headers });

  if (response.status() !== expected) {
    throw new Error(`${method} ${url} returned ${response.status()}: ${await response.text()}`);
  }

  if (expected === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
