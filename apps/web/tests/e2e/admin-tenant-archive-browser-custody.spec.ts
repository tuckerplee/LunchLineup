import { createHash } from 'node:crypto';
import type { ConsoleMessage, Dialog, Locator, Request } from '@playwright/test';
import { expect, test, type Page, type Route } from './qa-isolation-fixture';
import { loginAsSeedSuperAdmin, runFullStack } from './support';

// Browser interaction against a finite per-page model, not native PostgreSQL,
// session revocation, audit/intent durability, Stripe or reconciliation proof.
const mockMode = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const ROOT = '/api/v2/admin/tenants';
const A = '84000000-0000-4000-8000-000000000001', B = '84000000-0000-4000-8000-000000000002';
const REFUSAL = 'Forbidden';
const ARCHIVED_AT = '2026-10-07T12:00:00.000Z';
const PROMPT = 'Archive Boreal Kitchen?\n\nThe tenant will leave the active directory and must be restored before it can be used again.\n\nType boreal-fixture to confirm.';
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Action = 'suspend' | 'activate' | 'archive' | 'restore';
type Mode = 'positive' | 'blocked' | 'refusal' | 'malformed' | 'lost' | 'wrong-target' | 'wrong-result';
type Entry = 'directory' | 'selected';
type Tenant = { id: string; name: string; slug: string; planTier: 'FREE'; status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  usageCredits: number; createdAt: string; trialEndsAt: null; gracePeriodEndsAt: null; deletedAt: string | null;
  usersCount: number; locationsCount: number };
type Snapshot = { data: Tenant[]; pagination: { limit: number; maxLimit: number; returned: number; hasMore: false; nextCursor: null; window: { startDate: null; endDate: null } } };
type Row = { sequence: number; method: string; url: string; requestBody: string | null; key: string | null; probe: boolean;
  contentType: string | null; csrfPresent: boolean;
  status: number | null; body: string | null; bodySha256: string | null; effects: number; disposition: 'response' | 'lost'; delivered: boolean };
type Receipt = { method: string; url: string; requestBody: string | null; key: string | null; probe: boolean;
  contentType: string | null; csrfPresent: boolean;
  status: number | null; bodyBase64: string | null; complete: boolean; error: string | null };
