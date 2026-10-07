import { createHash } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { expect, test, type Page, type Route } from './qa-isolation-fixture';
import { loginAsSeedSuperAdmin, runFullStack } from './support';

const mockMode = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const ROOT = '/api/v2/admin/tenants';
const PROBE = 'x-tenant-layout-probe', WIRE = 'x-tenant-layout-wire';
// AdminController.toSlug caps at64; Tenant.name is an unconstrained Prisma
// String.200 is a supported stress length, not a claimed name-schema maximum.
const LONG_NAME = 'A'.repeat(200), LONG_SLUG = 'a'.repeat(64);
const id = (index: number) => `92000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const backing = Array.from({ length: 51 }, (_, index) => ({
  id: id(index + 1), name: index === 0 ? LONG_NAME : index === 1 ? 'Boreal Kitchen' : `Other tenant ${index + 1}`,
  slug: index === 0 ? LONG_SLUG : index === 1 ? 'boreal-fixture' : `other-tenant-${index + 1}`,
  planTier: 'FREE', status: index === 1 ? 'CANCELLED' : 'ACTIVE',
  usageCredits: index === 0 ? 2_000_000_000 : index === 1 ? 40 : 0,
  createdAt: new Date(Date.UTC(2026, 8, 30 - index, 12)).toISOString(),
  trialEndsAt: null, gracePeriodEndsAt: null,
  deletedAt: index === 1 ? '2026-10-07T12:00:00.000Z' : null,
  usersCount: 2, locationsCount: 1,
}));
// Native buildBoundedListPage uses limit+1 lookahead. A hasMore page with
// requested limit50 really contains50 returned rows, not a fabricated two.
const last = backing[49];
const payload = { data: backing.slice(0, 50), pagination: { limit: 50, maxLimit: 200, returned: 50,
  hasMore: true, nextCursor: Buffer.from(JSON.stringify({ v: 1, timestamp: last.createdAt, id: last.id })).toString('base64url'),
  window: { startDate: null, endDate: null } } };
const BODY = JSON.stringify(payload), SHA = createHash('sha256').update(BODY).digest('hex');
const captions = ['organizations loaded', 'active in loaded rows', 'attention in loaded rows', 'credits in loaded rows'];
const metrics = [['Total tenants', '50'], ['Active tenants', '49'], ['Suspended or archived', '1'], ['Usage credits', '2,000,000,040']];
const fields = ['Organization', 'Plan', 'Status', 'Usage', 'Credits', 'Created', 'Actions'];

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within5s`)), 5000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

