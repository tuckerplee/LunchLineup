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
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
  await page.getByLabel('PIN').fill(options.pin);
  await page.getByRole('button', { name: 'Sign in with PIN' }).click();
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