type ArchiveWindow = Window & { __archiveBodies?: { receipts: Receipt[]; errors: string[] } };
async function bounded<T>(pending: Promise<T>, label: string, milliseconds = 6000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function observe(page: Page) {
  await page.addInitScript(({ root }) => {
    // Allows two isolated modes in the final case without wrapping fetch twice.
    if ((window as ArchiveWindow).__archiveBodies) return;
    const observer = { receipts: [] as Receipt[], errors: [] as string[] };
    (window as ArchiveWindow).__archiveBodies = observer;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const pending = original(input, init);
      try {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), location.href);
        if (url.origin === location.origin && (url.pathname === root || url.pathname.startsWith(root + '/'))) {
          if (observer.receipts.length >= 40) throw new Error('Archive native receipt bound exceeded');
          const headers = new Headers(init?.headers ?? request?.headers);
          const receipt: Receipt = { method: (init?.method ?? request?.method ?? 'GET').toUpperCase(), url: url.href,
            requestBody: typeof init?.body === 'string' ? init.body : null, key: headers.get('idempotency-key'),
            probe: headers.get('x-archive-fixture-probe') === 'readback', contentType: headers.get('content-type'),
            csrfPresent: Boolean(headers.get('x-csrf-token')), status: null, bodyBase64: null, complete: false, error: null };
          observer.receipts.push(receipt);
          void pending.then(async response => {
            receipt.status = response.status;
            const bytes = new Uint8Array(await response.clone().arrayBuffer());
            receipt.bodyBase64 = btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''));
          }).catch(error => { receipt.error = String(error); }).finally(() => { receipt.complete = true; });
        }
      } catch (error) { observer.errors.push(String(error)); }
      return pending;
    };
  }, { root: ROOT });
}
async function install(page: Page, mode: Mode, action: Action = 'archive') {
  const endpoint = `${ROOT}/${B}/${action}`;
  if (action !== 'archive' && (mode === 'blocked' || mode === 'malformed')) throw new Error('Unsupported lifecycle fixture combination');
  const common = { planTier: 'FREE' as const, status: 'ACTIVE' as const, createdAt: '2026-09-01T12:00:00.000Z',
    trialEndsAt: null, gracePeriodEndsAt: null, deletedAt: null, usersCount: 2, locationsCount: 1 };
  const tenants: Tenant[] = [
    { ...common, createdAt: '2026-09-02T12:00:00.000Z', id: A, name: 'Aurora Diner', slug: 'aurora-fixture', usageCredits: 120 },
    { ...common, id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture', usageCredits: 40 },
  ];
  if (action === 'activate') tenants[1].status = 'SUSPENDED';
  if (action === 'restore') { tenants[1].status = 'CANCELLED'; tenants[1].deletedAt = ARCHIVED_AT; }
  const initial = copy(tenants), ledger: Row[] = [], errors: string[] = [], dialogs: unknown[] = [];
  const received: Array<{ method: string; url: string; requestBody: string | null; key: string | null; contentType: string | null; csrfPresent: boolean }> = [];
  const active = new Set<Route>(), pending: Promise<void>[] = [], retained: Receipt[] = [];
  let posts = 0, effects = 0, closing = false;
  function snapshot(q = ''): Snapshot {
    const data = copy(tenants.filter(row => `${row.name} ${row.slug}`.toLowerCase().includes(q.toLowerCase())));
    return { data, pagination: { limit: 50, maxLimit: 200, returned: data.length, hasMore: false, nextCursor: null, window: { startDate: null, endDate: null } } };
  }
  async function run(route: Route) {
    try {
      if (closing || ledger.length >= 40) throw new Error('Archive route outside finite lifetime');
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const requestBody = request.postData(), key = request.headers()['idempotency-key'] ?? null;
      const probe = request.headers()['x-archive-fixture-probe'] === 'readback';
      const contentType = request.headers()['content-type'] ?? null, csrfPresent = Boolean(request.headers()['x-csrf-token']);
      // Record requests before admission so rejected requests remain diagnosable.
      received.push({ method, url: url.href, requestBody, key, contentType, csrfPresent });
      let status: number | null = 200, body: string | null, disposition: Row['disposition'] = 'response';
      if (method === 'GET' && url.pathname === ROOT) {
        const q = url.searchParams.get('q') ?? '';
        if (url.searchParams.get('limit') !== '50' || !['', 'boreal'].includes(q)
          || [...url.searchParams.keys()].some(name => !['limit', 'q'].includes(name))
          || url.searchParams.getAll('limit').length !== 1 || url.searchParams.getAll('q').length > 1
          || requestBody !== null || key !== null || (probe && q !== '')) throw new Error('Unexpected exact archive list request');
        body = JSON.stringify(snapshot(q));
      } else if (method === 'POST' && url.pathname === endpoint && !url.search && !probe) {
        posts += 1;
        if (posts > (mode === 'refusal' ? 2 : 1) || requestBody !== null || key !== null
          // client-api.withSessionDefaults removes JSON Content-Type for a bodyless action.
          || contentType !== null || !csrfPresent) {
          throw new Error('Unexpected archive target/body/headers or blind repeated mutation');
        }
        if (mode === 'refusal' && posts === 1) {
          status = 403; body = JSON.stringify({ type: 'https://lunchlineup.com/problems/permission-denied', title: 'Forbidden',
            status: 403, detail: REFUSAL, message: REFUSAL, instance: endpoint, code: 'permission_denied', requestId: 'archive-controlled-refusal' });
        }
        else if (mode === 'blocked') { status = 201; body = JSON.stringify({ id: B, archived: false }); }
        else if (mode === 'wrong-target') { status = 201; body = JSON.stringify(successAck(action, A)); }
        else if (mode === 'wrong-result') { status = 201; body = JSON.stringify(wrongResultAck(action)); }
        else {
          if (effects !== 0) throw new Error('Repeated archive effect');
          Object.assign(tenants[1], completedTenant(initial[1], action)); effects += 1;
          status = 201; body = JSON.stringify(successAck(action));
          if (mode === 'malformed') body = '{"id":';
          if (mode === 'lost') { disposition = 'lost'; status = null; body = null; }
        }
      } else throw new Error('Unexpected archive method/path; all nonselected tenant writes are prohibited');
      const row: Row = { sequence: ledger.length + 1, method, url: url.href, requestBody, key, probe, contentType, csrfPresent, status, body,
        bodySha256: body === null ? null : createHash('sha256').update(body).digest('hex'), effects, disposition, delivered: false };
      ledger.push(row);
      if (disposition === 'lost') await route.abort('connectionclosed');
      else await route.fulfill({ status: status!, headers: { 'content-type': status === 403 ? 'application/problem+json; charset=utf-8' : 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body!)), 'cache-control': 'no-store' }, body: body! });
      row.delivered = true;
    } catch (error) {
      errors.push(String(error));
      try { await bounded(route.abort('failed'), 'archive exceptional abort', 2000); } catch (abortError) { errors.push(String(abortError)); }
    } finally { active.delete(route); }
  }
  const handler = (route: Route) => { active.add(route); const work = run(route); pending.push(work); return work; };
  await page.route('**/api/v2/admin/tenants**', handler);
  function assertAdapterHealthy() {
    if (errors.length) throw new Error(`Lifecycle adapter rejected a request: ${errors.join('; ')}`);
  }
  async function drainReceipts() {
    assertAdapterHealthy();
    await expect.poll(async () => {
      assertAdapterHealthy();
      const observed = await page.evaluate(() => (window as ArchiveWindow).__archiveBodies);
      return Boolean(observed && observed.receipts.every(row => row.complete)
        && observed.receipts.length + retained.length === ledger.length && ledger.every(row => row.delivered));
    }, { timeout: 6000 }).toBe(true);
    const observed = await page.evaluate(() => (window as ArchiveWindow).__archiveBodies);
    if (!observed) throw new Error('Missing archive observer');
    expect(observed.errors).toEqual([]);
    return observed;
  }
  return { mode, action, endpoint, initial, ledger, received, errors, dialogs, retained, snapshot, drainReceipts, assertAdapterHealthy,
    async read() {
      const result = await bounded(page.evaluate(async root => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
        try { const response = await fetch(root + '?limit=50', { headers: { 'x-archive-fixture-probe': 'readback' }, signal: controller.signal });
          return { status: response.status, body: await response.text() }; } finally { clearTimeout(timer); }
      }, ROOT), 'independent archive GET');
      expect(result.status).toBe(200); expect(result.body).toBe(ledger.filter(row => row.probe).at(-1)?.body);
      return JSON.parse(result.body) as Snapshot;
    },
    async reload() {
      const observed = await drainReceipts(); retained.push(...observed.receipts);
      await page.reload(); await expect(directory(page)).toBeVisible(); await expect(target(page, B)).toBeVisible();
    },
    async close() {
      try { await bounded(Promise.all(pending), 'archive handlers drain'); } catch (error) { errors.push(String(error)); }
      closing = true;
      if (active.size) {
        errors.push(`${active.size} archive routes remained active`);
        const result = await Promise.allSettled([...active].map(route => bounded(route.abort('failed'), 'archive cleanup abort', 2000)));
        for (const item of result) if (item.status === 'rejected') errors.push(String(item.reason));
      }
      await bounded(page.unroute('**/api/v2/admin/tenants**', handler), 'archive exact unroute', 3000);
      await bounded(Promise.all(pending), 'archive final drain', 3000);
    },
  };
}
type Adapter = Awaited<ReturnType<typeof install>>;
const directory = (page: Page) => page.getByRole('article', { name: 'Tenant directory table', exact: true });
const target = (page: Page, id: string) => directory(page).getByRole('row').filter({ hasText: id === A ? 'aurora-fixture' : 'boreal-fixture' });
const archivedNotice = (page: Page) => page.getByText('Boreal Kitchen archived.', { exact: true });
async function prompt(page: Page, adapter: Adapter, answer: string | null) {
  let handler!: (dialog: Dialog) => void;
  const seen = new Promise<void>((resolve, reject) => {
    handler = dialog => { void (async () => {
      adapter.dialogs.push({ type: dialog.type(), message: dialog.message(), answer });
      try {
        expect(dialog.type()).toBe('prompt'); expect(dialog.message()).toBe(PROMPT);
        if (answer === null) await dialog.dismiss(); else await dialog.accept(answer);
        resolve();
      } catch (error) { await dialog.dismiss().catch(() => undefined); reject(error); }
    })(); };
    page.once('dialog', handler);
  });
  try { await bounded(Promise.all([seen, target(page, B).getByRole('button', { name: 'Archive', exact: true }).click()]), 'archive confirmation'); }
  finally { page.off('dialog', handler); }
}
async function capture(page: Page, adapter: Adapter, label: string) {
  const state = await adapter.read(); await adapter.drainReceipts();
  const ui = await page.locator('main').innerText({ timeout: 6000 });
  const evidence = { mode: adapter.mode, state, ui, ledger: adapter.ledger, dialogs: adapter.dialogs,
    observed: await page.evaluate(() => (window as ArchiveWindow).__archiveBodies) };
  await test.info().attach(`${adapter.mode}-${label}`, { contentType: 'application/json', body: JSON.stringify(evidence) });
  await test.info().attach(`${adapter.mode}-${label}-viewport`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
  return evidence;
}
async function waitPosts(page: Page, adapter: Adapter, count: number) {
  await expect.poll(() => { adapter.assertAdapterHealthy(); return adapter.ledger.filter(row => row.method === 'POST').length; }, { timeout: 6000 }).toBe(count);
  await adapter.drainReceipts();
  await expect(page.getByRole('button', { name: busyLabel[adapter.action], exact: true })).toHaveCount(0);
}
async function refresh(page: Page, adapter: Adapter) {
  const before = adapter.ledger.filter(row => row.method === 'GET' && !row.probe).length;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => adapter.ledger.filter(row => row.method === 'GET' && !row.probe).length).toBeGreaterThan(before);
  await adapter.drainReceipts();
}
async function settled(page: Page, adapter: Adapter) {
  await expect(target(page, B)).toContainText('ARCHIVED');
  await expect(target(page, B).getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  await expect(target(page, B).getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  const state = await adapter.read();
  expect(state.data).toEqual([adapter.initial[0], { ...adapter.initial[1], status: 'CANCELLED', deletedAt: ARCHIVED_AT }]);
  expect(state.data[0]).toEqual(adapter.initial[0]);
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

// Exercise the existing shell through native keyboard input, without logging out
// or navigating away from the owned read-only/lifecycle fixture.
async function compactAdminShell(page: Page, width: number) {
  const toggle = page.getByRole('button', { name: 'Admin navigation', exact: true });
  const topbar = page.locator('header.workspace-topbar');
  const mobileLogout = topbar.getByRole('link', { name: 'Sign out', exact: true });
  if (width > 768) {
    if (width > 1024) { await expect(toggle).toBeHidden(); await expect(mobileLogout).toBeHidden(); }
    return;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const sidebar = page.getByRole('complementary', { name: 'Admin sidebar', exact: true });
  const nav = page.getByRole('navigation', { name: 'Admin navigation', exact: true, includeHidden: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(nav).toBeHidden();
  await expect(page.locator('a.workspace-mobile-signout')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Sign out', exact: true })).toHaveCount(1);
  await expect(mobileLogout).toHaveAttribute('href', '/auth/logout');
  const text = [sidebar.getByText('LunchLineup', { exact: true }), sidebar.getByText('SUPER ADMIN', { exact: true }),
    topbar.getByText('System Administration', { exact: true }), topbar.locator(':scope > div:last-child > .badge')];
  await expect(text[3]).toHaveText('development'); // This suite requires the isolated mock/dev server.
  const evidence: unknown[] = [];
  for (const target of [...text, toggle, mobileLogout]) {
    await expect(target).toBeVisible(); await expect(target).toBeInViewport({ ratio: 1 });
    const geometry = await target.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const clips = [];
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
        clips.push({ x: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX), y: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY),
          left: box.left + parent.clientLeft, right: box.left + parent.clientLeft + parent.clientWidth,
          top: box.top + parent.clientTop, bottom: box.top + parent.clientTop + parent.clientHeight });
      }
      return { content: node.textContent, box: node.getBoundingClientRect().toJSON(), text: [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => r.toJSON()), clips, viewport: { width: innerWidth, height: innerHeight } };
    });
    evidence.push(geometry);
    for (const rect of [geometry.box, ...geometry.text]) {
      expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(width);
      expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(geometry.viewport.height);
      for (const clip of geometry.clips) {
        if (clip.x) { expect(rect.left).toBeGreaterThanOrEqual(clip.left); expect(rect.right).toBeLessThanOrEqual(clip.right); }
        if (clip.y) { expect(rect.top).toBeGreaterThanOrEqual(clip.top); expect(rect.bottom).toBeLessThanOrEqual(clip.bottom); }
      }
    }
  }
  for (const control of [toggle, mobileLogout]) {
    const box = await control.boundingBox(); expect(box).not.toBeNull(); if (!box) throw new Error('Missing mobile shell control bounds');
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const shell = await topbar.evaluate(node => ({ box: node.getBoundingClientRect().toJSON(), position: getComputedStyle(node).position }));
  expect(shell.position).toBe('sticky');
  expect(shell.box.bottom, 'seeded mobile shell must leave useful space for records').toBeLessThanOrEqual(112);
  await test.info().attach(`tenant-admin-shell-${width}-closed`, { contentType: 'application/json', body: JSON.stringify({ width, shell, evidence }) });
  await test.info().attach(`tenant-admin-shell-${width}-closed-viewport`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
  const trail: string[] = [];
  // Reach the menu from the existing focused row action; never focus a target synthetically.
  for (let step = 0; step < 32 && !(await toggle.evaluate(node => node === document.activeElement)); step += 1) {
    await page.keyboard.press('Shift+Tab');
    trail.push(await page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''}`));
  }
  await expect(toggle).toBeFocused(); await page.keyboard.press('Tab'); await expect(mobileLogout).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter'); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(nav).toBeVisible();
  const expectedLinks = [
    ['Calendar', '/dashboard/scheduling'], ['Team Dashboard', '/dashboard'], ['Lunch & Breaks', '/dashboard/lunch-breaks'],
    ['Staff', '/dashboard/staff'], ['Locations', '/dashboard/locations'], ['Admin Overview', '/admin'],
    ['Tenants', '/admin/tenants'], ['Users', '/admin/users'], ['Credits', '/admin/credits'], ['Plans', '/admin/plans'],
  ];
  await expect(nav.getByRole('link')).toHaveCount(expectedLinks.length);
  for (const [name, href] of expectedLinks) {
    const link = nav.getByRole('link', { name, exact: true }); await expect(link).toHaveAttribute('href', href);
    await page.keyboard.press('Tab'); await expect(link).toBeFocused(); await expect(link).toBeInViewport({ ratio: 1 });
    const box = await link.boundingBox(); expect(box).not.toBeNull(); if (!box) throw new Error('Missing admin navigation link bounds');
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  await expect(nav.getByRole('link', { name: 'Tenants', exact: true })).toHaveAttribute('aria-current', 'page');
  await test.info().attach(`tenant-admin-shell-${width}-open-viewport`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
  await page.keyboard.press('Escape'); await expect(nav).toBeHidden(); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(toggle).toBeFocused();
  await page.keyboard.press('Tab'); await expect(mobileLogout).toBeFocused();
  await test.info().attach(`tenant-admin-shell-${width}-keyboard`, { contentType: 'application/json', body: JSON.stringify({ trail, expectedLinks, escapedToMenu: true, closedNextTabIsLogout: true }) });
}

async function actionLayout(page: Page) {
  const original = page.viewportSize(); if (!original) throw new Error('Explicit canonical viewport required');
  const widths = test.info().project.name === 'chromium' ? [...new Set([320, 393, 768, original.width])] : [original.width];
  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height: original.height }); await page.evaluate(() => window.scrollTo(0, 0));
      await test.info().attach(`tenant-archive-${width}-first-viewport`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
      // Before any focus/scroll interaction, record where the first tenant lands.
      // Retain the measured identity and require useful short-record content
      // before focus or scrolling, not just a sliver of the first card.
      const firstIdentity = target(page, A).getByRole('cell').nth(0).locator(':scope > div').first();
      const firstGeometry = await firstIdentity.evaluate(node => {
        const box = node.getBoundingClientRect();
        const intersectionWidth = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
        const intersectionHeight = Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
        return { text: node.textContent, box: box.toJSON(), viewport: { width: innerWidth, height: innerHeight },
          viewportOnlyIntersectionRatio: box.width * box.height ? intersectionWidth * intersectionHeight / (box.width * box.height) : 0 };
      });
      await test.info().attach(`tenant-first-identity-${width}-before-scroll`, {
        contentType: 'application/json', body: JSON.stringify(firstGeometry) });
      if (width <= 768) {
        expect(firstGeometry.viewportOnlyIntersectionRatio, 'first tenant identity before scrolling').toBe(1);
        const organizationBox = await target(page, A).getByRole('cell').nth(0).boundingBox();
        expect(organizationBox).not.toBeNull(); if (!organizationBox) throw new Error('Missing first organization cell bounds');
        expect(firstGeometry.box.width, 'tenant name must use the complete mobile identity column').toBeGreaterThanOrEqual(organizationBox.width - 1);
        for (const field of ['plan', 'status']) {
          const cell = target(page, A).locator(`td[headers="tenant-directory-${field}"]`);
          await expect(cell, `first tenant ${field} before scrolling`).toBeInViewport({ ratio: 1 });
          const box = await cell.boundingBox(); expect(box).not.toBeNull();
          if (!box) throw new Error('Missing first-record metadata bounds');
          // Reserve space below the metadata instead of accepting a clipped
          // card that barely touches the bottom edge of a phone viewport.
          expect(box.y + box.height).toBeLessThanOrEqual(original.height - 44);
        }
      }
      const summary = page.getByRole('region', { name: 'Loaded tenant summary', exact: true });
      const context = page.locator('#loaded-tenant-summary-context');
      await expect(summary).toHaveAttribute('aria-describedby', 'loaded-tenant-summary-context');
      await expect(context).toHaveText('Loaded organizations only');
      const captions = ['organizations loaded', 'active in loaded rows', 'attention in loaded rows', 'credits in loaded rows'];
      const expectedMetrics = [ ['Total tenants', '2'], ['Active tenants', '1'], ['Suspended or archived', '1'], ['Usage credits', '160'] ];
      await expect(summary.locator('article')).toHaveCount(4);
      const visibleMetrics: Locator[] = [];
      for (let index = 0; index < expectedMetrics.length; index += 1) {
        const metric = summary.locator('article').nth(index);
        const label = metric.locator(':scope > div').nth(0).locator('span').first();
        const value = metric.locator(':scope > div').nth(1), caption = metric.locator(':scope > div').nth(2);
        await expect(label).toHaveText(expectedMetrics[index][0]); await expect(value).toHaveText(expectedMetrics[index][1]);
        await expect(label).toBeVisible(); await expect(value).toBeVisible(); await expect(caption).toHaveText(captions[index]);
        await expect(caption).toBeVisible();
        visibleMetrics.push(label, value, caption);
      }
      const aria = await summary.ariaSnapshot({ timeout: 5000 });
      await test.info().attach(`tenant-summary-${width}-aria`, { contentType: 'text/plain', body: aria });
      for (const caption of captions) expect(aria).toContain(caption);
      if (width <= 768) {
        await expect(context).toBeVisible();
        const captionStyles = await summary.locator('article > div:last-child').evaluateAll(nodes => nodes.map(node => {
          const style = getComputedStyle(node);
          return { color: style.color, weight: Number(style.fontWeight), size: Number.parseFloat(style.fontSize) };
        }));
        const contextColor = await context.evaluate(node => getComputedStyle(node).color);
        for (const style of captionStyles) {
          expect(style.color).toBe(contextColor); expect(style.weight).toBeLessThanOrEqual(500);
          expect(style.size).toBeGreaterThanOrEqual(12);
        }
        const measurements = [];
        for (const item of [context, ...visibleMetrics]) {
          const measured = await item.evaluate(node => {
            const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
            const text = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.toJSON());
            const clips = [], visibility = [];
            for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
              visibility.push({ visibility: style.visibility, opacity: Number(style.opacity) });
              if (ancestor !== document.body && ancestor !== document.documentElement) clips.push({
                x: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX),
                y: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY),
                left: rect.left + ancestor.clientLeft, top: rect.top + ancestor.clientTop,
                right: rect.left + ancestor.clientLeft + ancestor.clientWidth, bottom: rect.top + ancestor.clientTop + ancestor.clientHeight });
            }
            return { content: node.textContent, box: box.toJSON(), text, clips, visibility, viewport: { width: innerWidth, height: innerHeight } };
          });
          measurements.push(measured);
        }
        await test.info().attach(`tenant-summary-${width}-text-geometry`, {
          contentType: 'application/json', body: JSON.stringify(measurements) });
        for (const measured of measurements) {
          expect(measured.box.width).toBeGreaterThan(0); expect(measured.box.height).toBeGreaterThan(0); expect(measured.text.length).toBeGreaterThan(0);
          for (const visibility of measured.visibility) { expect(visibility.visibility).toBe('visible'); expect(visibility.opacity).toBeGreaterThan(0); }
          for (const rect of [measured.box, ...measured.text]) {
            expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.top).toBeGreaterThanOrEqual(0);
            expect(rect.right).toBeLessThanOrEqual(measured.viewport.width); expect(rect.bottom).toBeLessThanOrEqual(measured.viewport.height);
          }
          for (const rect of measured.text) for (const clip of measured.clips) {
            if (clip.x) { expect(rect.left).toBeGreaterThanOrEqual(clip.left); expect(rect.right).toBeLessThanOrEqual(clip.right); }
            if (clip.y) { expect(rect.top).toBeGreaterThanOrEqual(clip.top); expect(rect.bottom).toBeLessThanOrEqual(clip.bottom); }
          }
        }
      }
      const headings = ['Organization', 'Plan', 'Status', 'Usage', 'Credits', 'Created', 'Actions'];
      const table = directory(page).getByRole('table');
      await expect(table).toHaveCount(1);
      await expect(table.getByRole('columnheader')).toHaveText(headings);
      for (let index = 0; index < headings.length; index += 1) {
        const header = table.getByRole('columnheader').nth(index);
        await expect(header).toHaveAttribute('id', `tenant-directory-${headings[index].toLowerCase()}`);
        await expect(header).toHaveAttribute('scope', 'col');
      }
      const scroller = table.locator('..');
      const heading = directory(page).getByRole('heading', { name: 'Tenant Directory', exact: true });
      const refreshControl = directory(page).getByRole('button', { name: 'Refresh', exact: true });
      const bulkControl = directory(page).getByRole('button', { name: /^Remove Archived \(\d+\)$/ });
      for (const control of [heading, refreshControl, bulkControl]) {
        await expect(control).toHaveCount(1); await expect(control).toBeVisible();
      }
      await expect(scroller.getByRole('heading', { name: 'Tenant Directory', exact: true })).toHaveCount(0);
      await expect(scroller.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
      await expect(scroller.getByRole('button', { name: /^Remove Archived \(\d+\)$/ })).toHaveCount(0);
      const horizontalToolbar = async () => {
        const boxes = await Promise.all([heading, refreshControl, bulkControl].map(control => control.boundingBox()));
        return boxes.map(box => {
          expect(box).not.toBeNull(); if (!box) throw new Error('Missing tenant directory toolbar rectangle');
          expect(box.width).toBeGreaterThan(0); expect(box.x).toBeGreaterThanOrEqual(-1);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
          return { x: box.x, width: box.width };
        });
      };
      const toolbarBefore = await horizontalToolbar();
      const scrollBefore = await scroller.evaluate(node => ({ left: node.scrollLeft, client: node.clientWidth, scroll: node.scrollWidth }));
      await expect(scroller).toHaveAttribute('role', 'region');
      await expect(scroller).toHaveAttribute('aria-label', 'Tenant table scroll area');
      await expect(scroller).toHaveAttribute('tabindex', '0');
      if (width > 768 && scrollBefore.scroll > scrollBefore.client + 1) {
        await scroller.focus(); await expect(scroller).toBeFocused();
        const key = scrollBefore.left + scrollBefore.client < scrollBefore.scroll - 1 ? 'ArrowRight' : 'ArrowLeft';
        await page.keyboard.press(key);
        await expect.poll(() => scroller.evaluate(node => node.scrollLeft)).not.toBe(scrollBefore.left);
        const afterArrow = await scroller.evaluate(node => node.scrollLeft);
        if (key === 'ArrowRight') expect(afterArrow).toBeGreaterThan(scrollBefore.left);
        else expect(afterArrow).toBeLessThan(scrollBefore.left);
        const toolbarAfterArrow = await horizontalToolbar();
        for (let index = 0; index < toolbarBefore.length; index += 1) {
          expect(Math.abs(toolbarAfterArrow[index].x - toolbarBefore[index].x)).toBeLessThanOrEqual(1);
          expect(Math.abs(toolbarAfterArrow[index].width - toolbarBefore[index].width)).toBeLessThanOrEqual(1);
        }
        await test.info().attach(`tenant-table-${width}-native-arrow-scroll`, {
          contentType: 'application/json', body: JSON.stringify({ key, before: scrollBefore, after: afterArrow,
            toolbarBefore, toolbarAfter: toolbarAfterArrow }) });
        await directory(page).focus(); await expect(directory(page)).toBeFocused();
      }
      // A remains active; B was independently read back archived before this helper.
      for (const item of [
        { id: A, name: 'Aurora Diner', slug: 'aurora-fixture', status: 'ACTIVE', credits: 120,
          created: 'Sep 2, 2026', record: 'Active record', actions: ['Edit', 'Suspend', 'Archive'] },
        { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture', status: 'ARCHIVED', credits: 40,
          created: 'Sep 1, 2026', record: 'Archived', actions: ['Edit', 'Restore', 'Remove'] },
      ]) {
        const row = target(page, item.id), cells = row.getByRole('cell');
        await expect(row).toHaveCount(1); await expect(cells).toHaveCount(7);
        for (let index = 0; index < headings.length; index += 1) {
          await expect(cells.nth(index)).toHaveAttribute('headers', `tenant-directory-${headings[index].toLowerCase()}`);
        }
        await expect(cells.nth(0).locator('div')).toHaveText([item.name, item.slug]);
        await expect(cells.nth(1).locator('.badge')).toHaveText('FREE');
        await expect(cells.nth(2).locator('.badge')).toHaveText(item.status);
        await expect(cells.nth(3).locator(':scope > div > div')).toHaveText(['2users', '1locations']);
        await expect(cells.nth(4).locator('div')).toHaveText(new RegExp(`^${item.credits}\\s*credits$`));
        await expect(cells.nth(5).locator('div')).toHaveText([item.created, item.record]);
        await expect(cells.nth(6).getByRole('button')).toHaveText(item.actions);
        for (const action of await cells.nth(6).getByRole('button').all()) {
          await expect(action).toHaveAttribute('aria-describedby', `tenant-directory-name-${item.id} tenant-directory-slug-${item.id}`);
          await expect(action).toHaveAccessibleDescription(`${item.name} ${item.slug}`);
        }
        if (width === 320 || width === 393) {
          const boxes = await cells.nth(6).getByRole('button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
          expect(boxes).toHaveLength(3);
          for (const box of boxes) {
            expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
            expect(Math.abs(box.top - boxes[0].top), 'short lifecycle labels should share one action row').toBeLessThanOrEqual(1);
          }
        }
        if (width <= 768) {
          const labels = row.locator('td > span[aria-hidden="true"]');
          await expect(labels).toHaveText(headings);
          for (const label of await labels.all()) await expect(label).toBeVisible();
          const measured = await table.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth,
            cells: Array.from(node.querySelectorAll('tbody td')).map(cell => {
              const box = cell.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width };
            }), viewport: innerWidth }));
          expect(measured.scroll, 'phone records must not require horizontal scrolling').toBeLessThanOrEqual(measured.client + 1);
          for (const box of measured.cells) {
            expect(box.width).toBeGreaterThan(0); expect(box.left).toBeGreaterThanOrEqual(-1);
            expect(box.right).toBeLessThanOrEqual(measured.viewport + 1);
          }
          await test.info().attach(`tenant-cards-${width}-${item.slug}-geometry`, {
            contentType: 'application/json', body: JSON.stringify(measured) });
        }
      }
      const actions = [target(page, A).getByRole('button', { name: 'Archive', exact: true }),
        target(page, B).getByRole('button', { name: 'Restore', exact: true })];
      for (const action of actions) {
        // Enter through the directory's real tabIndex=0 surface, then traverse
        // the actual focus order. Never focus the target action programmatically.
        const trail: Array<{ tag: string; text: string; name: string | null }> = [];
        await directory(page).focus(); await expect(directory(page)).toBeFocused();
        for (let step = 0; step < 16; step += 1) {
          await page.keyboard.press('Tab');
          trail.push(await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? '',
            text: document.activeElement?.textContent?.trim().slice(0, 120) ?? '',
            name: document.activeElement?.getAttribute('aria-label') ?? null })));
          if (await action.evaluate(node => node === document.activeElement)) break;
        }
        await test.info().attach(`tenant-archive-${width}-${await action.innerText()}-keyboard-trail`, {
          contentType: 'application/json', body: JSON.stringify(trail) });
        await expect(action).toBeFocused();
        const actionName = await action.innerText();
        await expect(action).toHaveAccessibleDescription(actionName === 'Archive' ? 'Aurora Diner aurora-fixture' : 'Boreal Kitchen boreal-fixture');
        await test.info().attach(`tenant-archive-${width}-${actionName}-tenant-context`, {
          contentType: 'application/json', body: JSON.stringify(await action.evaluate(node => {
            const ids = (node.getAttribute('aria-describedby') ?? '').split(/\s+/);
            return { action: node.textContent, ids, contexts: ids.map(id => ({ id,
              matches: document.querySelectorAll(`[id="${id}"]`).length,
              text: document.getElementById(id)?.textContent })) };
          })) });
        const toolbarAfter = await horizontalToolbar();
        for (let index = 0; index < toolbarBefore.length; index += 1) {
          expect(Math.abs(toolbarAfter[index].x - toolbarBefore[index].x), 'table focus must not horizontally move the directory toolbar').toBeLessThanOrEqual(1);
          expect(Math.abs(toolbarAfter[index].width - toolbarBefore[index].width), 'table focus must not resize the directory toolbar').toBeLessThanOrEqual(1);
        }
        await test.info().attach(`tenant-toolbar-${width}-${await action.innerText()}-horizontal-stability`, {
          contentType: 'application/json', body: JSON.stringify({ before: toolbarBefore, after: toolbarAfter,
            scrollBefore, scrollAfter: await scroller.evaluate(node => ({ left: node.scrollLeft, client: node.clientWidth, scroll: node.scrollWidth })) }) });
        await test.info().attach(`tenant-archive-${width}-${await action.innerText()}-reachability`, {
          contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
        if (width <= 768) {
          const tenantId = actionName === 'Archive' ? A : B, slug = actionName === 'Archive' ? 'aurora-fixture' : 'boreal-fixture';
          await visibleActionContext(page, action, target(page, tenantId).locator(`[id="tenant-directory-action-context-${tenantId}"]`), slug,
            `tenant-archive-${width}-${actionName}`);
        }
        const box = await action.boundingBox(); expect(box).not.toBeNull();
        if (!box) throw new Error('Missing archive action rectangle');
        await test.info().attach(`tenant-archive-${width}-${await action.innerText()}-rectangle`, {
          contentType: 'application/json', body: JSON.stringify({ width, box, viewport: page.viewportSize() }) });
        await expect(action).toBeInViewport({ ratio: 1 });
        expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        if (width <= 768) {
          expect(box.width, 'phone lifecycle action touch width').toBeGreaterThanOrEqual(44);
          expect(box.height, 'phone lifecycle action touch height').toBeGreaterThanOrEqual(44);
        }
      }
      const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      await test.info().attach(`tenant-archive-${width}-geometry`, { contentType: 'application/json', body: JSON.stringify(size) });
      expect(size.document, 'internal table scrolling must not overflow the document').toBeLessThanOrEqual(size.viewport + 1);
      await compactAdminShell(page, width);
    }
  } finally { await page.setViewportSize(original); }
}
async function scenario(page: Page, mode: Mode, run: (adapter: Adapter) => Promise<void>, reuseSession = false, action: Action = 'archive') {
  const errors: string[] = [], consoleErrors: Array<{ text: string; url: string }> = [];
  const requestFailures: Array<{ method: string; url: string; error: string | null }> = [];
  const onRequestFailed = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (path === ROOT || path.startsWith(ROOT + '/')) requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText ?? null });
  };
  const onPageError = (error: Error) => errors.push(String(error));
  const onConsole = (message: ConsoleMessage) => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url }); };
  page.on('pageerror', onPageError); page.on('console', onConsole); page.on('requestfailed', onRequestFailed);
  await observe(page); const adapter = await install(page, mode, action); let primary: unknown;
  try {
    if (reuseSession) await page.goto('/admin/tenants');
    else await loginAsSeedSuperAdmin(page, '/admin/tenants');
    await expect(target(page, A)).toBeVisible(); await expect(target(page, B)).toBeVisible();
    await adapter.drainReceipts(); await run(adapter);
  } catch (error) { primary = error; }
  finally {
    const secondary: string[] = [];
    // Preserve the UI and original failure before diagnostic reads/cleanup. In
    // particular an adapter rejection must not be disguised by a drain timeout.
    const terminalUi = await page.locator('main').innerText({ timeout: 3000 }).catch(error => String(error));
    try { await capture(page, adapter, 'terminal-state'); } catch (error) { secondary.push(String(error)); }
    try { await adapter.close(); } catch (error) { secondary.push(String(error)); }
    const observed = await page.evaluate(() => (window as ArchiveWindow).__archiveBodies).catch(() => undefined);
    const receipts = [...adapter.retained, ...(observed?.receipts ?? [])];
    try {
      expect(receipts).toHaveLength(adapter.ledger.length);
      const signatures = (rows: Array<{ method: string; url: string; requestBody: string | null; key: string | null; probe: boolean;
        contentType: string | null; csrfPresent: boolean; status: number | null; body: string | null }>) => rows.map(row => JSON.stringify(row)).sort();
      const expected = adapter.ledger.map(({ method, url, requestBody, key, probe, contentType, csrfPresent, status, body }) => ({ method, url, requestBody, key, probe, contentType, csrfPresent, status, body }));
      const actual = receipts.map(({ method, url, requestBody, key, probe, contentType, csrfPresent, status, bodyBase64 }) => ({ method, url, requestBody, key, probe, contentType, csrfPresent, status,
        body: bodyBase64 === null ? null : Buffer.from(bodyBase64, 'base64').toString('utf8') }));
      expect(signatures(actual)).toEqual(signatures(expected));
      expect(receipts.every(row => row.complete)).toBe(true);
      expect(receipts.filter(row => row.error !== null)).toHaveLength(mode === 'lost' ? 1 : 0);
      if (mode === 'lost') expect(receipts.find(row => row.error !== null)).toMatchObject({ method: 'POST', status: null, bodyBase64: null });
      expect(requestFailures).toHaveLength(mode === 'lost' ? 1 : 0);
      if (mode === 'lost') {
        expect(requestFailures[0].method).toBe('POST');
        expect(new URL(requestFailures[0].url).pathname).toBe(adapter.endpoint);
        expect(requestFailures[0].error).toBeTruthy();
      }
      expect(observed?.errors ?? []).toEqual([]); expect(adapter.errors).toEqual([]); expect(errors).toEqual([]);
      const expectedNetworkError = (row: { text: string; url: string }) => new URL(row.url || page.url(), page.url()).pathname === adapter.endpoint
        && /Failed to load resource|NetworkError|NS_ERROR_NET|net::ERR_/i.test(row.text)
        && (mode === 'lost' || (mode === 'refusal' && /403|Forbidden/i.test(row.text)));
      expect(consoleErrors.filter(row => !expectedNetworkError(row))).toEqual([]);
    } catch (error) { secondary.push(String(error)); }
    await test.info().attach(`${mode}-full-response-custody`, { contentType: 'application/json', body: JSON.stringify({
      mode, action, primary: primary ? String(primary) : null, terminalUi, received: adapter.received,
      ledger: adapter.ledger, dialogs: adapter.dialogs, receipts, errors, consoleErrors, requestFailures, adapterErrors: adapter.errors, secondary,
      scope: 'Closed browser model; no native session/audit/provider or PostgreSQL qualification.',
    }) });
    page.off('pageerror', onPageError); page.off('console', onConsole); page.off('requestfailed', onRequestFailed);
    if (primary) throw primary;
    if (secondary.length) throw new Error(secondary.join('\n'));
  }
}

const actionLabel: Record<Action, string> = { suspend: 'Suspend', activate: 'Activate', archive: 'Archive', restore: 'Restore' };
const pastLabel: Record<Action, string> = { suspend: 'suspended', activate: 'activated', archive: 'archived', restore: 'restored' };
const busyLabel: Record<Action, string> = { suspend: 'Suspending...', activate: 'Activating...', archive: 'Archiving...', restore: 'Restoring...' };
function successAck(action: Action, id = B): Record<string, unknown> {
  if (action === 'suspend') return { id, status: 'SUSPENDED' };
  if (action === 'activate') return { id, status: 'ACTIVE' };
  if (action === 'restore') return { id, restored: true };
  return { id, archived: true };
}
function wrongResultAck(action: Action): Record<string, unknown> {
  if (action === 'suspend') return { id: B, status: 'ACTIVE' };
  if (action === 'activate') return { id: B, status: 'SUSPENDED' };
  if (action === 'restore') return { id: B, restored: false };
  throw new Error('Archive archived:false is already covered by its original case');
}
function completedTenant(tenant: Tenant, action: Action): Tenant {
  return { ...tenant, status: action === 'archive' ? 'CANCELLED' : action === 'suspend' ? 'SUSPENDED' : 'ACTIVE',
    deletedAt: action === 'archive' ? ARCHIVED_AT : null };
}
const selected = (page: Page) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Selected tenant', exact: true }) });
const completedNotice = (page: Page, action: Action) => page.getByText(`Boreal Kitchen ${pastLabel[action]}.`, { exact: true });
const uncertainGuidance = (page: Page, action: Action) => page.getByText(new RegExp(`${action}.*(?:unconfirmed|not confirmed|could not.*verif)|(?:unconfirmed|not confirmed).*${action}`, 'i')).first();
async function lifecycleActionBounds(page: Page, button: Locator, label: string) {
  const viewport = page.viewportSize(); if (!viewport) throw new Error('Explicit canonical viewport required');
  const box = await button.boundingBox();
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  await test.info().attach(`${label}-geometry`, { contentType: 'application/json',
    body: JSON.stringify({ viewport, box, documentWidth }) });
  await test.info().attach(`${label}-viewport`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
  await expect(button).toBeInViewport({ ratio: 1 }); expect(box).not.toBeNull();
  if (!box) throw new Error('Missing lifecycle action rectangle');
  expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(-1); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  if (viewport.width <= 768) {
    expect(box.width, 'phone lifecycle action touch width').toBeGreaterThanOrEqual(44);
    expect(box.height, 'phone lifecycle action touch height').toBeGreaterThanOrEqual(44);
  }
  expect(documentWidth, 'internal table scrolling must not overflow the document').toBeLessThanOrEqual(viewport.width + 1);
}
async function lifecycleDirectoryKeyboard(page: Page, action: Exclude<Action, 'archive'>) {
  const button = target(page, B).getByRole('button', { name: actionLabel[action], exact: true });
  const trail: Array<{ tag: string; text: string; name: string | null }> = [];
  // Start at the actual directory tab stop. Do not focus or scroll the target
  // programmatically: real Tab traversal must reveal the target action.
  await directory(page).focus(); await expect(directory(page)).toBeFocused();
  for (let step = 0; step < 16; step += 1) {
    await page.keyboard.press('Tab');
    trail.push(await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? '',
      text: document.activeElement?.textContent?.trim().slice(0, 120) ?? '',
      name: document.activeElement?.getAttribute('aria-label') ?? null })));
    if (await button.evaluate(node => node === document.activeElement)) break;
  }
  await test.info().attach(`${action}-directory-keyboard-trail`, { contentType: 'application/json', body: JSON.stringify(trail) });
  await expect(button).toBeFocused();
  await lifecycleActionBounds(page, button, `${action}-directory-keyboard`);
}
async function lifecycleClick(page: Page, adapter: Adapter, entry: Entry, answer: string | null = 'boreal-fixture') {
  const action = adapter.action;
  if (entry === 'selected') {
    await target(page, B).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(selected(page).getByLabel('Name', { exact: true })).toHaveValue('Boreal Kitchen');
    await expect(selected(page).getByLabel('Slug', { exact: true })).toHaveValue('boreal-fixture');
  }
  const button = (entry === 'selected' ? selected(page) : target(page, B)).getByRole('button', { name: actionLabel[action], exact: true });
  await expect(button).toBeEnabled();
  if (entry === 'selected') {
    await button.scrollIntoViewIfNeeded({ timeout: 5000 });
    await lifecycleActionBounds(page, button, `${action}-selected-${adapter.dialogs.length}-${adapter.ledger.filter(row => row.method === 'POST').length}`);
  }
  if (action === 'activate' || action === 'restore') {
    // These current user flows have an explicit button, not a confirmation dialog.
    // Install a handler so any unexpected dialog fails promptly instead of hanging.
    const unexpected: string[] = [];
    const handler = (dialog: Dialog) => { unexpected.push(dialog.message()); void dialog.dismiss(); };
    page.on('dialog', handler);
    try { await bounded(button.click(), `${action} explicit click`); expect(unexpected).toEqual([]); }
    finally { page.off('dialog', handler); }
    return;
  }
  const expectedPrompt = action === 'archive' ? PROMPT
    : 'Suspend Boreal Kitchen?\n\nUsers may lose workspace access until the tenant is activated again.\n\nType boreal-fixture to confirm.';
  let handler!: (dialog: Dialog) => void;
  const seen = new Promise<void>((resolve, reject) => {
    handler = dialog => { void (async () => {
      adapter.dialogs.push({ entry, action, type: dialog.type(), message: dialog.message(), answer });
      try {
        expect(dialog.type()).toBe('prompt'); expect(dialog.message()).toBe(expectedPrompt);
        if (answer === null) await dialog.dismiss(); else await dialog.accept(answer);
        resolve();
      } catch (error) { await dialog.dismiss().catch(() => undefined); reject(error); }
    })(); };
    page.once('dialog', handler);
  });
  try { await bounded(Promise.all([seen, button.click()]), `${action} exact confirmation`); }
  finally { page.off('dialog', handler); }
}
async function lifecycleState(page: Page, adapter: Adapter, committed: boolean) {
  const expectedB = committed ? completedTenant(adapter.initial[1], adapter.action) : adapter.initial[1];
  const state = await adapter.read();
  expect(state.data).toEqual([adapter.initial[0], expectedB]);
  expect(state.data[0]).toEqual(adapter.initial[0]);
  expect(state.data.map(row => ({ id: row.id, usageCredits: row.usageCredits })))
    .toEqual(adapter.initial.map(row => ({ id: row.id, usageCredits: row.usageCredits })));
  await expect(target(page, A)).toContainText('ACTIVE');
  await expect(target(page, B)).toContainText(expectedB.deletedAt ? 'ARCHIVED' : expectedB.status);
  const nextAction = expectedB.deletedAt ? 'Restore' : expectedB.status === 'SUSPENDED' ? 'Activate' : 'Suspend';
  await expect(target(page, B).getByRole('button', { name: nextAction, exact: true })).toBeVisible();
}
function exactPosts(adapter: Adapter, expected: Array<{ status: number | null; body: string | null; effects: number }>) {
  const posts = adapter.ledger.filter(row => row.method === 'POST');
  expect(posts).toHaveLength(expected.length);
  for (const [index, row] of posts.entries()) {
    const url = new URL(row.url);
    expect(url.pathname).toBe(adapter.endpoint); expect(url.search).toBe('');
    expect(row).toMatchObject({ requestBody: null, key: null, probe: false, contentType: null, csrfPresent: true,
      delivered: true, ...expected[index] });
  }
}
async function refusedThenSuccessful(page: Page, action: Exclude<Action, 'archive'>) {
  await scenario(page, 'refusal', async adapter => {
    // One real keyboard walk per action/project, before any directory mutation.
    await lifecycleDirectoryKeyboard(page, action);
    if (action === 'suspend') {
      await lifecycleClick(page, adapter, 'directory', null);
      await lifecycleClick(page, adapter, 'selected', 'aurora-fixture');
      expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(0);
      expect((await adapter.read()).data).toEqual(adapter.initial);
    }
    await lifecycleClick(page, adapter, 'directory'); await waitPosts(page, adapter, 1);
    const evidence = await capture(page, adapter, `${action}-refusal-before-ui-verdict`);
    expect(evidence.state.data).toEqual(adapter.initial);
    await expect(completedNotice(page, action)).toHaveCount(0);
    await expect(page.getByText(REFUSAL, { exact: true })).toBeVisible();
    await expect(uncertainGuidance(page, action)).toBeVisible();
    await lifecycleState(page, adapter, false);
    await refresh(page, adapter);
    await expect(page.getByText(REFUSAL, { exact: true })).toBeVisible();
    await expect(uncertainGuidance(page, action)).toBeVisible();
    expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1);
    if (action === 'suspend') {
      await lifecycleClick(page, adapter, 'selected', null);
      expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1);
      expect((await adapter.read()).data).toEqual(adapter.initial);
    }
    // A fresh user action at the other actual entry point permits the second POST.
    await lifecycleClick(page, adapter, 'selected'); await waitPosts(page, adapter, 2);
    await expect(completedNotice(page, action)).toBeVisible();
    await expect(uncertainGuidance(page, action)).toHaveCount(0);
    await expect(page.getByText(REFUSAL, { exact: true })).toHaveCount(0);
    await lifecycleState(page, adapter, true);
    await expect(selected(page).getByLabel('Name', { exact: true })).toHaveValue('Boreal Kitchen');
    await expect(selected(page).getByLabel('Status', { exact: true })).toHaveValue(action === 'suspend' ? 'SUSPENDED' : 'ACTIVE');
    await adapter.reload(); await lifecycleState(page, adapter, true);
    exactPosts(adapter, [{ status: 403, body: JSON.stringify({ type: 'https://lunchlineup.com/problems/permission-denied',
      title: 'Forbidden', status: 403, detail: REFUSAL, message: REFUSAL, instance: adapter.endpoint,
      code: 'permission_denied', requestId: 'archive-controlled-refusal' }), effects: 0 },
    { status: 201, body: JSON.stringify(successAck(action)), effects: 1 }]);
    if (action !== 'suspend') expect(adapter.dialogs).toEqual([]);
  }, false, action);
}
async function invalidAcknowledgement(page: Page, action: Action, mode: 'wrong-target' | 'wrong-result', entry: Entry) {
  await scenario(page, mode, async adapter => {
    await lifecycleClick(page, adapter, entry); await waitPosts(page, adapter, 1);
    const evidence = await capture(page, adapter, `${action}-${mode}-before-ui-verdict`);
    expect(evidence.state.data).toEqual(adapter.initial);
    exactPosts(adapter, [{ status: 201, body: JSON.stringify(mode === 'wrong-target' ? successAck(action, A) : wrongResultAck(action)), effects: 0 }]);
    // Diagnose false completion before testing explanatory wording.
    await expect(completedNotice(page, action)).toHaveCount(0);
    await expect(uncertainGuidance(page, action)).toBeVisible();
    await lifecycleState(page, adapter, false); await refresh(page, adapter);
    await expect(completedNotice(page, action)).toHaveCount(0);
    await expect(uncertainGuidance(page, action)).toBeVisible();
    await lifecycleState(page, adapter, false);
    await adapter.reload(); await lifecycleState(page, adapter, false);
    expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1);
  }, false, action);
}
async function committedLoss(page: Page, action: Exclude<Action, 'archive'>) {
  await scenario(page, 'lost', async adapter => {
    await lifecycleClick(page, adapter, 'selected'); await waitPosts(page, adapter, 1);
    const evidence = await capture(page, adapter, `${action}-committed-loss-before-ui-verdict`);
    expect(evidence.state.data).toEqual([adapter.initial[0], completedTenant(adapter.initial[1], action)]);
    exactPosts(adapter, [{ status: null, body: null, effects: 1 }]);
    await expect(completedNotice(page, action)).toHaveCount(0);
    await expect(uncertainGuidance(page, action)).toBeVisible();
    // An independent read above proves commit; only the explicit Refresh below
    // reconciles rendered state. It cannot establish original-request causality.
    await refresh(page, adapter); await lifecycleState(page, adapter, true);
    await expect(completedNotice(page, action)).toHaveCount(0);
    await expect(uncertainGuidance(page, action)).toBeVisible();
    await adapter.reload(); await lifecycleState(page, adapter, true);
    await expect(completedNotice(page, action)).toHaveCount(0);
    expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1);
  }, false, action);
}

test.describe('Tenant archive browser response custody', () => {
  test.skip(!mockMode, 'Finite local browser model; native/provider acceptance remains separate.');
  test.setTimeout(90000);
  test('requires exact tenant confirmation and archives only that tenant with reload and mobile action reachability', async ({ page }) => {
    await scenario(page, 'positive', async adapter => {
      await prompt(page, adapter, null); await prompt(page, adapter, 'aurora-fixture');
      expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(0);
      expect((await adapter.read()).data).toEqual(adapter.initial);
      await page.getByLabel('Search', { exact: true }).fill('boreal');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(target(page, A)).toHaveCount(0); await expect(target(page, B)).toBeVisible();
      await refresh(page, adapter); await expect(target(page, A)).toHaveCount(0);
      await prompt(page, adapter, 'boreal-fixture'); await waitPosts(page, adapter, 1);
      await expect(archivedNotice(page)).toBeVisible(); await settled(page, adapter);
      expect(adapter.ledger.find(row => row.method === 'POST')).toMatchObject({ status: 201, body: JSON.stringify({ id: B, archived: true }), effects: 1, delivered: true });
      await adapter.reload(); await settled(page, adapter); await expect(target(page, A)).toBeVisible();
      expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1);
      await capture(page, adapter, 'positive-readback-before-layout'); await actionLayout(page);
    });
  });
  test('does not confirm archive when the authoritative successful response explicitly reports archived false', async ({ page }) => {
    await scenario(page, 'blocked', async adapter => {
      await prompt(page, adapter, 'boreal-fixture'); await waitPosts(page, adapter, 1);
      const evidence = await capture(page, adapter, 'blocked-ack-before-ui-verdict');
      expect(evidence.state.data).toEqual(adapter.initial);
      expect(JSON.parse(adapter.ledger.find(row => row.method === 'POST')!.body!)).toEqual({ id: B, archived: false });
      // Assert incorrect completion first, before prescribing actionable wording.
      await expect(archivedNotice(page)).toHaveCount(0);
      await expect(page.getByText(/not archived|could not archive|unable to archive|archive.*not complete|archive.*unconfirmed/i).first()).toBeVisible();
      await expect(target(page, B)).toContainText('ACTIVE'); await refresh(page, adapter);
      await adapter.reload(); expect((await adapter.read()).data).toEqual(adapter.initial);
      expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1);
    });
  });
  test('preserves a refused archive and requires a fresh explicit confirmation before the successful retry', async ({ page }) => {
    await scenario(page, 'refusal', async adapter => {
      await prompt(page, adapter, 'boreal-fixture'); await waitPosts(page, adapter, 1);
      await expect(page.getByText(REFUSAL, { exact: true })).toBeVisible(); await expect(archivedNotice(page)).toHaveCount(0);
      expect((await adapter.read()).data).toEqual(adapter.initial);
      await prompt(page, adapter, null); expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1);
      await prompt(page, adapter, 'boreal-fixture'); await waitPosts(page, adapter, 2);
      await expect(archivedNotice(page)).toBeVisible(); await settled(page, adapter);
      await adapter.reload(); await settled(page, adapter);
      expect(adapter.ledger.filter(row => row.method === 'POST').map(row => row.status)).toEqual([403, 201]);
    });
  });
  test('reconciles malformed and lost committed archive responses by explicit reads without a second mutation', async ({ page }) => {
    for (const mode of ['malformed', 'lost'] as const) {
      await test.step(mode, async () => {
        await scenario(page, mode, async adapter => {
          await prompt(page, adapter, 'boreal-fixture'); await waitPosts(page, adapter, 1);
          const evidence = await capture(page, adapter, 'uncertain-ack-before-ui-verdict');
          expect(evidence.state.data).toEqual([adapter.initial[0], { ...adapter.initial[1], status: 'CANCELLED', deletedAt: ARCHIVED_AT }]);
          // Soft only so the same named case retains BOTH malformed and actual
          // connection-loss observations; any incorrect completion still fails it.
          await expect.soft(archivedNotice(page)).toHaveCount(0);
          await expect.soft(page.getByText(/could not.*verif|unable to reach|not confirmed|unconfirmed|could not archive|unable to archive/i).first()).toBeVisible();
          await refresh(page, adapter); await settled(page, adapter);
          await adapter.reload(); await settled(page, adapter);
          expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1);
          expect(adapter.ledger.filter(row => row.method === 'POST')[0]).toMatchObject({
            status: mode === 'lost' ? null : 201, body: mode === 'lost' ? null : '{"id":', effects: 1,
          });
        }, mode === 'lost');
      });
    }
  });
});


test.describe('Tenant lifecycle sibling browser response custody', () => {
  test.skip(!mockMode, 'Finite local browser model; native/provider acceptance remains separate.');
  test.setTimeout(60000);
  test('suspend: refusal then explicit confirmed success and reload', async ({ page }) => {
    await refusedThenSuccessful(page, 'suspend');
  });
  test('suspend: wrong-target successful acknowledgement', async ({ page }) => {
    await invalidAcknowledgement(page, 'suspend', 'wrong-target', 'selected');
  });
  test('suspend: wrong-result successful acknowledgement', async ({ page }) => {
    await invalidAcknowledgement(page, 'suspend', 'wrong-result', 'directory');
  });
  test('suspend: committed response loss followed by read-only reconciliation', async ({ page }) => {
    await committedLoss(page, 'suspend');
  });
  test('activate: refusal then explicit confirmed success and reload', async ({ page }) => {
    await refusedThenSuccessful(page, 'activate');
  });
  test('activate: wrong-target successful acknowledgement', async ({ page }) => {
    await invalidAcknowledgement(page, 'activate', 'wrong-target', 'selected');
  });
  test('activate: wrong-result successful acknowledgement', async ({ page }) => {
    await invalidAcknowledgement(page, 'activate', 'wrong-result', 'directory');
  });
  test('activate: committed response loss followed by read-only reconciliation', async ({ page }) => {
    await committedLoss(page, 'activate');
  });
  test('restore: refusal then explicit confirmed success and reload', async ({ page }) => {
    await refusedThenSuccessful(page, 'restore');
  });
  test('restore: wrong-target successful acknowledgement', async ({ page }) => {
    await invalidAcknowledgement(page, 'restore', 'wrong-target', 'selected');
  });
  test('restore: wrong-result successful acknowledgement', async ({ page }) => {
    await invalidAcknowledgement(page, 'restore', 'wrong-result', 'directory');
  });
  test('restore: committed response loss followed by read-only reconciliation', async ({ page }) => {
    await committedLoss(page, 'restore');
  });
  test('archive: wrong-target successful acknowledgement', async ({ page }) => {
    await invalidAcknowledgement(page, 'archive', 'wrong-target', 'selected');
  });
});