async function fixture(page: Page) {
  const requests: Array<{ sequence: number; method: string; path: string; body: string | null; probe: boolean; delivered: boolean }> = [];
  const failures: unknown[] = [], pending: Promise<unknown>[] = [], pageErrors: string[] = [];
  const onError = (error: Error) => pageErrors.push(String(error));
  page.on('pageerror', onError);
  const handler = (route: Route) => {
    const task = (async () => {
      const request = route.request(), url = new URL(request.url());
      const row = { sequence: requests.length + 1, method: request.method(), path: url.pathname + url.search,
        body: request.postData(), probe: request.headers()[PROBE] === 'readback', delivered: false };
      requests.push(row);
      try {
        if (requests.length > 16 || row.method !== 'GET' || row.path !== `${ROOT}?limit=50` || row.body !== null) {
          throw new Error(`Unadmitted read-only tenant request: ${row.method} ${row.path}`);
        }
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store',
          [WIRE]: String(row.sequence) }, body: BODY });
        row.delivered = true;
      } catch (error) {
        failures.push(error);
        try { await route.abort(); } catch (abortError) { failures.push(abortError); }
      }
    })();
    pending.push(task); return task;
  };
  await page.route('**/api/v2/admin/tenants**', handler);
  return {
    requests,
    async load() {
      const expectedSequence = requests.length + 1;
      const response = page.waitForResponse(value => value.headers()[WIRE] === String(expectedSequence) && value.request().headers()[PROBE] !== 'readback', { timeout: 5000 });
      // Retain waiter failures even if navigation fails before it can be awaited.
      pending.push(response); void response.catch(() => undefined);
      await page.goto('/admin/tenants');
      const native = await response;
      expect(native.request().method()).toBe('GET');
      expect(new URL(native.url()).pathname + new URL(native.url()).search).toBe(`${ROOT}?limit=50`);
      expect(native.status()).toBe(200); expect(await bounded(native.finished(), 'native list completion')).toBeNull();
      expect(await bounded(native.text(), 'native list body')).toBe(BODY);
      const sequence = Number(native.headers()[WIRE]);
      await expect.poll(() => requests.find(row => row.sequence === sequence)?.delivered).toBe(true);
      expect(requests.find(row => row.sequence === sequence)).toMatchObject({ method: 'GET', probe: false, delivered: true });
    },
    async read() {
      const value = await bounded(page.evaluate(async ({ path, header }) => {
        const response = await fetch(path, { headers: { [header]: 'readback' }, cache: 'no-store' });
        return { status: response.status, body: await response.text(), sequence: response.headers.get('x-tenant-layout-wire') };
      }, { path: `${ROOT}?limit=50`, header: PROBE }), 'independent list readback');
      expect(value.status).toBe(200); expect(value.body).toBe(BODY);
      await expect.poll(() => requests.find(row => String(row.sequence) === value.sequence)?.delivered).toBe(true);
      expect(requests.find(row => String(row.sequence) === value.sequence)).toMatchObject({ method: 'GET', probe: true, delivered: true });
      return JSON.parse(value.body) as typeof payload;
    },
    async close() {
      let drained = 0;
      const drain = async () => {
        while (drained < pending.length) {
          const batch = pending.slice(drained); drained += batch.length;
          for (const result of await bounded(Promise.allSettled(batch), 'tenant route drain')) {
            if (result.status === 'rejected') failures.push(result.reason);
          }
        }
      };
      try { await drain(); } catch (error) { failures.push(error); }
      try { await page.unroute('**/api/v2/admin/tenants**', handler); } catch (error) { failures.push(error); }
      try { await drain(); } catch (error) { failures.push(error); }
      page.off('pageerror', onError);
      try { await test.info().attach('tenant-long-content-native-custody', { contentType: 'application/json',
        body: JSON.stringify({ bodySha256: SHA, body: BODY, backingRows: backing.length, requests, pageErrors, failures: failures.map(String) }) }); }
      catch (error) { failures.push(error); }
      if (pageErrors.length) failures.push(new Error(pageErrors.join('\n')));
      if (failures.length) throw new AggregateError(failures, 'Read-only tenant fixture failed');
    },
  };
}

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 32; step += 1) {
    if (await target.evaluate(node => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target, 'Native Tab must reach the intended target').toBeFocused();
}

// The native focus target must keep its visible unique tenant context nearby.
// ARIA alone does not protect a sighted keyboard user from the next row's name.
async function visibleActionContext(page: Page, action: Locator, context: Locator, slug: string, label: string) {
  await expect(action).toBeFocused();
  await expect(context).toHaveText(`for ${slug}`);
  await expect(context).toHaveCount(1);
  const chrome = page.locator('.workspace-topbar'); await expect(chrome).toHaveCount(1);
  const header = await chrome.evaluate(node => ({ position: getComputedStyle(node).position, box: node.getBoundingClientRect().toJSON() }));
  const result = await context.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const text = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.toJSON());
    const ancestors = [];
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      ancestors.push({ visibility: style.visibility, opacity: Number(style.opacity),
        x: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX), y: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY),
        left: rect.left + parent.clientLeft, right: rect.left + parent.clientLeft + parent.clientWidth,
        top: rect.top + parent.clientTop, bottom: rect.top + parent.clientTop + parent.clientHeight });
    }
    return { content: node.textContent, box: node.getBoundingClientRect().toJSON(), text, ancestors, viewport: { width: innerWidth, height: innerHeight } };
  });
  const actionBox = await action.boundingBox();
  await test.info().attach(`${label}-visible-tenant-context`, { contentType: 'application/json',
    body: JSON.stringify({ slug, header, actionBox, context: result }) });
  await expect(context).toBeVisible(); await expect(context).toBeInViewport({ ratio: 1 });
  expect(actionBox).not.toBeNull(); if (!actionBox) throw new Error('Missing focused action rectangle');
  expect(result.text.length).toBeGreaterThan(0);
  const chromeBottom = ['sticky', 'fixed'].includes(header.position) ? Math.max(0, header.box.bottom) : 0;
  expect(actionBox.y, 'focused action must remain below sticky chrome').toBeGreaterThanOrEqual(chromeBottom);
  expect(result.box.bottom).toBeLessThanOrEqual(actionBox.y + 1);
  expect(actionBox.y - result.box.bottom, 'visible tenant context must sit immediately above its action').toBeLessThanOrEqual(12);
  for (const ancestor of result.ancestors) { expect(ancestor.visibility).toBe('visible'); expect(ancestor.opacity).toBeGreaterThan(0); }
  for (const rect of [result.box, ...result.text]) {
    expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(result.viewport.width);
    expect(rect.top, 'tenant context must not be covered by sticky chrome').toBeGreaterThanOrEqual(chromeBottom);
    expect(rect.bottom).toBeLessThanOrEqual(result.viewport.height);
    for (const ancestor of result.ancestors) {
      if (ancestor.x) { expect(rect.left).toBeGreaterThanOrEqual(ancestor.left); expect(rect.right).toBeLessThanOrEqual(ancestor.right); }
      if (ancestor.y) { expect(rect.top).toBeGreaterThanOrEqual(ancestor.top); expect(rect.bottom).toBeLessThanOrEqual(ancestor.bottom); }
    }
  }
}

