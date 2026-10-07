import { createHash } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { expect, test, type Page, type Route } from './qa-isolation-fixture';
import { loginAsSeedSuperAdmin, runFullStack } from './support';

// Firefox Range endpoints can differ from card bounds by1/65536 CSS pixel.
// Limit numerical tolerance to numeric/card edges;1/64 CSS-pixel overflow still fails.
const NUMERIC_CARD_EPSILON = 1 / 1024;

const mockMode = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const ROOT = '/api/v2/admin/tenants', PROBE = 'x-tenant-aggregate-probe', WIRE = 'x-tenant-aggregate-wire';
// A wallet's signed32-bit cap is not a cap on the sum of loaded wallets.
const MAX_WALLET = 2_147_483_647;
const backing = Array.from({ length: 100 }, (_, index) => ({
  id: `93000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  name: `Aggregate tenant ${index + 1}`, slug: `aggregate-${index + 1}`, planTier: 'FREE', status: 'ACTIVE',
  usageCredits: MAX_WALLET, createdAt: new Date(Date.UTC(2026, 8, 30 - index, 12)).toISOString(),
  trialEndsAt: null, gracePeriodEndsAt: null, deletedAt: null, usersCount: 2, locationsCount: 1,
}));
const last = backing[49];
const cursor = Buffer.from(JSON.stringify({ v: 1, timestamp: last.createdAt, id: last.id })).toString('base64url');
const paths = [`${ROOT}?limit=50`, `${ROOT}?${new URLSearchParams({ limit: '50', cursor })}`];
const pages = [0, 1].map(index => ({ data: backing.slice(index * 50, index * 50 + 50), pagination: {
  limit: 50, maxLimit: 200, returned: 50, hasMore: index === 0, nextCursor: index === 0 ? cursor : null,
  window: { startDate: null, endDate: null },
} }));
const bodies = pages.map(page => JSON.stringify(page)), originalModel = JSON.stringify(pages);

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within5s`)), 5000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

async function fixture(page: Page) {
  const requests: Array<{ sequence: number; method: string; path: string; body: string | null; probe: boolean; delivered: boolean }> = [];
  const failures: unknown[] = [], pending: Promise<unknown>[] = [], pageErrors: string[] = [];
  const onError = (error: Error) => pageErrors.push(String(error)); page.on('pageerror', onError);
  const handler = (route: Route) => {
    const task = (async () => {
      const request = route.request(), url = new URL(request.url());
      const row = { sequence: requests.length + 1, method: request.method(), path: url.pathname + url.search,
        body: request.postData(), probe: request.headers()[PROBE] === 'readback', delivered: false };
      requests.push(row);
      try {
        const index = paths.indexOf(row.path);
        if (requests.length > 16 || row.method !== 'GET' || index < 0 || row.body !== null) {
          throw new Error(`Unadmitted read-only aggregate request: ${row.method} ${row.path}`);
        }
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store',
          [WIRE]: String(row.sequence) }, body: bodies[index] });
        row.delivered = true;
      } catch (error) {
        failures.push(error);
        try { await route.abort(); } catch (abortError) { failures.push(abortError); }
      }
    })(); pending.push(task); return task;
  };
  await page.route('**/api/v2/admin/tenants**', handler);
  return {
    requests,
    async load(index: number, action: () => Promise<unknown>) {
      const expectedSequence = requests.length + 1;
      const response = page.waitForResponse(value => value.headers()[WIRE] === String(expectedSequence) && value.request().headers()[PROBE] !== 'readback', { timeout: 5000 });
      pending.push(response); void response.catch(() => undefined);
      await action(); const native = await response;
      expect(native.request().method()).toBe('GET');
      expect(new URL(native.url()).pathname + new URL(native.url()).search).toBe(paths[index]);
      expect(native.status()).toBe(200); expect(await bounded(native.finished(), 'native aggregate completion')).toBeNull();
      expect(await bounded(native.text(), 'native aggregate body')).toBe(bodies[index]);
      const sequence = Number(native.headers()[WIRE]);
      await expect.poll(() => requests.find(row => row.sequence === sequence)?.delivered).toBe(true);
      expect(requests.find(row => row.sequence === sequence)).toMatchObject({ method: 'GET', probe: false, delivered: true });
    },
    async read() {
      const values = [];
      for (let index = 0; index < paths.length; index += 1) {
        const value = await bounded(page.evaluate(async ({ path, header }) => {
          const response = await fetch(path, { headers: { [header]: 'readback' }, cache: 'no-store' });
          return { status: response.status, body: await response.text(), sequence: response.headers.get('x-tenant-aggregate-wire') };
        }, { path: paths[index], header: PROBE }), 'independent aggregate page readback');
        expect(value.status).toBe(200); expect(value.body).toBe(bodies[index]);
        await expect.poll(() => requests.find(row => String(row.sequence) === value.sequence)?.delivered).toBe(true);
        expect(requests.find(row => String(row.sequence) === value.sequence)).toMatchObject({ method: 'GET', probe: true, delivered: true });
        values.push(JSON.parse(value.body) as typeof pages[number]);
      }
      return values;
    },
    async close() {
      let drained = 0;
      const drain = async () => {
        while (drained < pending.length) {
          const batch = pending.slice(drained); drained += batch.length;
          for (const result of await bounded(Promise.allSettled(batch), 'aggregate route drain')) {
            if (result.status === 'rejected') failures.push(result.reason);
          }
        }
      };
      try { await drain(); } catch (error) { failures.push(error); }
      try { await page.unroute('**/api/v2/admin/tenants**', handler); } catch (error) { failures.push(error); }
      try { await drain(); } catch (error) { failures.push(error); }
      page.off('pageerror', onError);
      try { expect(JSON.stringify(pages)).toBe(originalModel); } catch (error) { failures.push(error); }
      try { await test.info().attach('tenant-aggregate-native-custody', { contentType: 'application/json',
        body: JSON.stringify({ bodies: bodies.map(body => ({ body, sha256: createHash('sha256').update(body).digest('hex') })),
          backingRows: backing.length, requests, pageErrors, failures: failures.map(String) }) }); }
      catch (error) { failures.push(error); }
      if (pageErrors.length) failures.push(new Error(pageErrors.join('\n')));
      if (failures.length) throw new AggregateError(failures, 'Read-only aggregate fixture failed');
    },
  };
}