async function textGeometry(target: Locator, horizontalViewport: boolean) {
  await expect(target).toBeVisible();
  const result = await target.evaluate(node => {
    const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
    const text = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.toJSON());
    const ancestors = [];
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      ancestors.push({ visibility: style.visibility, opacity: Number(style.opacity),
        x: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX), y: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY),
        left: rect.left + parent.clientLeft, right: rect.left + parent.clientLeft + parent.clientWidth,
        top: rect.top + parent.clientTop, bottom: rect.top + parent.clientTop + parent.clientHeight });
    }
    return { content: node.textContent, box: box.toJSON(), text, ancestors, viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth };
  });
  expect(result.text.length).toBeGreaterThan(0);
  expect(result.documentWidth).toBeLessThanOrEqual(result.viewport.width); expect(result.bodyWidth).toBeLessThanOrEqual(result.viewport.width);
  for (const ancestor of result.ancestors) { expect(ancestor.visibility).toBe('visible'); expect(ancestor.opacity).toBeGreaterThan(0); }
  for (const rect of result.text) {
    expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(result.viewport.height);
    if (horizontalViewport) { expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(result.viewport.width); }
    for (const ancestor of result.ancestors) {
      if (horizontalViewport && ancestor.x) { expect(rect.left).toBeGreaterThanOrEqual(ancestor.left); expect(rect.right).toBeLessThanOrEqual(ancestor.right); }
      if (ancestor.y) { expect(rect.top).toBeGreaterThanOrEqual(ancestor.top); expect(rect.bottom).toBeLessThanOrEqual(ancestor.bottom); }
    }
  }
  return result;
}

// A long desktop table name may legitimately require horizontal scrolling.
// Reveal both text edges with native arrows, rather than rewriting scrollLeft.
async function revealEdge(page: Page, scroller: Locator, text: Locator, edge: 'left' | 'right') {
  await expect(scroller).toBeFocused();
  for (let step = 0; step < 100; step += 1) {
    const position = await text.evaluate((node, which) => {
      const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect();
      const container = node.closest('[aria-label="Tenant table scroll area"]')!, box = container.getBoundingClientRect();
      return { point: which === 'left' ? rect.left : rect.right, left: box.left + container.clientLeft,
        right: box.left + container.clientLeft + container.clientWidth };
    }, edge);
    if (position.point >= position.left && position.point <= position.right) return { edge, steps: step, ...position, scrollLeft: await scroller.evaluate(node => node.scrollLeft) };
    const before = await scroller.evaluate(node => node.scrollLeft), direction = position.point < position.left ? -1 : 1;
    await page.keyboard.press(direction < 0 ? 'ArrowLeft' : 'ArrowRight');
    await expect.poll(async () => direction * ((await scroller.evaluate(node => node.scrollLeft)) - before), { timeout: 2000 }).toBeGreaterThan(0);
    let last = Number.NaN, stable = 0;
    await expect.poll(async () => {
      const current = await scroller.evaluate(node => node.scrollLeft);
      stable = Math.abs(current - last) < 0.1 ? stable + 1 : 0; last = current;
      return stable;
    }, { timeout: 2000, intervals: [50, 50, 50] }).toBeGreaterThanOrEqual(2);
  }
  throw new Error(`Native arrows did not reveal desktop text ${edge} edge`);
}