async function exactNumberGeometry(value: Locator, card: Locator, expected: string) {
  await expect(value).toHaveText(expected);
  const result = await value.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const text = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.toJSON());
    const ancestors = [];
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      ancestors.push({ visibility: style.visibility, opacity: Number(style.opacity),
        x: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX), y: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY),
        left: box.left + parent.clientLeft, right: box.left + parent.clientLeft + parent.clientWidth,
        top: box.top + parent.clientTop, bottom: box.top + parent.clientTop + parent.clientHeight });
    }
    return { content: node.textContent, text, ancestors, fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth };
  });
  const box = await card.boundingBox(); expect(box).not.toBeNull(); if (!box) throw new Error('Missing aggregate card');
  expect(result.content).toBe(expected); expect(result.fontSize).toBeGreaterThanOrEqual(16);
  expect(result.documentWidth).toBeLessThanOrEqual(result.viewport.width); expect(result.bodyWidth).toBeLessThanOrEqual(result.viewport.width);
  expect(result.text, 'the full max-wallet aggregate must remain one readable number').toHaveLength(1);
  for (const rect of result.text) {
    expect([rect.left, rect.right, box.x, box.x + box.width].every(Number.isFinite), 'numeric card bounds must be finite').toBe(true);
    expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(result.viewport.width);
    expect(rect.left).toBeGreaterThanOrEqual(box.x - NUMERIC_CARD_EPSILON); expect(rect.right).toBeLessThanOrEqual(box.x + box.width + NUMERIC_CARD_EPSILON);
    expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(result.viewport.height);
    for (const ancestor of result.ancestors) {
      expect(ancestor.visibility).toBe('visible'); expect(ancestor.opacity).toBeGreaterThan(0);
      if (ancestor.x) { expect(rect.left).toBeGreaterThanOrEqual(ancestor.left); expect(rect.right).toBeLessThanOrEqual(ancestor.right); }
      if (ancestor.y) { expect(rect.top).toBeGreaterThanOrEqual(ancestor.top); expect(rect.bottom).toBeLessThanOrEqual(ancestor.bottom); }
    }
  }
  return result;
}