test.describe('Tenant long-content mobile layout', () => {
  test.skip(!mockMode, 'Closed local read-only model; native qualification remains separate.');
  test.use({ locale: 'en-US' });
  for (const width of [320, 393, 768, 1280]) {
  test(`keeps long tenant identity, complete summaries and paged context readable without writes at ${width}px`, async ({ page }) => {
    const reset = await page.request.post('/api/v1/__e2e/reset'); expect(reset.ok()).toBeTruthy();
    const adapter = await fixture(page), evidence: unknown[] = [], writes: unknown[] = [];
    const onRequest = (request: import('@playwright/test').Request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v2/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path });
    };
    let primary: unknown;
    try {
      await loginAsSeedSuperAdmin(page, '/admin/tenants');
      page.on('request', onRequest);
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      await expect(page.getByRole('table', { name: 'Tenant records', exact: true }).locator('tbody > tr')).toHaveCount(50);
      expect(LONG_NAME).toHaveLength(200); expect(LONG_SLUG).toHaveLength(64);
      const original = await adapter.read(); expect(original).toEqual(payload);
      {
        await page.setViewportSize({ width, height: 720 }); await adapter.load();
        const directory = page.getByRole('article', { name: 'Tenant directory table', exact: true });
        const table = directory.getByRole('table', { name: 'Tenant records', exact: true });
        const scroller = directory.getByRole('region', { name: 'Tenant table scroll area', exact: true });
        const row = table.getByRole('row').filter({ has: page.getByText(LONG_SLUG, { exact: true }) });
        const second = table.getByRole('row').filter({ has: page.getByText('boreal-fixture', { exact: true }) });
        await expect(row).toHaveCount(1); await expect(second).toHaveCount(1);
        await expect(table).toHaveCount(1); await expect(table.getByRole('columnheader')).toHaveText(fields);
        await expect(table.locator('tbody > tr')).toHaveCount(50);
        await expect(page.getByText('50 organizations loaded - more available', { exact: true })).toBeVisible();
        await expect(directory.getByRole('button', { name: 'Load more tenants', exact: true })).toBeEnabled();
        await test.info().attach(`tenant-long-${width}-first-viewport`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
        const summary = page.getByRole('region', { name: 'Loaded tenant summary', exact: true });
        await expect(summary).toHaveAttribute('aria-describedby', 'loaded-tenant-summary-context');
        await expect(summary.locator('article')).toHaveCount(4);
        const context = page.locator('#loaded-tenant-summary-context'); await expect(context).toHaveText('Loaded organizations only');
        if (width <= 768) evidence.push({ width, label: 'shared context', geometry: await textGeometry(context, true) });
        for (let index = 0; index < 4; index += 1) {
          const cell = summary.locator('article').nth(index), parts = cell.locator(':scope > div');
          const label = parts.nth(0).locator('span').first(), value = parts.nth(1), caption = parts.nth(2);
          await expect(label).toHaveText(metrics[index][0]); await expect(value).toHaveText(metrics[index][1]); await expect(caption).toHaveText(captions[index]);
          for (const target of [label, value, caption]) evidence.push({ width, label: 'summary', geometry: await textGeometry(target, true) });
          const numericGeometry = await textGeometry(value, true), cardBox = await cell.boundingBox();
          expect(cardBox).not.toBeNull(); if (!cardBox) throw new Error('Missing summary card bounds');
          expect(numericGeometry.text, 'complete summary numbers must stay on one readable line').toHaveLength(1);
          expect(numericGeometry.text[0].left).toBeGreaterThanOrEqual(cardBox.x);
          expect(numericGeometry.text[0].right).toBeLessThanOrEqual(cardBox.x + cardBox.width);
          expect(await value.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize)), 'summary numbers must remain at least 16px').toBeGreaterThanOrEqual(16);
          evidence.push({ width, label: 'single-line exact summary number', geometry: numericGeometry, cardBox });
        }
        // A long selected identity must not expand the management grid's
        // shared implicit track or push either card outside the document.
        for (const title of ['Create tenant', 'Selected tenant']) {
          const panel = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
          await expect(panel).toHaveCount(1);
          const box = await panel.boundingBox(); expect(box).not.toBeNull();
          if (!box) throw new Error(`Missing ${title} panel bounds`);
          expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
          evidence.push({ width, label: 'management panel horizontal containment', title, box });
          if (title === 'Selected tenant') {
            const identity = panel.getByText(`${LONG_NAME} · ${LONG_SLUG}`, { exact: true });
            await expect(identity).toHaveText(`${LONG_NAME} · ${LONG_SLUG}`);
            const geometry = await identity.evaluate(node => {
              const range = document.createRange(); range.selectNodeContents(node);
              const style = getComputedStyle(node);
              return { text: [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.toJSON()),
                visibility: style.visibility, opacity: Number(style.opacity) };
            });
            expect(geometry.visibility).toBe('visible'); expect(geometry.opacity).toBeGreaterThan(0);
            expect(geometry.text.length).toBeGreaterThan(0);
            for (const rect of geometry.text) {
              expect(rect.left).toBeGreaterThanOrEqual(box.x); expect(rect.right).toBeLessThanOrEqual(box.x + box.width);
            }
            evidence.push({ width, label: 'complete selected identity wraps within panel', geometry });
          }
        }
        const cells = row.getByRole('cell'); await expect(cells).toHaveCount(7);
        for (let index = 0; index < 7; index += 1) await expect(cells.nth(index)).toHaveAttribute('headers', `tenant-directory-${fields[index].toLowerCase()}`);
        const name = cells.nth(0).locator(':scope > div').first(), slug = cells.nth(0).locator(':scope > div').last();
        await expect(name).toHaveText(LONG_NAME); await expect(slug).toHaveText(LONG_SLUG);
        await expect(cells.nth(1)).toContainText('FREE'); await expect(cells.nth(2)).toContainText('ACTIVE');
        await expect(cells.nth(3)).toContainText('2'); await expect(cells.nth(3)).toContainText('users');
        await expect(cells.nth(4)).toContainText('2,000,000,000'); await expect(cells.nth(5)).toContainText('Sep 30, 2026');
        await expect(cells.nth(6).getByRole('button')).toHaveText(['Edit', 'Suspend', 'Archive']);
        for (const [record, tenantId, description] of [
          [row, id(1), `${LONG_NAME} ${LONG_SLUG}`],
          [second, id(2), 'Boreal Kitchen boreal-fixture'],
        ] as const) {
          for (const action of await record.getByRole('button').all()) {
            await expect(action).toHaveAttribute('aria-describedby', `tenant-directory-name-${tenantId} tenant-directory-slug-${tenantId}`);
            await expect(action).toHaveAccessibleDescription(description);
          }
        }
        await expect(second.getByRole('cell').nth(0)).toContainText('Boreal Kitchen');
        await expect(second.getByRole('cell').nth(4)).toContainText('40');
        evidence.push({ width, label: 'identity before record scrolling', name: await name.boundingBox(), slug: await slug.boundingBox() });
        for (const target of [name, slug]) {
          await target.scrollIntoViewIfNeeded();
          evidence.push({ width, label: 'long identity', geometry: await textGeometry(target, width <= 768) });
          await test.info().attach(`tenant-long-${width}-${target === name ? 'name' : 'slug'}`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
        }
        await tabTo(page, directory); await tabTo(page, scroller);
        if (width === 1280) {
          // Position noninteractive text vertically for evidence; focus stays
          // on the real scroll region. Horizontal edge traversal is native.
          await name.scrollIntoViewIfNeeded(); await expect(scroller).toBeFocused();
          expect(await scroller.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
          for (const edge of ['left', 'right'] as const) {
            evidence.push({ width, label: 'native name edge', ...(await revealEdge(page, scroller, name, edge)) });
            const nameBox = await name.boundingBox(); expect(nameBox).not.toBeNull();
            if (!nameBox) throw new Error('Missing native-scrolled name bounds');
            expect(nameBox.y).toBeGreaterThanOrEqual(0); expect(nameBox.y + nameBox.height).toBeLessThanOrEqual(720);
            await test.info().attach(`tenant-long-${width}-native-name-${edge}`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
          }
        }
        for (const action of [row.getByRole('button', { name: 'Archive', exact: true }), second.getByRole('button', { name: 'Restore', exact: true })]) {
          await tabTo(page, action); await expect(action).toBeInViewport({ ratio: 1 });
          await expect(action).toHaveAccessibleDescription(await action.innerText() === 'Archive' ? `${LONG_NAME} ${LONG_SLUG}` : 'Boreal Kitchen boreal-fixture');
          const box = await action.boundingBox(); expect(box).not.toBeNull(); if (!box) throw new Error('Missing focused action bounds');
          expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
          if (width <= 768) { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); }
          const geometry = await textGeometry(action, true);
          for (const ancestor of geometry.ancestors) {
            if (ancestor.x) { expect(geometry.box.left).toBeGreaterThanOrEqual(ancestor.left); expect(geometry.box.right).toBeLessThanOrEqual(ancestor.right); }
            if (ancestor.y) { expect(geometry.box.top).toBeGreaterThanOrEqual(ancestor.top); expect(geometry.box.bottom).toBeLessThanOrEqual(ancestor.bottom); }
          }
          evidence.push({ width, label: await action.innerText(), box, geometry,
            tenantContext: await action.getAttribute('aria-describedby') });
          await test.info().attach(`tenant-long-${width}-focused-${await action.innerText()}`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
          if (width <= 768) {
            const isArchive = await action.innerText() === 'Archive', tenantId = id(isArchive ? 1 : 2), slug = isArchive ? LONG_SLUG : 'boreal-fixture';
            const record = isArchive ? row : second;
            await visibleActionContext(page, action, record.locator(`[id="tenant-directory-action-context-${tenantId}"]`), slug,
              `tenant-long-${width}-${await action.innerText()}`);
          }
        }
        expect(await adapter.read()).toEqual(original); expect(writes).toEqual([]);
      }
    } catch (error) { primary = error; throw error; }
    finally {
      page.off('request', onRequest);
      const failures: unknown[] = [];
      try { expect(writes).toEqual([]); } catch (error) { failures.push(error); }
      try { await test.info().attach('tenant-long-content-geometry-and-writes', { contentType: 'application/json', body: JSON.stringify({ evidence, writes }) }); }
      catch (error) { failures.push(error); }
      try { await adapter.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], 'Long-content assertion and cleanup failed');
    }
  });
  }
});