test.describe('Tenant aggregate credit summary layout', () => {
  test.skip(!mockMode, 'Requires deterministic read-only tenant fixture');
  test.use({ locale: 'en-US' });
  for (const width of [320, 393, 768, 1280]) {
    test(`keeps max-wallet totals exact and readable after native load more at ${width}px`, async ({ page }) => {
      const reset = await page.request.post('/api/v1/__e2e/reset'); expect(reset.ok()).toBeTruthy();
      await page.setViewportSize({ width, height: 720 });
      await loginAsSeedSuperAdmin(page);
      const adapter = await fixture(page), evidence: unknown[] = [], writes: unknown[] = [];
      const onRequest = (request: import('@playwright/test').Request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/v2/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path });
      };
      page.on('request', onRequest);
      let primary: unknown;
      try {
        await adapter.load(0, () => page.goto('/admin/tenants'));
        const original = await adapter.read(); expect(original).toEqual(pages);
        const summary = page.getByRole('region', { name: 'Loaded tenant summary', exact: true });
        const directory = page.getByRole('article', { name: 'Tenant directory table', exact: true });
        const table = directory.getByRole('table', { name: 'Tenant records', exact: true });
        await expect(table).toHaveCount(1);
        const totals = ['107,374,182,350', '214,748,364,700'];
        for (const index of [0, 1]) {
          const count = index === 0 ? 50 : 100;
          if (index === 1) {
            const more = directory.getByRole('button', { name: 'Load more tenants', exact: true });
            await expect(more).toBeEnabled();
            await adapter.load(1, () => more.click());
          }
          await expect(table.locator('tbody > tr')).toHaveCount(count);
          await expect(page.getByText(`${count} organizations loaded${index === 0 ? ' - more available' : ''}`, { exact: true })).toBeVisible();
          const slugs = await table.locator('tbody td[headers="tenant-directory-organization"] > div:last-child').allTextContents();
          expect(slugs).toEqual(backing.slice(0, count).map(tenant => tenant.slug));
          await summary.scrollIntoViewIfNeeded();
          await expect(summary.locator('article')).toHaveCount(4);
          const values = [String(count), String(count), '0', totals[index]];
          for (let metric = 0; metric < 4; metric += 1) {
            const card = summary.locator('article').nth(metric), parts = card.locator(':scope > div');
            await expect(parts.nth(0).locator('span').first()).toHaveText(['Total tenants', 'Active tenants', 'Suspended or archived', 'Usage credits'][metric]);
            await expect(parts.nth(2)).toHaveText(['organizations loaded', 'active in loaded rows', 'attention in loaded rows', 'credits in loaded rows'][metric]);
            evidence.push({ width, count, metric, geometry: await exactNumberGeometry(parts.nth(1), card, values[metric]) });
          }
          await test.info().attach(`tenant-aggregate-${width}-${count}-loaded`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
        }
        await expect(directory.getByRole('button', { name: 'Load more tenants', exact: true })).toHaveCount(0);
        expect(await adapter.read()).toEqual(original);
        expect(adapter.requests.filter(row => !row.probe).map(row => row.path)).toEqual(paths);
        expect(adapter.requests.every(row => row.method === 'GET' && row.body === null)).toBe(true);
        expect(writes).toEqual([]);
      } catch (error) { primary = error; throw error; }
      finally {
        page.off('request', onRequest);
        const failures: unknown[] = [];
        try { expect(writes).toEqual([]); } catch (error) { failures.push(error); }
        try { await test.info().attach('tenant-aggregate-geometry', { contentType: 'application/json', body: JSON.stringify({ evidence, writes }) }); }
        catch (error) { failures.push(error); }
        try { await adapter.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], 'Aggregate assertion and cleanup failed');
      }
    });
  }
});
