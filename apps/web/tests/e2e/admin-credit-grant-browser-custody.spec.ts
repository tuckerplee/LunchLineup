import { createHash } from 'node:crypto';
import type { Dialog, Response } from '@playwright/test';
import { expect, test, type Page, type Route } from './qa-isolation-fixture';
import { loginAsSeedSuperAdmin, runFullStack } from './support';

// Finite per-page browser-route model. No native wallet, debt, database audit,
// production authority, provider delivery or reload-durability claim.
const mockMode = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const ROOT = '/api/v2/admin/credits', GRANT = ROOT + '/grant';
const QUERY = '?tenantLimit=50&historyLimit=50';
const A = '81000000-0000-4000-8000-000000000001';
const B = '81000000-0000-4000-8000-000000000002';
const REASON = 'Reviewed service correction for Boreal';
const REFUSED = 'This controlled credit grant was refused.';
const AMBIGUOUS = 'The credit grant response is unavailable. Retry the same request.';
const UNAVAILABLE_UI = 'The service is temporarily unavailable. Please try again.';
const INVALID_ACK_UI = 'The credit grant response could not be verified. Retry the unchanged grant.';
const payload = { tenantId: B, amount: 25, reason: REASON };
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Tenant = { id: string; name: string; slug: string; planTier: string; usageCredits: number; creditDebt: number };
type History = { id: string; amount: number; reason: string; createdAt: string; tenant: Pick<Tenant, 'id' | 'name' | 'slug'> | null };
type Pagination = { limit: 50; maxLimit: 200; returned: number; hasMore: false; nextCursor: null;
  window: { startDate: null; endDate: null } };
type Snapshot = { tenants: Tenant[]; history: History[]; tenantPagination: Pagination; historyPagination: Pagination };
const pagination = (returned: number): Pagination => ({ limit: 50, maxLimit: 200, returned, hasMore: false,
  nextCursor: null, window: { startDate: null, endDate: null } });
type Row = { sequence: number; method: string; url: string; probe: boolean; requestBody: string | null;
  key: string | null; status: number; body: string; responseSha256: string; effects: number; replay: boolean };
type Mode = 'positive' | 'refusal' | 'ambiguous' | 'malformed';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => undefined); // A later bounded waiter still observes rejection.
  return { promise, resolve, reject };
}
async function bounded<T>(pending: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
type Receipt = { sequence: number; url: string; key: string | null; requestSha256: string | null;
  status: number | null; bodyBase64: string | null; complete: boolean; error: string | null };
type ObservedWindow = Window & { __creditBodies?: { receipts: Receipt[]; errors: string[] } };

async function observeBodies(page: Page) {
  await page.addInitScript(({ path }) => {
    const observer = { receipts: [] as Receipt[], errors: [] as string[] };
    (window as ObservedWindow).__creditBodies = observer;
    const original = window.fetch.bind(window); let sequence = 0;
    window.fetch = (input, init) => {
      const pending = original(input, init);
      try {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), location.href);
        if (url.origin === location.origin && url.pathname === path
          && (init?.method ?? request?.method ?? 'GET').toUpperCase() === 'POST') {
          if (observer.receipts.length >= 12) throw new Error('Credit observer receipt bound exceeded');
          const receipt: Receipt = { sequence: ++sequence, url: url.href,
            key: new Headers(init?.headers ?? request?.headers).get('idempotency-key'),
            requestSha256: null, status: null, bodyBase64: null, complete: false, error: null };
          observer.receipts.push(receipt);
          const body = init?.body;
          void pending.then(async response => {
            receipt.status = response.status;
            const clone = response.clone();
            if (typeof body !== 'string') throw new Error('Expected actual serialized grant request');
            const [digest, buffer] = await Promise.all([
              crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)), clone.arrayBuffer(),
            ]);
            receipt.requestSha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
            receipt.bodyBase64 = btoa(Array.from(new Uint8Array(buffer), n => String.fromCharCode(n)).join(''));
          }).catch(error => { receipt.error = String(error); }).finally(() => { receipt.complete = true; });
        }
      } catch (error) { observer.errors.push(String(error)); }
      return pending; // Identical native Promise/Response; only clone is observed.
    };
  }, { path: GRANT });
}

async function install(page: Page, mode: Mode) {
  // Zero-debt fixture only. Real debt-first settlement can make wallet + amount
  // an invalid projection; this fixture does not qualify that separate case.
  const tenants: Tenant[] = [
    { id: A, name: 'Aurora Diner', slug: 'aurora-fixture', planTier: 'GROWTH', usageCredits: 120, creditDebt: 0 },
    { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture', planTier: 'STARTER', usageCredits: 40, creditDebt: 0 },
  ];
  const initial = copy(tenants), history: History[] = [], ledger: Row[] = [];
  const errors: unknown[] = [], settlements: Promise<void>[] = [];
  const activeRoutes = new Set<Route>();
  const accepted = new Map<string, { fingerprint: string; newBalance: number }>();
  const observed = deferred<Row>(), release = deferred<void>();
  let posts = 0, effects = 0, closing = false;
  const snapshot = (): Snapshot => copy({ tenants, history,
    tenantPagination: pagination(tenants.length), historyPagination: pagination(history.length) });
  async function run(route: Route) {
    try {
      if (closing) throw new Error('Credit route entered after closure');
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const probe = request.headers()['x-credit-fixture-probe'] === 'readback';
      if (ledger.length >= 80 || (request.postDataBuffer()?.length ?? 0) > 4096) throw new Error('Credit request bound exceeded');
      let status: number, value: unknown, replay = false;
      const requestBody = request.postData(), key = request.headers()['idempotency-key'] ?? null;
      if (method === 'GET' && url.pathname === ROOT) {
        const query = [...url.searchParams.entries()].sort();
        if (JSON.stringify(query) !== JSON.stringify([['historyLimit', '50'], ['tenantLimit', '50']])) {
          throw new Error('Unexpected credit-list query');
        }
        if (requestBody !== null || key !== null) throw new Error('Unexpected read mutation fields');
        status = 200; value = snapshot();
      } else if (method === 'POST' && url.pathname === GRANT && url.search === '' && !probe) {
        posts += 1;
        if (!key || !/^[\x21-\x7e]{1,200}$/.test(key) || key.includes(REASON)) throw new Error('Invalid opaque grant key');
        if (!request.headers()['content-type']?.startsWith('application/json') || !request.headers()['x-csrf-token']) {
          throw new Error('Missing actual JSON/CSRF grant headers');
        }
        if (requestBody === null) throw new Error('Missing grant body');
        const body = JSON.parse(requestBody) as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['amount', 'reason', 'tenantId'])
          || JSON.stringify(body) !== JSON.stringify(payload)) throw new Error('Unexpected exact grant payload');
        const fingerprint = JSON.stringify(body), previous = accepted.get(key);
        if (mode === 'refusal' && posts === 1) {
          status = 422; value = { message: REFUSED };
        } else {
          if (previous && previous.fingerprint !== fingerprint) throw new Error('Unmodeled key/payload conflict');
          if (previous) { replay = true; }
          else {
            const tenant = tenants.find(item => item.id === B)!;
            tenant.usageCredits += payload.amount; effects += 1;
            history.push({ id: '82000000-0000-4000-8000-000000000001', amount: payload.amount,
              reason: payload.reason, createdAt: '2026-10-06T12:00:00.000Z', tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
            accepted.set(key, { fingerprint, newBalance: tenant.usageCredits });
          }
          status = mode === 'ambiguous' && posts === 1 ? 502 : 201;
          value = status === 502 ? { message: AMBIGUOUS } : { success: true, newBalance: accepted.get(key)!.newBalance };
        }
      } else throw new Error('Unexpected credit method/path');
      const body = mode === 'malformed' && method === 'POST' && posts === 1
        ? '{"success":' : JSON.stringify(value);
      const row: Row = { sequence: ledger.length + 1, method, url: url.href, probe, requestBody, key, status, body,
        responseSha256: createHash('sha256').update(body).digest('hex'), effects, replay };
      ledger.push(row);
      if (method === 'POST' && posts === 1 && mode === 'positive') {
        observed.resolve(row); await bounded(release.promise, 'held grant release', 8000);
      }
      await route.fulfill({ status, headers: { 'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' }, body });
    } catch (error) {
      errors.push(error); observed.reject(error);
      try { await bounded(route.abort('failed'), 'failed route abort', 2000); } catch (abortError) { errors.push(abortError); }
    } finally { activeRoutes.delete(route); }
  }
  const handler = (route: Route) => {
    activeRoutes.add(route); const work = run(route); settlements.push(work); return work;
  };
  await page.route('**/api/v2/admin/credits**', handler);
  return { initial, ledger, errors, observed: observed.promise, release: () => release.resolve(),
    async read() {
      const response = await bounded(page.evaluate(async ({ path }) => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
        try {
          const received = await fetch(path, { headers: { 'x-credit-fixture-probe': 'readback' }, cache: 'no-store', signal: controller.signal });
          return { status: received.status, body: await received.text() };
        } finally { clearTimeout(timer); }
      }, { path: ROOT + QUERY }), 'independent credit GET', 6000);
      expect(response.status).toBe(200);
      const row = ledger.filter(item => item.probe).at(-1)!;
      expect(row.probe).toBe(true); expect(response.body).toBe(row.body);
      return JSON.parse(response.body) as Snapshot;
    },
    async close() {
      closing = true; release.resolve(); observed.reject(new Error('Credit adapter closed before first POST observation'));
      try { await bounded(Promise.all(settlements), 'credit route drain'); } catch (error) { errors.push(error); }
      if (activeRoutes.size) {
        errors.push(new Error(`${activeRoutes.size} credit routes remained active after drain`));
        try {
          const aborted = await bounded(Promise.allSettled([...activeRoutes].map(route => route.abort('failed'))), 'active route aborts', 2000);
          for (const result of aborted) if (result.status === 'rejected') errors.push(result.reason);
        } catch (error) { errors.push(error); }
      }
      try { await bounded(page.unroute('**/api/v2/admin/credits**', handler), 'exact credit handler unroute', 3000); }
      catch (error) { errors.push(error); }
      try { await bounded(Promise.all(settlements), 'final credit route drain', 3000); } catch (error) { errors.push(error); }
      if (activeRoutes.size) errors.push(new Error(`${activeRoutes.size} credit handlers unresolved at custody attachment`));
      if (errors.length) throw new AggregateError(errors, 'Credit adapter transport/cleanup failure');
    },
  };
}
type Adapter = Awaited<ReturnType<typeof install>>;
const writes = (adapter: Adapter) => adapter.ledger.filter(row => row.method === 'POST');
const tenant = (page: Page) => page.getByRole('combobox', { name: 'Tenant', exact: true });
const amount = (page: Page) => page.getByRole('spinbutton', { name: 'Amount', exact: true });
const reason = (page: Page) => page.getByRole('textbox', { name: 'Reason', exact: true });
const submit = (page: Page) => page.getByRole('button', { name: 'Grant Credits', exact: true });
const balanceRow = (page: Page, name: string) => page.getByRole('article', { name: 'Tenant credit balances table', exact: true })
  .getByRole('row').filter({ hasText: name });
function responseForGrant(page: Page) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === GRANT && response.request().method() === 'POST');
  void pending.catch(() => undefined); return pending;
}
async function confirm(page: Page, accept: boolean) {
  const completed = deferred<void>(), failures: unknown[] = [];
  const handler = async (dialog: Dialog) => {
    try {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toBe('Grant 25 credits to Boreal Kitchen? Estimated debt repayment: 0 credits. Estimated spendable balance: 65 credits. Estimated remaining debt: 0 credits. Estimates use loaded balances; the server settles against current balances.');
      if (accept) await dialog.accept(); else await dialog.dismiss();
    } catch (error) { failures.push(error); await dialog.dismiss().catch(() => undefined); }
    finally { completed.resolve(); }
  };
  page.once('dialog', handler);
  try { await bounded(Promise.all([submit(page).click({ timeout: 5000 }), completed.promise]), 'credit confirmation click/dialog', 6000); }
  finally { page.off('dialog', handler); }
  expect(failures).toEqual([]);
}
async function exactDelivery(page: Page, adapter: Adapter, response: Response) {
  const row = writes(adapter).at(-1)!;
  expect(response.url()).toBe(row.url); expect(response.status()).toBe(row.status);
  expect(response.request().postData()).toBe(row.requestBody);
  expect(response.request().headers()['idempotency-key']).toBe(row.key);
  expect(JSON.parse(row.requestBody!)).toEqual(payload);
  const sequence = writes(adapter).indexOf(row) + 1;
  const expected = { sequence, url: row.url, key: row.key,
    requestSha256: createHash('sha256').update(row.requestBody!).digest('hex'), status: row.status,
    bodyBase64: Buffer.from(row.body).toString('base64'), complete: true, error: null };
  let observed: unknown;
  try {
    await expect.poll(async () => {
      observed = await page.evaluate(sequence => {
        const observer = (window as ObservedWindow).__creditBodies;
        if (!observer) throw new Error('Credit body observer missing');
        return { receipts: observer.receipts.filter(item => item.sequence === sequence), errors: observer.errors };
      }, sequence);
      return observed;
    }).toEqual({ receipts: [expected], errors: [] });
  } finally {
    await test.info().attach(`credit-browser-response-${sequence}`, { contentType: 'application/json',
      body: JSON.stringify({ expected, observed, scope: 'Native fetch clone decoded bytes; no CDP retention claim.' }) });
  }
  return row;
}
async function fill(page: Page) {
  await tenant(page).selectOption(B); await amount(page).fill('25'); await reason(page).fill(REASON);
  await expect(tenant(page)).toHaveValue(B); await expect(amount(page)).toHaveValue('25'); await expect(reason(page)).toHaveValue(REASON);
  await expect(page.getByText('Estimated spendable balance:', { exact: false })).toContainText('65');
}
async function unchanged(page: Page, adapter: Adapter) {
  const state = await adapter.read(); expect(state.tenants).toEqual(adapter.initial); expect(state.history).toEqual([]);
  await expect(page.getByText('Credits granted.', { exact: true })).toHaveCount(0);
  await expect(tenant(page)).toHaveValue(B); await expect(amount(page)).toHaveValue('25'); await expect(reason(page)).toHaveValue(REASON);
}
async function adminShellWitness(page: Page, width: number, label: string) {
  const toggle = page.getByRole('button', { name: 'Admin navigation', exact: true });
  const navigation = page.getByRole('navigation', { name: 'Admin navigation', exact: true });
  const expectedLinks = [
    { text: 'Calendar', href: '/dashboard/scheduling' },
    { text: 'Team Dashboard', href: '/dashboard' },
    { text: 'Lunch & Breaks', href: '/dashboard/lunch-breaks' },
    { text: 'Staff', href: '/dashboard/staff' },
    { text: 'Locations', href: '/dashboard/locations' },
    { text: 'Admin Overview', href: '/admin' },
    { text: 'Tenants', href: '/admin/tenants' },
    { text: 'Users', href: '/admin/users' },
    { text: 'Credits', href: '/admin/credits' },
    { text: 'Plans', href: '/admin/plans' },
  ];
  if (width <= 1024) {
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(navigation).toBeHidden();
    await toggle.focus();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(navigation).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-controls', (await navigation.getAttribute('id'))!);
  } else {
    await expect(toggle).toBeHidden();
    await expect(navigation).toBeVisible();
  }
  await test.info().attach(label + '-admin-navigation', { contentType: 'image/png',
    body: await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 5000 }) });
  const links = await navigation.getByRole('link').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { text: node.textContent?.trim(), href: node.getAttribute('href'),
      current: node.getAttribute('aria-current'), x: rect.x, width: rect.width, height: rect.height };
  }));
  const documentWidth = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
  const toggleBox = width <= 1024 ? await toggle.boundingBox() : null;
  const signOut = page.locator('.workspace-topbar').getByRole('link', { name: 'Sign out', exact: true });
  const signOutBox = width <= 1024 ? await signOut.boundingBox() : null;
  await test.info().attach(label + '-admin-navigation-geometry', { contentType: 'application/json',
    body: JSON.stringify({ width, documentWidth, links, toggleBox, signOutBox }) });
  expect(links.map(({ text, href }) => ({ text, href }))).toEqual(expectedLinks);
  expect(links.filter(link => link.current === 'page').map(link => link.href)).toEqual(['/admin/credits']);
  expect(documentWidth).toBeLessThanOrEqual(width + 1);
  for (const link of links) {
    expect(link.x, link.text).toBeGreaterThanOrEqual(-1);
    expect(link.x + link.width, link.text).toBeLessThanOrEqual(width + 1);
    if (width <= 1024) expect(link.height, link.text + ' touch target').toBeGreaterThanOrEqual(44);
  }
  if (width <= 1024) {
    await expect(signOut).toBeVisible();
    await expect(signOut).toHaveAttribute('href', '/auth/logout');
    for (const box of [toggleBox, signOutBox]) {
      expect(box).not.toBeNull();
      if (!box) throw new Error('Admin mobile control has no geometry');
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    const firstLink = navigation.getByRole('link', { name: 'Calendar', exact: true });
    await firstLink.focus();
    await firstLink.press('Escape');
    await expect(navigation).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await toggle.press('Space');
    await expect(navigation).toBeVisible();
    await navigation.getByRole('link', { name: 'Credits', exact: true }).click();
    await expect(navigation).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(page).toHaveURL(/\/admin\/credits(?:[?#].*)?$/);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  if (width > 1024) {
    const sidebar = page.getByRole('complementary', { name: 'Admin sidebar', exact: true });
    const desktopSignOut = sidebar.getByRole('link', { name: 'Sign out', exact: true });
    const scrollRegion = sidebar.locator('.workspace-sidebar-inner');
    const before = await desktopSignOut.boundingBox();
    await expect(desktopSignOut).toHaveAttribute('href', '/auth/logout');
    await desktopSignOut.scrollIntoViewIfNeeded({ timeout: 5000 });
    const after = await desktopSignOut.boundingBox();
    const scrollState = await scrollRegion.evaluate(node => ({
      scrollTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
      documentScrollY: window.scrollY, viewportHeight: window.innerHeight,
    }));
    await test.info().attach(label + '-desktop-signout-geometry', { contentType: 'application/json',
      body: JSON.stringify({ width, before, after, scrollState }) });
    await test.info().attach(label + '-desktop-signout-viewport', { contentType: 'image/png',
      body: await page.screenshot({ fullPage: false, animations: 'disabled', timeout: 5000 }) });
    await expect(desktopSignOut).toBeInViewport({ ratio: 1, timeout: 3000 });
    await desktopSignOut.click({ trial: true, timeout: 5000 });
    await scrollRegion.evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
  }
}

// This witness runs before navigation/row actions can scroll the first viewport.
async function summaryFirstViewportWitness(page: Page, width: number, artifactLabel: string) {
  if (width > 414) return;
  const summary = page.getByRole('region', { name: 'Loaded credit summary', exact: true });
  await expect(summary.getByRole('article')).toHaveCount(5);
  const expected = [
    ['Loaded balances', '2'], ['Loaded credits', '160'], ['Loaded ledger rows', '0'],
    ['Largest loaded balance', '120'], ['positive wallet rows loaded', '0'],
  ] as const;
  const witnesses = expected.flatMap(([label, value]) => {
    const card = summary.getByRole('article').filter({ has: page.getByText(label, { exact: true }) });
    return [{ name: label + ' label', locator: card.getByText(label, { exact: true }) },
      { name: label + ' value', locator: card.getByText(value, { exact: true }) }];
  });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  const summaryBox = await summary.boundingBox();
  const geometry = [];
  for (const witness of witnesses) {
    await expect(witness.locator).toHaveCount(1);
    geometry.push({ name: witness.name, ...await witness.locator.evaluate(node => {
      const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
      const range = document.createRange(); range.selectNodeContents(node);
      const textRects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0).map(box);
      const ancestors = [];
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        ancestors.push({ opacity: Number(style.opacity), visibility: style.visibility,
          clipX: /^(auto|scroll|hidden|clip)$/.test(style.overflowX), clipY: /^(auto|scroll|hidden|clip)$/.test(style.overflowY),
          // Use the actual scrollport inside borders, not the larger border box.
          scrollport: { x: bounds.x + parent.clientLeft, y: bounds.y + parent.clientTop,
            width: parent.clientWidth, height: parent.clientHeight } });
      }
      return { nodeBox: box(node.getBoundingClientRect()), text: node.textContent, textRects, ancestors };
    }) });
  }
  await test.info().attach(artifactLabel + '-summary-first-viewport-geometry', { contentType: 'application/json',
    body: JSON.stringify({ viewport, summaryBox, budget: viewport.height * 0.25, expected, geometry }) });
  expect(viewport.width).toBe(width); expect(viewport.x).toBe(0); expect(viewport.y).toBe(0);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(width + 1);
  expect(summaryBox).not.toBeNull();
  // A budget for this known two-tenant fixture; no CSS height, clipping or value hiding.
  expect(summaryBox!.height).toBeLessThanOrEqual(viewport.height * 0.25);
  for (const [label] of expected) {
    const card = summary.getByRole('article').filter({ has: page.getByText(label, { exact: true }) });
    await expect(card).toHaveCount(1); await expect(card).toBeInViewport({ ratio: 1 });
  }
  for (let index = 0; index < witnesses.length; index += 1) {
    const witness = witnesses[index], measured = geometry[index];
    await expect(witness.locator).toBeVisible(); await expect(witness.locator).toBeInViewport({ ratio: 1 });
    expect(measured.textRects.length, witness.name + ' has rendered text').toBeGreaterThan(0);
    for (const ancestor of measured.ancestors) {
      expect(ancestor.opacity, witness.name + ' is not transparent').toBeGreaterThan(0);
      expect(ancestor.visibility, witness.name + ' is not hidden').toBe('visible');
    }
    for (const rect of measured.textRects) {
      expect(rect.x).toBeGreaterThanOrEqual(measured.nodeBox.x - 1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(measured.nodeBox.x + measured.nodeBox.width + 1);
      expect(rect.y).toBeGreaterThanOrEqual(measured.nodeBox.y - 1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(measured.nodeBox.y + measured.nodeBox.height + 1);
      expect(rect.x).toBeGreaterThanOrEqual(-1); expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(rect.y).toBeGreaterThanOrEqual(-1); expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 1);
      for (const ancestor of measured.ancestors) {
        const clip = ancestor.scrollport;
        if (ancestor.clipX) { expect(rect.x).toBeGreaterThanOrEqual(clip.x - 1); expect(rect.x + rect.width).toBeLessThanOrEqual(clip.x + clip.width + 1); }
        if (ancestor.clipY) { expect(rect.y).toBeGreaterThanOrEqual(clip.y - 1); expect(rect.y + rect.height).toBeLessThanOrEqual(clip.y + clip.height + 1); }
      }
    }
  }
  await expect(page.getByRole('heading', { name: 'Tenant Balances', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(balanceRow(page, 'Aurora Diner').getByText('Aurora Diner', { exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({ x: 0, y: 0 });
}

async function layoutWitness(page: Page) {
  const originalViewport = page.viewportSize();
  expect(originalViewport, 'canonical projects have an explicit viewport').not.toBeNull();
  if (!originalViewport) throw new Error('Credit layout witness requires the canonical viewport');
  const widths = test.info().project.name === 'chromium' ? [320, 375, 414, 768, 1280] : [originalViewport.width];
  const balances = page.getByRole('article', { name: 'Tenant credit balances table', exact: true });
  const grant = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Grant Credits', exact: true }) });
  const controls = [
    { name: 'tenant', locator: tenant(page) }, { name: 'amount', locator: amount(page) },
    { name: 'reason', locator: reason(page) }, { name: 'grant', locator: submit(page) },
    { name: 'search-input', locator: page.getByRole('textbox', { name: 'Tenant search', exact: true }) },
    { name: 'search-button', locator: page.getByRole('button', { name: 'Search', exact: true }) },
    { name: 'refresh', locator: page.getByRole('button', { name: 'Refresh', exact: true }) },
  ];
  const failures: unknown[] = [];
  try {
    for (const width of widths) {
      const label = `credit-populated-layout-${test.info().project.name.replace(/\W+/g, '-').toLowerCase()}-${width}px`;
      try {
        if (test.info().project.name === 'chromium') await page.setViewportSize({ width, height: originalViewport.height });
        await expect(balances).toBeVisible(); await expect(grant).toBeVisible();
        // Each width begins at the real first viewport; prior tenant actions can scroll the page.
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => ({ x: scrollX, y: scrollY })), { timeout: 3000 }).toEqual({ x: 0, y: 0 });
        await test.info().attach(label + '-first-viewport', { contentType: 'image/png',
          body: await page.screenshot({ fullPage: false, animations: 'disabled', timeout: 5000 }) });
        // Retain actual pixels before checking geometry, including a failing layout.
        await test.info().attach(label, { contentType: 'image/png',
          body: await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 5000 }) });
        const pageSize = await page.evaluate(() => ({ width: innerWidth,
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
        const balanceBox = await balances.boundingBox(), grantBox = await grant.boundingBox();
        const controlBoxes = await Promise.all(controls.map(async control => ({ name: control.name,
          box: await control.locator.boundingBox(), count: await control.locator.count() })));
        await test.info().attach(label + '-geometry', { contentType: 'application/json',
          body: JSON.stringify({ pageSize, balanceBox, grantBox, controlBoxes,
            scope: 'Populated panels and external form controls; intentional internal table scrolling is allowed.' }) });
        await summaryFirstViewportWitness(page, width, label);
        await adminShellWitness(page, width, label);
        expect(pageSize.width).toBe(width); expect(pageSize.scrollWidth).toBeLessThanOrEqual(width + 1);
        expect(balanceBox).not.toBeNull(); expect(grantBox).not.toBeNull();
        if (!balanceBox || !grantBox) throw new Error('Populated credit panels lack measured rectangles');
        for (const box of [balanceBox, grantBox]) {
          expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
          expect(box.width).toBeGreaterThanOrEqual(Math.min(260, width * 0.8));
        }
        if (width <= 900) {
          expect(grantBox.y).toBeGreaterThanOrEqual(balanceBox.y + balanceBox.height - 1);
          expect(Math.abs(balanceBox.x - grantBox.x)).toBeLessThanOrEqual(2);
          expect(Math.abs(balanceBox.width - grantBox.width)).toBeLessThanOrEqual(2);
        } else {
          expect(grantBox.x).toBeGreaterThanOrEqual(balanceBox.x + balanceBox.width - 1);
          expect(Math.abs(balanceBox.y - grantBox.y)).toBeLessThanOrEqual(2);
        }
        if (width <= 768) {
          for (const name of ['Aurora Diner', 'Boreal Kitchen']) {
            const row = balanceRow(page, name);
            const wallet = row.getByRole('cell').nth(2);
            const action = row.getByRole('button', { name: 'Grant to this tenant', exact: true });
            for (const element of [wallet, action]) {
              const box = await element.boundingBox();
              expect(box, name + ' mobile wallet/action rectangle').not.toBeNull();
              if (!box) throw new Error(name + ' missing mobile wallet/action');
              expect(box.x).toBeGreaterThanOrEqual(-1);
              expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
            }
            const actionBox = await action.boundingBox();
            expect(actionBox!.height).toBeGreaterThanOrEqual(44);
            expect(actionBox!.width).toBeGreaterThanOrEqual(44);
          }
          await balanceRow(page, 'Aurora Diner').getByRole('button', { name: 'Grant to this tenant', exact: true }).click();
          await expect(tenant(page)).toHaveValue(A);
          await balanceRow(page, 'Boreal Kitchen').getByRole('button', { name: 'Grant to this tenant', exact: true }).click();
          await expect(tenant(page)).toHaveValue(B);
          await expect(amount(page)).toHaveValue('25');
          await expect(reason(page)).toHaveValue(REASON);
        }
        for (const control of controlBoxes) {
          expect(control.count, control.name + ' is unique').toBe(1);
          expect(control.box, control.name + ' has a rendered rectangle').not.toBeNull();
          if (!control.box) throw new Error(control.name + ' has no rectangle');
          expect(control.box.width, control.name + ' is usable').toBeGreaterThan(20);
          if (width <= 768) {
            expect(control.box.width, control.name + ' meets mobile touch width').toBeGreaterThanOrEqual(44);
            expect(control.box.height, control.name + ' meets mobile touch height').toBeGreaterThanOrEqual(44);
          }
          expect(control.box.x, control.name + ' fits left edge').toBeGreaterThanOrEqual(-1);
          expect(control.box.x + control.box.width, control.name + ' fits right edge').toBeLessThanOrEqual(width + 1);
        }
      } catch (error) {
        failures.push(error);
        try { await test.info().attach(label + '-failure', { contentType: 'image/png',
          body: await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 3000 }) }); }
        catch (screenshotError) { failures.push(screenshotError); }
        break; // Preserve first failing width; do not spend the remaining case budget on repeats.
      }
    }
  } finally {
    try { await page.setViewportSize(originalViewport); }
    catch (restoreError) { failures.push(restoreError); }
  }
  if (failures.length) throw new AggregateError(failures, 'Credit populated layout or viewport restoration failed');
}

async function settled(page: Page, adapter: Adapter) {
  await expect(page.getByText('Credits granted.', { exact: true })).toBeVisible();
  await expect(balanceRow(page, 'Boreal Kitchen').getByRole('cell').nth(2).getByText('65', { exact: true })).toBeVisible();
  await balanceRow(page, 'Boreal Kitchen').getByRole('cell').nth(2).getByText('65', { exact: true }).scrollIntoViewIfNeeded({ timeout: 5000 });
  await expect(balanceRow(page, 'Boreal Kitchen').getByRole('cell').nth(2).getByText('65', { exact: true })).toBeInViewport();
  const state = await adapter.read();
  expect(state.tenants).toEqual(adapter.initial.map(row => row.id === B ? { ...row, usageCredits: 65 } : row));
  expect(state.history).toHaveLength(1);
  expect(state.history[0]).toMatchObject({ amount: 25, reason: REASON, tenant: { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture' } });
  const history = page.getByRole('article', { name: 'Credit transaction history table', exact: true });
  await expect(history.getByRole('row').filter({ hasText: REASON })).toHaveCount(1);
  await expect(history.getByRole('row').filter({ hasText: REASON })).toContainText('Boreal Kitchen');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible();
  await expect(balanceRow(page, 'Boreal Kitchen').getByRole('cell').nth(2).getByText('65', { exact: true })).toBeVisible();
  await balanceRow(page, 'Boreal Kitchen').getByRole('cell').nth(2).getByText('65', { exact: true }).scrollIntoViewIfNeeded({ timeout: 5000 });
  await expect(balanceRow(page, 'Boreal Kitchen').getByRole('cell').nth(2).getByText('65', { exact: true })).toBeInViewport();
  await expect(history.getByRole('row').filter({ hasText: REASON })).toHaveCount(1);
  expect(await adapter.read()).toEqual(state);
  expect(writes(adapter).every(row => row.effects <= 1)).toBe(true);
}

async function scenario(page: Page, mode: Mode, body: (adapter: Adapter) => Promise<void>) {
  const pageErrors: string[] = [], consoleErrors: Array<{ text: string; url: string }> = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url }); });
  await observeBodies(page);
  const adapter = await install(page, mode);
  const failures: unknown[] = [];
  try {
    await loginAsSeedSuperAdmin(page, '/admin/credits');
    await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible();
    await expect(tenant(page).getByRole('option')).toHaveCount(2);
    await body(adapter);
  } catch (error) { failures.push(error); }
  try { await adapter.close(); } catch (error) { failures.push(error); }
  try {
    const allowed = writes(adapter).filter(row => [422, 502].includes(row.status));
    const permitted = consoleErrors.filter(error => allowed.some(row => row.url === error.url
      && error.text === `Failed to load resource: the server responded with a status of ${row.status} (${row.status === 422 ? 'Unprocessable Entity' : 'Bad Gateway'})`));
    await test.info().attach('credit-route-model-custody', { contentType: 'application/json', body: JSON.stringify({
      scope: 'Finite local browser-route model only; no native persistence, audit, debt, authority or provider proof.',
      initial: adapter.initial, ledger: adapter.ledger, pageErrors, consoleErrors,
      adapterErrors: adapter.errors.map(String),
    }, null, 2) });
    expect(pageErrors).toEqual([]); expect(consoleErrors.filter(error => !permitted.includes(error))).toEqual([]);
    for (const row of allowed) expect(permitted.filter(error => error.url === row.url && error.text.includes(String(row.status))).length).toBeLessThanOrEqual(1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Credit browser case or evidence/cleanup failed');
}

test.describe('Admin credit grant browser custody', () => {
  test.skip(!mockMode, 'Controlled local model only; native credit grants require separately admitted isolated authority.');
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    expect((await page.request.post('/api/v1/__e2e/reset')).status()).toBe(200);
  });

  test('validates and cancels before explicitly granting once to the selected tenant', async ({ page }) => {
    await scenario(page, 'positive', async adapter => {
      await fill(page);
      await layoutWitness(page);
      await amount(page).fill('-1'); await submit(page).click();
      expect(await amount(page).evaluate(node => (node as HTMLInputElement).validity.valid)).toBe(false);
      expect(writes(adapter)).toHaveLength(0);
      await amount(page).fill('25'); await reason(page).fill(''); await submit(page).click();
      await expect(page.getByText('Reason is required.', { exact: true })).toBeVisible();
      expect(writes(adapter)).toHaveLength(0);
      await reason(page).fill(REASON); await confirm(page, false);
      await unchanged(page, adapter); expect(writes(adapter)).toHaveLength(0);
      const delivered = responseForGrant(page);
      try {
        await confirm(page, true); const captured = await bounded(adapter.observed, 'first credit POST observation', 6000);
        expect(captured.status).toBe(201); expect(captured.effects).toBe(1);
        await expect(page.getByRole('button', { name: 'Granting...', exact: true })).toBeDisabled();
        // Real keyboard activation during the pending write must not issue again.
        await reason(page).focus(); await reason(page).press('Enter');
        expect(writes(adapter)).toHaveLength(1);
      } finally { adapter.release(); }
      await exactDelivery(page, adapter, await delivered);
      await settled(page, adapter); expect(writes(adapter)).toHaveLength(1);
    });
  });

  test('retains a definitively refused grant and explicitly retries without changing its target or payload', async ({ page }) => {
    await scenario(page, 'refusal', async adapter => {
      await fill(page); const refused = responseForGrant(page); await confirm(page, true);
      const first = await exactDelivery(page, adapter, await refused);
      expect(first.status).toBe(422); expect(first.effects).toBe(0);
      await expect(page.getByText(REFUSED, { exact: true })).toBeVisible(); await unchanged(page, adapter);
      await expect(submit(page)).toBeEnabled();
      const recovered = responseForGrant(page); await confirm(page, true);
      const second = await exactDelivery(page, adapter, await recovered);
      expect(second.status).toBe(201); expect(second.key).toBe(first.key); expect(second.replay).toBe(false);
      await settled(page, adapter); expect(writes(adapter)).toHaveLength(2);
    });
  });

  test('recovers an ambiguous committed grant with the same key and one wallet effect after deliberate retry', async ({ page }) => {
    await scenario(page, 'ambiguous', async adapter => {
      await fill(page); const unknown = responseForGrant(page); await confirm(page, true);
      const first = await exactDelivery(page, adapter, await unknown);
      expect(first.status).toBe(502); expect(first.effects).toBe(1);
      // client-api intentionally replaces all 5xx messages; wire bytes remain
      // independently asserted above rather than mistaken for displayed copy.
      await expect(page.getByText(UNAVAILABLE_UI, { exact: true })).toBeVisible();
      await expect(page.getByText('Credits granted.', { exact: true })).toHaveCount(0);
      await expect(tenant(page)).toHaveValue(B); await expect(amount(page)).toHaveValue('25'); await expect(reason(page)).toHaveValue(REASON);
      const committed = await adapter.read();
      expect(committed.tenants.find(row => row.id === B)?.usageCredits).toBe(65);
      expect(committed.tenants.find(row => row.id === A)).toEqual(adapter.initial[0]); expect(committed.history).toHaveLength(1);
      expect(writes(adapter)).toHaveLength(1); await expect(submit(page)).toBeEnabled();
      const recovered = responseForGrant(page); await confirm(page, true);
      const second = await exactDelivery(page, adapter, await recovered);
      expect(second.status).toBe(201); expect(second.key).toBe(first.key); expect(second.replay).toBe(true);
      expect(second.requestBody).toBe(first.requestBody); expect(second.effects).toBe(1);
      await settled(page, adapter); expect(await adapter.read()).toEqual(committed);
      expect(writes(adapter)).toHaveLength(2);
    });
  });

  test('keeps a malformed successful acknowledgement unconfirmed and retries its committed grant with the same key', async ({ page }) => {
    await scenario(page, 'malformed', async adapter => {
      await fill(page); const unknown = responseForGrant(page); await confirm(page, true);
      const first = await exactDelivery(page, adapter, await unknown);
      expect(first.status).toBe(201); expect(first.body).toBe('{"success":'); expect(first.effects).toBe(1);
      // This is an intentionally strict prospective regression: current
      // writeJson catches invalid JSON as {} and incorrectly announces success.
      // Do not add expectedFailure or accept that false notice to obtain green.
      const committed = await adapter.read();
      // Wait only for submission to settle, not for desired future error copy.
      await expect(page.getByRole('button', { name: 'Granting...', exact: true })).toHaveCount(0);
      const actual = {
        notice: await page.getByText('Credits granted.', { exact: true }).allTextContents(),
        expectedRecoveryMessage: await page.getByText(INVALID_ACK_UI, { exact: true }).allTextContents(),
        tenantId: await tenant(page).inputValue(), amount: await amount(page).inputValue(), reason: await reason(page).inputValue(),
        visibleText: await page.locator('body').innerText({ timeout: 5000 }),
        committed, firstDelivered: first,
      };
      await test.info().attach('malformed-credit-ack-actual-ui-and-independent-state', {
        contentType: 'application/json', body: JSON.stringify(actual, null, 2),
      });
      // First safety oracle identifies actual false confirmation on old source.
      await expect(page.getByText('Credits granted.', { exact: true })).toHaveCount(0);
      await expect(page.getByText(INVALID_ACK_UI, { exact: true })).toBeVisible();
      await expect(tenant(page)).toHaveValue(B); await expect(amount(page)).toHaveValue('25'); await expect(reason(page)).toHaveValue(REASON);
      expect(committed.tenants.find(row => row.id === B)?.usageCredits).toBe(65);
      expect(committed.tenants.find(row => row.id === A)).toEqual(adapter.initial[0]); expect(committed.history).toHaveLength(1);
      expect(writes(adapter)).toHaveLength(1); await expect(submit(page)).toBeEnabled();
      const recovered = responseForGrant(page); await confirm(page, true);
      const second = await exactDelivery(page, adapter, await recovered);
      expect(second.status).toBe(201); expect(second.key).toBe(first.key); expect(second.replay).toBe(true);
      expect(second.requestBody).toBe(first.requestBody); expect(second.effects).toBe(1);
      await settled(page, adapter); expect(await adapter.read()).toEqual(committed);
      expect(writes(adapter)).toHaveLength(2);
    });
  });
});

// Read publication witnesses use actual controls and a finite, correctly sized
// 50-row page model. They do not qualify native pagination or financial storage.
type ReadRaceMode = 'stale-append' | 'late-grant' | 'concurrent';
type ReadRaceHold = 'tenants' | 'history' | 'grant';
type ReadRaceReceipt = { sequence: number; method: string; url: string; probe: boolean; key: string | null;
  requestBody: string | null; status: number | null; bodyBase64: string | null; complete: boolean;
  receivedAt: number | null; error: string | null };
type ReadRaceWindow = Window & { __creditReadRace?: { receipts: ReadRaceReceipt[]; errors: string[] } };
async function observeReadRaceBodies(page: Page) {
  await page.addInitScript(({ root, grant }) => {
    const observer = { receipts: [] as ReadRaceReceipt[], errors: [] as string[] };
    (window as ReadRaceWindow).__creditReadRace = observer;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const pending = original(input, init);
      try {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), location.href);
        if (url.origin === location.origin && [root, grant].includes(url.pathname)) {
          if (observer.receipts.length >= 40) throw new Error('Read-race receipt bound exceeded');
          const headers = new Headers(init?.headers ?? request?.headers);
          const receipt: ReadRaceReceipt = { sequence: observer.receipts.length + 1,
            method: (init?.method ?? request?.method ?? 'GET').toUpperCase(), url: url.href,
            probe: headers.get('x-credit-fixture-probe') === 'readback', key: headers.get('idempotency-key'),
            requestBody: typeof init?.body === 'string' ? init.body : null,
            status: null, bodyBase64: null, complete: false, receivedAt: null, error: null };
          observer.receipts.push(receipt);
          void pending.then(async response => {
            receipt.status = response.status;
            const bytes = new Uint8Array(await response.clone().arrayBuffer());
            receipt.bodyBase64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
            receipt.receivedAt = performance.now();
          }).catch(error => { receipt.error = String(error); }).finally(() => { receipt.complete = true; });
        }
      } catch (error) { observer.errors.push(String(error)); }
      return pending; // Original native Promise and Response remain unchanged.
    };
  }, { root: ROOT, grant: GRANT });
}

async function installReadRace(page: Page, mode: ReadRaceMode) {
  const id = (prefix: string, index: number) => `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const tenantRows: Tenant[] = [
    { id: A, name: 'Aurora Diner', slug: 'aurora-fixture', planTier: 'GROWTH', usageCredits: 120, creditDebt: 0 },
    { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture', planTier: 'STARTER', usageCredits: 40, creditDebt: 0 },
    ...Array.from({ length: 48 }, (_, i) => ({ id: id('81000001', i), name: `Boreal Branch ${i}`,
      slug: `boreal-branch-${i}`, planTier: 'STARTER', usageCredits: 1, creditDebt: 0 })),
    { id: id('81000002', 0), name: 'Cedar Diner', slug: 'cedar-fixture', planTier: 'STARTER', usageCredits: 5, creditDebt: 0 },
    { id: id('81000002', 1), name: 'Boreal Annex', slug: 'boreal-annex', planTier: 'STARTER', usageCredits: 1, creditDebt: 0 },
    ...Array.from({ length: 48 }, (_, i) => ({ id: id('81000003', i), name: `Cedar Branch ${i}`,
      slug: `cedar-branch-${i}`, planTier: 'STARTER', usageCredits: 1, creditDebt: 0 })),
    { id: id('81000004', 0), name: 'Boreal Tail', slug: 'boreal-tail', planTier: 'STARTER', usageCredits: 1, creditDebt: 0 },
  ];
  const stamp = (index: number) => new Date(Date.parse('2026-10-05T12:00:00.000Z') - index * 1000).toISOString();
  const creation = new Map(tenantRows.map((row, index) => [row.id, stamp(index)]));
  const historyRows: History[] = Array.from({ length: 101 }, (_, index) => ({ id: id('82000001', index),
    amount: -1, reason: `Existing ledger entry ${String(index).padStart(3, '0')}`, createdAt: stamp(index),
    tenant: { id: A, name: 'Aurora Diner', slug: 'aurora-fixture' } }));
  const initial = copy({ tenants: tenantRows, history: historyRows });
  const cursor = (date: string, rowId: string) => Buffer.from(JSON.stringify({ v: 1, timestamp: date, id: rowId })).toString('base64url');
  const pageOf = <T extends { id: string }>(rows: T[], raw: string | null, date: (row: T) => string) => {
    let candidates = rows;
    if (raw) {
      const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as { v: number; timestamp: string; id: string };
      if (c.v !== 1 || typeof c.timestamp !== 'string' || typeof c.id !== 'string') throw new Error('Malformed model cursor');
      candidates = rows.filter(row => date(row) < c.timestamp || (date(row) === c.timestamp && row.id < c.id));
    }
    const values = candidates.slice(0, 50), more = candidates.length > 50, last = values.at(-1);
    return { values: copy(values), pagination: { limit: 50, maxLimit: 200, returned: values.length,
      hasMore: more, nextCursor: more && last ? cursor(date(last), last.id) : null,
      window: { startDate: null, endDate: null } } };
  };
  const snapshot = (query: URLSearchParams) => {
    const q = query.get('q') ?? '';
    const filtered = tenantRows.filter(row => !q || row.name.toLowerCase().includes(q) || row.slug.includes(q));
    const tenants = pageOf(filtered, query.get('tenantCursor'), row => creation.get(row.id)!);
    const history = pageOf(historyRows, query.get('historyCursor'), row => row.createdAt);
    return { tenants: tenants.values, tenantPagination: tenants.pagination, history: history.values, historyPagination: history.pagination };
  };
  const first = snapshot(new URLSearchParams(QUERY));
  const filtered = snapshot(new URLSearchParams(QUERY + '&q=boreal'));
  const second = snapshot(new URLSearchParams(QUERY + '&tenantCursor=' + encodeURIComponent(first.tenantPagination.nextCursor!)));
  const historySecond = snapshot(new URLSearchParams(QUERY + '&historyCursor=' + encodeURIComponent(first.historyPagination.nextCursor!)));
  const allowedTenantCursors = new Set([first.tenantPagination.nextCursor, second.tenantPagination.nextCursor, filtered.tenantPagination.nextCursor]);
  const allowedHistoryCursors = new Set([first.historyPagination.nextCursor, historySecond.historyPagination.nextCursor]);
  const rows: Array<Row & { hold: ReadRaceHold | null; delivered: boolean }> = [];
  const priorReceipts: ReadRaceReceipt[] = [], priorObserverErrors: string[] = [];
  const errors: unknown[] = [], pending: Promise<void>[] = [], active = new Set<Route>();
  const holds = Object.fromEntries(['tenants', 'history', 'grant'].map(name => [name,
    { captured: deferred<Row>(), release: deferred<void>(), used: false }])) as Record<ReadRaceHold,
      { captured: ReturnType<typeof deferred<Row>>; release: ReturnType<typeof deferred<void>>; used: boolean }>;
  const accepted = new Map<string, { fingerprint: string; balance: number }>();
  let effects = 0, closing = false;
  async function run(route: Route) {
    try {
      if (closing || rows.length >= 40) throw new Error('Read-race route outside finite custody');
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const requestBody = request.postData(), key = request.headers()['idempotency-key'] ?? null;
      const probe = request.headers()['x-credit-fixture-probe'] === 'readback';
      let value: unknown, status = 200, hold: ReadRaceHold | null = null, replay = false;
      if (method === 'GET' && url.pathname === ROOT) {
        const query = url.searchParams, keys = [...query.keys()];
        if (new Set(keys).size !== keys.length || keys.some(item => !['tenantLimit', 'historyLimit', 'q', 'tenantCursor', 'historyCursor'].includes(item))
          || query.get('tenantLimit') !== '50' || query.get('historyLimit') !== '50'
          || !['', 'boreal', 'aurora'].includes(query.get('q') ?? '')
          || (query.has('tenantCursor') && !allowedTenantCursors.has(query.get('tenantCursor')))
          || (query.has('historyCursor') && !allowedHistoryCursors.has(query.get('historyCursor')))
          || (query.has('tenantCursor') && query.has('historyCursor')) || requestBody !== null || key !== null) {
          throw new Error('Unexpected read-race GET shape');
        }
        if (probe && url.search !== QUERY) throw new Error('Independent read must use unfiltered first-page contract');
        value = snapshot(query); // Freeze bytes at request time, before any held delivery.
        if (!probe && mode !== 'late-grant' && query.get('tenantCursor') === first.tenantPagination.nextCursor
          && !query.has('q') && !holds.tenants.used) hold = 'tenants';
        if (!probe && mode === 'concurrent' && query.get('historyCursor') === first.historyPagination.nextCursor
          && !holds.history.used) hold = 'history';
      } else if (method === 'POST' && url.pathname === GRANT && !url.search && !probe && mode === 'late-grant') {
        if (!key || !/^[\x21-\x7e]{1,200}$/.test(key) || key.includes(REASON)
          || requestBody !== JSON.stringify(payload) || !request.headers()['x-csrf-token']
          || !request.headers()['content-type']?.startsWith('application/json')) throw new Error('Unexpected read-race grant');
        const previous = accepted.get(key);
        if (previous && previous.fingerprint !== requestBody) throw new Error('Conflicting grant identity');
        if (previous) replay = true;
        else {
          tenantRows[1].usageCredits += 25; effects += 1;
          historyRows.unshift({ id: id('82000002', 0), amount: 25, reason: REASON, createdAt: '2026-10-06T12:00:00.000Z',
            tenant: { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture' } });
          accepted.set(key, { fingerprint: requestBody, balance: tenantRows[1].usageCredits });
        }
        status = 201; value = { success: true, newBalance: accepted.get(key)!.balance };
        if (!holds.grant.used) hold = 'grant';
      } else throw new Error('Unexpected read-race method/path');
      const body = JSON.stringify(value);
      const row = { sequence: rows.length + 1, method, url: url.href, probe, requestBody, key, status, body,
        responseSha256: createHash('sha256').update(body).digest('hex'), effects, replay, hold, delivered: false };
      rows.push(row);
      if (hold) { holds[hold].used = true; holds[hold].captured.resolve(row); await bounded(holds[hold].release.promise, `${hold} delivery hold`, 15000); }
      await route.fulfill({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(body)) }, body });
      row.delivered = true;
    } catch (error) {
      errors.push(error);
      for (const hold of Object.values(holds)) hold.captured.reject(error);
      try { await bounded(route.abort('failed'), 'read-race failed route abort', 2000); } catch (abortError) { errors.push(abortError); }
    } finally { active.delete(route); }
  }
  const handler = (route: Route) => { active.add(route); const work = run(route); pending.push(work); return work; };
  await page.route('**/api/v2/admin/credits**', handler);
  return { rows, errors, initial, first, filtered, second, historySecond, priorReceipts, priorObserverErrors,
    async retainObservationBeforeNavigation() {
      let observer: { receipts: ReadRaceReceipt[]; errors: string[] } | undefined;
      await expect.poll(async () => {
        observer = await page.evaluate(() => (window as ReadRaceWindow).__creditReadRace);
        return Boolean(observer && observer.receipts.length + priorReceipts.length === rows.length
          && observer.receipts.every(row => row.complete));
      }, { timeout: 6000 }).toBe(true);
      if (!observer) throw new Error('Missing observer before navigation');
      priorReceipts.push(...observer.receipts); priorObserverErrors.push(...observer.errors);
      await test.info().attach('read-race-before-reload-receipts', { contentType: 'application/json', body: JSON.stringify(observer) });
    },
    captured: (hold: ReadRaceHold) => bounded(holds[hold].captured.promise, `${hold} request capture`, 6000),
    release: (hold: ReadRaceHold) => holds[hold].release.resolve(),
    async read() {
      const response = await bounded(page.evaluate(async path => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
        try { const response = await fetch(path, { headers: { 'x-credit-fixture-probe': 'readback' }, cache: 'no-store', signal: controller.signal });
          return { status: response.status, body: await response.text() }; }
        finally { clearTimeout(timer); }
      }, ROOT + QUERY), 'independent read-race GET', 6000);
      expect(response.status).toBe(200);
      expect(response.body).toBe(rows.filter(row => row.probe).at(-1)?.body);
      return JSON.parse(response.body) as typeof first;
    },
    async close() {
      for (const hold of Object.values(holds)) hold.release.resolve();
      try {
        await bounded(Promise.all(pending), 'read-race first drain', 6000);
        await bounded(page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 'read-race render turn', 3000);
        await bounded(Promise.all(pending), 'read-race continuation drain', 6000);
      } catch (error) { errors.push(error); }
      closing = true;
      if (active.size) {
        errors.push(new Error(`${active.size} read-race handlers remained active`));
        const aborted = await Promise.allSettled([...active].map(route => bounded(route.abort('failed'), 'read-race abort', 2000)));
        for (const result of aborted) if (result.status === 'rejected') errors.push(result.reason);
      }
      await bounded(page.unroute('**/api/v2/admin/credits**', handler), 'read-race exact unroute', 3000);
      await bounded(Promise.all(pending), 'read-race final drain', 3000);
    },
  };
}
type ReadRaceAdapter = Awaited<ReturnType<typeof installReadRace>>;
const moreTenants = (page: Page) => page.getByRole('button', { name: 'Load more tenant balances', exact: true });
const moreHistory = (page: Page) => page.getByRole('button', { name: 'Load more ledger history', exact: true });
const raceSearch = (page: Page) => page.getByRole('textbox', { name: 'Tenant search', exact: true });
async function raceUi(page: Page) {
  return { tenantIds: await tenant(page).getByRole('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value)),
    selected: await tenant(page).inputValue(), amount: await amount(page).inputValue(), reason: await reason(page).inputValue(),
    search: await raceSearch(page).inputValue(),
    balances: await page.getByRole('article', { name: 'Tenant credit balances table', exact: true }).innerText({ timeout: 5000 }),
    history: await page.getByRole('article', { name: 'Credit transaction history table', exact: true }).innerText({ timeout: 5000 }) };
}
async function raceEvidence(page: Page, adapter: ReadRaceAdapter, name: string) {
  const state = await adapter.read();
  await bounded(page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 'read-race render turn', 3000);
  const ui = await raceUi(page);
  await test.info().attach(name, { contentType: 'application/json', body: JSON.stringify({ ui, state, rows: adapter.rows }) });
  await test.info().attach(name + '-viewport', { contentType: 'image/png',
    body: await page.screenshot({ animations: 'disabled', fullPage: false, timeout: 5000 }) });
  return { ui, state };
}
async function raceDelivered(page: Page, row: Row) {
  await expect.poll(() => page.evaluate(({ url, method, probe, body }) =>
    (window as ReadRaceWindow).__creditReadRace?.receipts.some(receipt => receipt.url === url && receipt.method === method
      && receipt.probe === probe && receipt.complete && receipt.error === null && receipt.bodyBase64 === body),
  { url: row.url, method: row.method, probe: row.probe, body: Buffer.from(row.body).toString('base64') }), { timeout: 6000 }).toBe(true);
}
async function applyRaceSearch(page: Page, query: 'boreal' | 'aurora') {
  await raceSearch(page).fill(query);
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(tenant(page).getByRole('option')).toHaveCount(query === 'boreal' ? 50 : 1);
  if (query === 'aurora') await expect(tenant(page)).toHaveValue(A);
  else await expect(tenant(page).getByRole('option', { name: 'Aurora Diner - aurora-fixture', exact: true })).toHaveCount(0);
}
async function readRaceScenario(page: Page, mode: ReadRaceMode, body: (adapter: ReadRaceAdapter) => Promise<void>) {
  const failures: unknown[] = [], pageErrors: string[] = [], consoleErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await observeReadRaceBodies(page);
  const adapter = await installReadRace(page, mode);
  try {
    await loginAsSeedSuperAdmin(page, '/admin/credits');
    await expect(tenant(page).getByRole('option')).toHaveCount(50);
    await body(adapter);
  } catch (error) { failures.push(error); }
  try { await raceEvidence(page, adapter, 'read-race-final-ui-and-independent-state'); } catch (error) { failures.push(error); }
  try { await adapter.close(); } catch (error) { failures.push(error); }
  let observed: unknown;
  try {
    await expect.poll(async () => {
      observed = await page.evaluate(() => (window as ReadRaceWindow).__creditReadRace);
      const observer = observed as { receipts: ReadRaceReceipt[]; errors: string[] } | undefined;
      return Boolean(observer && observer.receipts.length + adapter.priorReceipts.length === adapter.rows.length && observer.receipts.every(row => row.complete));
    }, { timeout: 6000 }).toBe(true);
    const observer = observed as { receipts: ReadRaceReceipt[]; errors: string[] };
    const actual = [...adapter.priorReceipts, ...observer.receipts].map(row => JSON.stringify({ method: row.method, url: row.url, probe: row.probe,
      key: row.key, requestBody: row.requestBody, status: row.status, bodyBase64: row.bodyBase64, error: row.error })).sort();
    const expected = adapter.rows.map(row => JSON.stringify({ method: row.method, url: row.url, probe: row.probe,
      key: row.key, requestBody: row.requestBody, status: row.status, bodyBase64: Buffer.from(row.body).toString('base64'), error: null })).sort();
    expect(actual).toEqual(expected); expect([...adapter.priorObserverErrors, ...observer.errors]).toEqual([]);
    expect(adapter.rows.every(row => row.delivered)).toBe(true);
    expect(adapter.errors).toEqual([]); expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([]);
  } catch (error) { failures.push(error); }
  await test.info().attach('read-race-native-response-and-model-custody', { contentType: 'application/json',
    body: JSON.stringify({ mode, initial: adapter.initial, rows: adapter.rows, observed, priorReceipts: adapter.priorReceipts, pageErrors, consoleErrors,
      adapterErrors: adapter.errors.map(String), scope: 'Controlled local model; native authority/DB/pagination not qualified.' }) });
  if (failures.length) throw new AggregateError(failures, 'Credit read ownership case or custody failed');
}

test.describe('Admin credit read publication browser custody', () => {
  test.skip(!mockMode, 'Controlled local read-order model only; native credit qualification is separately owned.');
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => { expect((await page.request.post('/api/v1/__e2e/reset')).status()).toBe(200); });

  test('keeps newer searched tenants and their continuation after an older tenant append completes', async ({ page }) => {
    await readRaceScenario(page, 'stale-append', async adapter => {
      await fill(page);
      await moreTenants(page).click(); const old = await adapter.captured('tenants');
      await applyRaceSearch(page, 'boreal');
      const applied = await raceEvidence(page, adapter, 'new-query-before-old-append');
      expect(applied.ui.tenantIds).toEqual(adapter.filtered.tenants.map(row => row.id));
      adapter.release('tenants'); await raceDelivered(page, old);
      const after = await raceEvidence(page, adapter, 'old-append-delivered-after-new-query');
      // Exercise the actual next cursor even on the known stale-publication path;
      // preserve that request before evaluating the stale-row oracle below.
      const beforeNext = adapter.rows.length;
      await moreTenants(page).click();
      await expect.poll(() => adapter.rows.slice(beforeNext).filter(row => row.method === 'GET' && !row.probe).length).toBe(1);
      const next = adapter.rows.slice(beforeNext).find(row => row.method === 'GET' && !row.probe)!;
      await raceDelivered(page, next);
      const continued = await raceEvidence(page, adapter, 'searched-continuation-request-and-ui');
      expect(after.state.tenants).toEqual(adapter.first.tenants);
      expect(after.state.history).toEqual(adapter.first.history);
      expect(adapter.rows.filter(row => row.method === 'POST')).toEqual([]);
      expect(after.ui.tenantIds).toEqual(adapter.filtered.tenants.map(row => row.id));
      expect(after.ui).toMatchObject({ selected: B, amount: '25', reason: REASON, search: 'boreal' });
      expect(new URL(next.url).searchParams.get('q')).toBe('boreal');
      expect(new URL(next.url).searchParams.get('tenantCursor')).toBe(adapter.filtered.tenantPagination.nextCursor);
      expect(continued.ui.tenantIds).toEqual(adapter.initial.tenants.filter(row => row.name.toLowerCase().includes('boreal')).map(row => row.id));
    });
  });

  test('preserves the newer search and draft when an earlier grant acknowledgement arrives', async ({ page }) => {
    await readRaceScenario(page, 'late-grant', async adapter => {
      await fill(page); await confirm(page, true);
      const grant = await adapter.captured('grant');
      expect(grant.effects).toBe(1); expect(JSON.parse(grant.requestBody!)).toEqual(payload);
      await applyRaceSearch(page, 'aurora');
      await tenant(page).selectOption(A); await amount(page).fill('7'); await reason(page).fill('New Aurora draft');
      const beforeAck = await raceEvidence(page, adapter, 'new-query-and-draft-before-old-grant-ack');
      expect(beforeAck.ui.tenantIds).toEqual([A]);
      const readBoundary = adapter.rows.length;
      adapter.release('grant'); await raceDelivered(page, grant);
      await expect(page.getByText('Credits granted.', { exact: true })).toBeVisible();
      const after = await raceEvidence(page, adapter, 'old-grant-ack-delivered-after-new-query');
      expect(after.state.tenants).toEqual(adapter.first.tenants.map(row => row.id === B ? { ...row, usageCredits: 65 } : row));
      expect(after.state.history.filter(row => row.reason === REASON)).toHaveLength(1);
      expect(after.state.history.find(row => row.reason === REASON)).toMatchObject({ amount: 25, tenant: { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture' } });
      const posts = adapter.rows.filter(row => row.method === 'POST');
      expect(posts).toHaveLength(1); expect(posts[0].status).toBe(201); expect(JSON.parse(posts[0].body)).toEqual({ success: true, newBalance: 65 });
      expect(posts[0].effects).toBe(1); expect(posts[0].replay).toBe(false);
      expect(after.ui).toMatchObject({ tenantIds: [A], selected: A, amount: '7', reason: 'New Aurora draft', search: 'aurora' });
      const followups = adapter.rows.slice(readBoundary).filter(row => row.method === 'GET' && !row.probe);
      expect(followups.length).toBeLessThanOrEqual(1);
      expect(followups.every(row => new URL(row.url).searchParams.get('q') === 'aurora')).toBe(true);
      await adapter.retainObservationBeforeNavigation();
      await page.reload(); await expect(tenant(page).getByRole('option')).toHaveCount(50);
      expect(await adapter.read()).toEqual(after.state);
      expect(adapter.rows.filter(row => row.method === 'POST')).toHaveLength(1);
    });
  });

  for (const order of [['tenants', 'history'], ['history', 'tenants']] as const) {
    test(`preserves both independent append lanes when the ${order[0]} response completes first`, async ({ page }) => {
      await readRaceScenario(page, 'concurrent', async adapter => {
        await fill(page);
        await moreTenants(page).click(); await adapter.captured('tenants');
        await expect(moreHistory(page)).toBeEnabled(); await moreHistory(page).click(); await adapter.captured('history');
        adapter.release(order[0]); await raceDelivered(page, await adapter.captured(order[0]));
        await raceEvidence(page, adapter, `${order[0]}-lane-delivered-first`);
        adapter.release(order[1]); await raceDelivered(page, await adapter.captured(order[1]));
        const both = await raceEvidence(page, adapter, 'both-independent-pages-delivered');
        expect(both.ui.tenantIds).toEqual(adapter.initial.tenants.slice(0, 100).map(row => row.id));
        expect(both.ui).toMatchObject({ selected: B, amount: '25', reason: REASON, search: '' });
        const history = page.getByRole('article', { name: 'Credit transaction history table', exact: true });
        await expect(history.getByRole('row')).toHaveCount(101);
        const nextBoundary = adapter.rows.length;
        await moreTenants(page).click(); await expect(tenant(page).getByRole('option')).toHaveCount(101);
        await moreHistory(page).click(); await expect(history.getByRole('row')).toHaveCount(102);
        const nextReads = adapter.rows.slice(nextBoundary).filter(row => row.method === 'GET' && !row.probe);
        expect(nextReads).toHaveLength(2);
        expect(new URL(nextReads[0].url).searchParams.get('tenantCursor')).toBe(adapter.second.tenantPagination.nextCursor);
        expect(new URL(nextReads[1].url).searchParams.get('historyCursor')).toBe(adapter.historySecond.historyPagination.nextCursor);
        await expect(moreTenants(page)).toHaveCount(0); await expect(moreHistory(page)).toHaveCount(0);
        expect(await adapter.read()).toEqual(adapter.first);
        expect(adapter.rows.filter(row => row.method === 'POST')).toEqual([]);
      });
    });
  }
});

// Independent finite debt settlement witnesses. Expected settlements below are
// explicit examples, not calls to the production estimate/settlement helpers.
type DebtMode = 'loaded' | 'missing-initial';
type DebtReceipt = { method: string; url: string; key: string | null; probe: boolean; requestBody: string | null;
  status: number | null; bodyBase64: string | null; complete: boolean; error: string | null };
type DebtWindow = Window & { __creditDebtReceipts?: { receipts: DebtReceipt[]; errors: string[] } };
async function observeDebtBodies(page: Page) {
  await page.addInitScript(({ root, grant }) => {
    const observer = { receipts: [] as DebtReceipt[], errors: [] as string[] };
    (window as DebtWindow).__creditDebtReceipts = observer;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const pending = original(input, init);
      try {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), location.href);
        if (url.origin === location.origin && [root, grant].includes(url.pathname)) {
          if (observer.receipts.length >= 30) throw new Error('Debt receipt bound exceeded');
          const headers = new Headers(init?.headers ?? request?.headers);
          const receipt: DebtReceipt = { method: (init?.method ?? request?.method ?? 'GET').toUpperCase(), url: url.href,
            key: headers.get('idempotency-key'), probe: headers.get('x-credit-fixture-probe') === 'readback',
            requestBody: typeof init?.body === 'string' ? init.body : null, status: null, bodyBase64: null, complete: false, error: null };
          observer.receipts.push(receipt);
          void pending.then(async response => {
            receipt.status = response.status;
            const bytes = new Uint8Array(await response.clone().arrayBuffer());
            receipt.bodyBase64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
          }).catch(error => { receipt.error = String(error); }).finally(() => { receipt.complete = true; });
        }
      } catch (error) { observer.errors.push(String(error)); }
      return pending; // Native Promise/Response are returned unchanged; only clones are read.
    };
  }, { root: ROOT, grant: GRANT });
}
const DEBT_FIRST_REASON = 'Debt repayment';
const DEBT_REMAINDER_REASON = 'Debt repayment with remainder';
const DEBT_MISSING_REASON = 'Missing debt compatibility';
const DEBT_UNAVAILABLE = 'Balance details are unavailable. Refresh balances to show an estimate. You can still grant credits; the server settles debt first.';
async function installDebtModel(page: Page, mode: DebtMode) {
  const tenants: Tenant[] = [
    { id: A, name: 'Aurora Diner', slug: 'aurora-fixture', planTier: 'GROWTH', usageCredits: 120, creditDebt: 0 },
    { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture', planTier: 'STARTER', usageCredits: 10, creditDebt: 30 },
  ];
  const steps = mode === 'loaded' ? [
    { payload: { tenantId: B, amount: 20, reason: DEBT_FIRST_REASON }, before: { wallet: 10, debt: 30 },
      after: { wallet: 10, debt: 10 }, spendable: 0, debtDelta: -20 },
    { payload: { tenantId: B, amount: 30, reason: DEBT_REMAINDER_REASON }, before: { wallet: 10, debt: 10 },
      after: { wallet: 30, debt: 0 }, spendable: 20, debtDelta: -10 },
  ] : [
    { payload: { tenantId: B, amount: 20, reason: DEBT_MISSING_REASON }, before: { wallet: 10, debt: 30 },
      after: { wallet: 10, debt: 10 }, spendable: 0, debtDelta: -20 },
  ];
  const initial = copy(tenants), history: History[] = [], ledger: Array<Row & { delivered: boolean; missingDebt: boolean }> = [];
  const settlements: Array<{ key: string; payload: typeof steps[number]['payload']; spendable: number; debtDelta: number;
    walletAfter: number; debtAfter: number }> = [];
  const dialogs: Array<{ type: string; actual: string; expected: string; accepted: boolean }> = [];
  const errors: unknown[] = [], active = new Set<Route>(), pending: Promise<void>[] = [];
  const priorReceipts: DebtReceipt[] = [], priorObserverErrors: string[] = [];
  const accepted = new Map<string, { fingerprint: string; balance: number }>();
  let effects = 0, ordinaryReads = 0, closing = false;
  const snapshot = (): Snapshot => copy({ tenants, history, tenantPagination: pagination(tenants.length), historyPagination: pagination(history.length) });
  async function run(route: Route) {
    try {
      if (closing || ledger.length >= 30) throw new Error('Debt request outside finite custody');
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const requestBody = request.postData(), key = request.headers()['idempotency-key'] ?? null;
      const probe = request.headers()['x-credit-fixture-probe'] === 'readback';
      let status: number, value: unknown, replay = false, missingDebt = false;
      if (method === 'GET' && url.pathname === ROOT && url.search === QUERY) {
        if (requestBody !== null || key !== null) throw new Error('Unexpected debt GET mutation fields');
        const response = snapshot();
        if (!probe) ordinaryReads += 1;
        if (mode === 'missing-initial' && !probe && ordinaryReads === 1) {
          // One historical/degraded response only. Independent later GETs expose
          // the same authoritative model state; no fake probe-only state exists.
          delete (response.tenants.find(row => row.id === B)! as Partial<Tenant>).creditDebt;
          missingDebt = true;
        }
        status = 200; value = response;
      } else if (method === 'POST' && url.pathname === GRANT && !url.search && !probe) {
        if (!key || !/^[\x21-\x7e]{1,200}$/.test(key) || requestBody === null || requestBody.length > 4096
          || !request.headers()['content-type']?.startsWith('application/json') || !request.headers()['x-csrf-token']) {
          throw new Error('Unexpected debt grant transport');
        }
        const previous = accepted.get(key);
        if (previous) {
          if (previous.fingerprint !== requestBody) throw new Error('Debt key reused with a different payload');
          replay = true;
        } else {
          const step = steps[effects];
          if (!step || requestBody !== JSON.stringify(step.payload) || key.includes(step.payload.reason)) throw new Error('Unexpected debt grant payload/order');
          const target = tenants[1];
          if (target.usageCredits !== step.before.wallet || target.creditDebt !== step.before.debt) throw new Error('Unexpected model pre-settlement state');
          target.usageCredits = step.after.wallet; target.creditDebt = step.after.debt;
          effects += 1;
          history.unshift({ id: `83000000-0000-4000-8000-${String(effects).padStart(12, '0')}`, amount: step.spendable,
            reason: step.payload.reason, createdAt: `2026-10-06T12:00:0${effects}.000Z`,
            tenant: { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture' } });
          settlements.push({ key, payload: copy(step.payload), spendable: step.spendable, debtDelta: step.debtDelta,
            walletAfter: step.after.wallet, debtAfter: step.after.debt });
          accepted.set(key, { fingerprint: requestBody, balance: step.after.wallet });
        }
        status = 201; value = { success: true, newBalance: accepted.get(key)!.balance };
      } else throw new Error('Unexpected debt method/path/query');
      const body = JSON.stringify(value);
      const row = { sequence: ledger.length + 1, method, url: url.href, probe, requestBody, key, status, body,
        responseSha256: createHash('sha256').update(body).digest('hex'), effects, replay, delivered: false, missingDebt };
      ledger.push(row);
      await route.fulfill({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(body)) }, body });
      row.delivered = true;
    } catch (error) {
      errors.push(error);
      try { await bounded(route.abort('failed'), 'debt failed-route abort', 2000); } catch (abortError) { errors.push(abortError); }
    } finally { active.delete(route); }
  }
  const handler = (route: Route) => { active.add(route); const work = run(route); pending.push(work); return work; };
  await page.route('**/api/v2/admin/credits**', handler);
  return { initial, ledger, settlements, dialogs, errors, priorReceipts, priorObserverErrors,
    async read() {
      const received = await bounded(page.evaluate(async path => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
        try { const response = await fetch(path, { headers: { 'x-credit-fixture-probe': 'readback' }, cache: 'no-store', signal: controller.signal });
          return { status: response.status, body: await response.text() }; }
        finally { clearTimeout(timer); }
      }, ROOT + QUERY), 'independent debt GET', 6000);
      expect(received.status).toBe(200); expect(received.body).toBe(ledger.filter(row => row.probe).at(-1)?.body);
      return JSON.parse(received.body) as Snapshot;
    },
    async retainBeforeReload() {
      let observer: { receipts: DebtReceipt[]; errors: string[] } | undefined;
      await expect.poll(async () => {
        observer = await page.evaluate(() => (window as DebtWindow).__creditDebtReceipts);
        return Boolean(observer && priorReceipts.length + observer.receipts.length === ledger.length && observer.receipts.every(row => row.complete));
      }, { timeout: 6000 }).toBe(true);
      if (!observer) throw new Error('Missing debt observer before reload');
      priorReceipts.push(...observer.receipts); priorObserverErrors.push(...observer.errors);
      await test.info().attach('debt-before-reload-native-receipts', { contentType: 'application/json', body: JSON.stringify(observer) });
    },
    async close() {
      try { await bounded(Promise.all(pending), 'debt handler drain', 5000); } catch (error) { errors.push(error); }
      closing = true;
      if (active.size) {
        errors.push(new Error(`${active.size} debt routes remained active`));
        const aborted = await Promise.allSettled([...active].map(route => bounded(route.abort('failed'), 'debt cleanup abort', 2000)));
        for (const result of aborted) if (result.status === 'rejected') errors.push(result.reason);
      }
      await bounded(page.unroute('**/api/v2/admin/credits**', handler), 'debt exact unroute', 3000);
      await bounded(Promise.all(pending), 'debt final handler drain', 3000);
    },
  };
}
type DebtAdapter = Awaited<ReturnType<typeof installDebtModel>>;
const debtFields = {
  loadedWallet: 'Loaded spendable balance:', loadedDebt: 'Loaded outstanding debt:',
  repayment: 'Estimated debt repayment:', walletAfter: 'Estimated spendable balance:', debtAfter: 'Estimated remaining debt:',
} as const;
const debtField = (page: Page, field: keyof typeof debtFields) => page.getByText(debtFields[field], { exact: false }).locator('strong');
async function expectDebtPreview(page: Page, expected: Record<keyof typeof debtFields, string>) {
  for (const field of Object.keys(debtFields) as Array<keyof typeof debtFields>) await expect(debtField(page, field)).toHaveText(expected[field]);
}
// Exercise the actual taller debt preview; no requests, confirmation or grant are issued here.
async function debtPreviewLayoutWitness(page: Page, state: 'nonzero-debt' | 'missing-debt',
  expected: Record<keyof typeof debtFields, string>) {
  const original = page.viewportSize();
  expect(original, 'canonical debt projects have an explicit viewport').not.toBeNull();
  if (!original) throw new Error('Debt preview requires the canonical viewport');
  // Chromium supplies explicit 320/393 phone widths and its unchanged desktop width.
  // Firefox and Mobile Chrome retain their actual canonical viewport (including mobile393).
  const widths = test.info().project.name === 'chromium' ? [...new Set([320, 393, original.width])] : [original.width];
  const grant = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Grant Credits', exact: true }) });
  const balances = page.getByRole('article', { name: 'Tenant credit balances table', exact: true });
  const controls = [
    { name: 'tenant', locator: tenant(page) }, { name: 'amount', locator: amount(page) },
    { name: 'reason', locator: reason(page) }, { name: 'grant', locator: submit(page) },
  ];
  const before = { tenantId: await tenant(page).inputValue(), amount: await amount(page).inputValue(), reason: await reason(page).inputValue() };
  const failures: unknown[] = [];
  try {
    for (const width of widths) {
      const label = `credit-${state}-preview-${test.info().project.name.replace(/\W+/g, '-').toLowerCase()}-${width}px`;
      const textGeometry: unknown[] = [];
      try {
        if (test.info().project.name === 'chromium') await page.setViewportSize({ width, height: original.height });
        await expect(grant).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => ({ x: scrollX, y: scrollY })), { timeout: 3000 }).toEqual({ x: 0, y: 0 });
        // Keep the first viewport separately from the full-page image and preserve failure pixels.
        await test.info().attach(label + '-first-viewport', { contentType: 'image/png',
          body: await page.screenshot({ fullPage: false, animations: 'disabled', timeout: 5000 }) });
        await test.info().attach(label + '-full-page', { contentType: 'image/png',
          body: await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 5000 }) });
        const size = await page.evaluate(() => ({ width: innerWidth,
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
        const grantBox = await grant.boundingBox(), balanceBox = await balances.boundingBox();
        const boxes = await Promise.all(controls.map(async item => ({ name: item.name,
          count: await item.locator.count(), box: await item.locator.boundingBox() })));
        await test.info().attach(label + '-form-geometry', { contentType: 'application/json',
          body: JSON.stringify({ state, expected, size, grantBox, balanceBox, controls: boxes, before }) });
        expect(size.width).toBe(width); expect(size.scrollWidth).toBeLessThanOrEqual(width + 1);
        expect(grantBox).not.toBeNull(); expect(balanceBox).not.toBeNull();
        if (!grantBox || !balanceBox) throw new Error('Debt panels have no rendered geometry');
        expect(grantBox.x).toBeGreaterThanOrEqual(-1); expect(grantBox.x + grantBox.width).toBeLessThanOrEqual(width + 1);
        expect(grantBox.width).toBeGreaterThanOrEqual(Math.min(260, width * 0.8));
        if (width <= 900) {
          expect(grantBox.y).toBeGreaterThanOrEqual(balanceBox.y + balanceBox.height - 1);
          expect(Math.abs(grantBox.x - balanceBox.x)).toBeLessThanOrEqual(2);
          expect(Math.abs(grantBox.width - balanceBox.width)).toBeLessThanOrEqual(2);
        } else {
          expect(grantBox.x).toBeGreaterThanOrEqual(balanceBox.x + balanceBox.width - 1);
          expect(Math.abs(grantBox.y - balanceBox.y)).toBeLessThanOrEqual(2);
        }
        for (const item of boxes) {
          expect(item.count, item.name + ' is unique').toBe(1); expect(item.box).not.toBeNull();
          if (!item.box) throw new Error(item.name + ' has no debt form rectangle');
          expect(item.box.x).toBeGreaterThanOrEqual(grantBox.x - 1);
          expect(item.box.x + item.box.width).toBeLessThanOrEqual(grantBox.x + grantBox.width + 1);
          expect(item.box.x).toBeGreaterThanOrEqual(-1); expect(item.box.x + item.box.width).toBeLessThanOrEqual(width + 1);
          if (width <= 768) {
            expect(item.box.width, item.name + ' touch width').toBeGreaterThanOrEqual(44);
            expect(item.box.height, item.name + ' touch height').toBeGreaterThanOrEqual(44);
          }
        }
        await expectDebtPreview(page, expected);
        const rows = (Object.keys(debtFields) as Array<keyof typeof debtFields>).map(field => ({
          name: field, locator: page.getByText(debtFields[field], { exact: false }), value: debtField(page, field),
        }));
        const textRows = [...rows.map(({ name, locator }) => ({ name, locator })),
          { name: 'estimate-guidance', locator: page.getByText('Estimates use loaded balances. Actual grants repay current outstanding debt first.', { exact: true }) },
          ...(state === 'missing-debt' ? [{ name: 'missing-debt-guidance', locator: page.getByText(DEBT_UNAVAILABLE, { exact: true }) }] : [])];
        for (const row of textRows) {
          await expect(row.locator).toHaveCount(1); await expect(row.locator).toBeVisible();
          // Normal vertical scrolling must reveal every wrapped label/value/guidance in full.
          await row.locator.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
          await expect(row.locator).toBeInViewport({ ratio: 1 });
          const geometry = await row.locator.evaluate(node => {
            const rect = (box: DOMRect) => ({ x: box.x, y: box.y, width: box.width, height: box.height });
            const range = document.createRange(); range.selectNodeContents(node);
            const textRects = Array.from(range.getClientRects()).filter(box => box.width > 0 && box.height > 0).map(rect);
            const clips: Array<{ box: ReturnType<typeof rect>; x: boolean; y: boolean }> = [];
            for (let parent: Element | null = node; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent), x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX), y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
              if (x || y) clips.push({ box: rect(parent.getBoundingClientRect()), x, y });
            }
            return { row: rect(node.getBoundingClientRect()), viewport: { width: innerWidth, height: innerHeight },
              textRects, clips, scrollX, text: node.textContent };
          });
          textGeometry.push({ name: row.name, ...geometry });
          expect(geometry.scrollX).toBe(0); expect(geometry.textRects.length).toBeGreaterThan(0);
          for (const text of geometry.textRects) {
            expect(text.x).toBeGreaterThanOrEqual(geometry.row.x - 1);
            expect(text.x + text.width).toBeLessThanOrEqual(geometry.row.x + geometry.row.width + 1);
            expect(text.y).toBeGreaterThanOrEqual(geometry.row.y - 1);
            expect(text.y + text.height).toBeLessThanOrEqual(geometry.row.y + geometry.row.height + 1);
            expect(text.x).toBeGreaterThanOrEqual(-1); expect(text.x + text.width).toBeLessThanOrEqual(geometry.viewport.width + 1);
            expect(text.y).toBeGreaterThanOrEqual(-1); expect(text.y + text.height).toBeLessThanOrEqual(geometry.viewport.height + 1);
            for (const clip of geometry.clips) {
              if (clip.x) { expect(text.x).toBeGreaterThanOrEqual(clip.box.x - 1); expect(text.x + text.width).toBeLessThanOrEqual(clip.box.x + clip.box.width + 1); }
              if (clip.y) { expect(text.y).toBeGreaterThanOrEqual(clip.box.y - 1); expect(text.y + text.height).toBeLessThanOrEqual(clip.box.y + clip.box.height + 1); }
            }
          }
        }
        for (const row of rows) {
          await row.value.scrollIntoViewIfNeeded({ timeout: 3000 }); await expect(row.value).toBeInViewport({ ratio: 1 });
        }
        await rows[0].locator.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await test.info().attach(label + '-preview-viewport', { contentType: 'image/png',
          body: await page.screenshot({ fullPage: false, animations: 'disabled', timeout: 5000 }) });
        expect({ tenantId: await tenant(page).inputValue(), amount: await amount(page).inputValue(), reason: await reason(page).inputValue() }).toEqual(before);
      } catch (error) {
        failures.push(error);
        try { await test.info().attach(label + '-failure', { contentType: 'image/png',
          body: await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 3000 }) }); }
        catch (screenshotError) { failures.push(screenshotError); }
        break;
      } finally {
        try { await test.info().attach(label + '-text-geometry', { contentType: 'application/json', body: JSON.stringify(textGeometry) }); }
        catch (attachmentError) { failures.push(attachmentError); }
      }
    }
  } finally {
    try {
      await page.setViewportSize(original);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => ({ x: scrollX, y: scrollY })), { timeout: 3000 }).toEqual({ x: 0, y: 0 });
    } catch (restoreError) { failures.push(restoreError); }
  }
  if (failures.length) throw new AggregateError(failures, 'Debt preview responsive witness failed');
}

async function debtEvidence(page: Page, adapter: DebtAdapter, label: string) {
  const state = await adapter.read();
  const values = Object.fromEntries(await Promise.all((Object.keys(debtFields) as Array<keyof typeof debtFields>).map(async field =>
    [field, await debtField(page, field).allTextContents()])));
  const ui = { values, tenantId: await tenant(page).inputValue(), amount: await amount(page).inputValue(), reason: await reason(page).inputValue(),
    unavailable: await page.getByText(DEBT_UNAVAILABLE, { exact: true }).allTextContents(),
    notice: await page.getByText('Credits granted.', { exact: true }).allTextContents() };
  await test.info().attach(label, { contentType: 'application/json', body: JSON.stringify({ ui, state, ledger: adapter.ledger,
    settlements: adapter.settlements, dialogs: adapter.dialogs }) });
  await test.info().attach(label + '-viewport', { contentType: 'image/png',
    body: await page.screenshot({ animations: 'disabled', fullPage: false, timeout: 5000 }) });
  return { ui, state };
}
async function confirmDebt(page: Page, adapter: DebtAdapter, expected: string, accept: boolean) {
  const completed = deferred<void>(), failures: unknown[] = [];
  const handler = async (dialog: Dialog) => {
    try {
      adapter.dialogs.push({ type: dialog.type(), actual: dialog.message(), expected, accepted: accept });
      expect(dialog.type()).toBe('confirm'); expect(dialog.message()).toBe(expected);
      if (accept) await dialog.accept(); else await dialog.dismiss();
    } catch (error) { failures.push(error); await dialog.dismiss().catch(() => undefined); }
    finally { completed.resolve(); }
  };
  page.once('dialog', handler);
  try { await bounded(Promise.all([submit(page).click({ timeout: 5000 }), completed.promise]), 'debt confirmation click/dialog', 6000); }
  finally { page.off('dialog', handler); }
  expect(failures).toEqual([]);
}
async function waitDebtGrant(page: Page, adapter: DebtAdapter, count: number) {
  await expect.poll(() => adapter.ledger.filter(row => row.method === 'POST').length).toBe(count);
  const row = adapter.ledger.filter(item => item.method === 'POST').at(-1)!;
  await expect.poll(() => page.evaluate(({ key, body }) => (window as DebtWindow).__creditDebtReceipts?.receipts.some(receipt =>
    receipt.method === 'POST' && receipt.key === key && receipt.status === 201 && receipt.complete && receipt.error === null
    && receipt.bodyBase64 === body), { key: row.key, body: Buffer.from(row.body).toString('base64') }), { timeout: 6000 }).toBe(true);
  await expect(page.getByText('Credits granted.', { exact: true })).toBeVisible();
  await expect(submit(page)).toBeEnabled();
  return row;
}
async function debtHistoryWitness(page: Page, expected: Array<{ reason: string; amount: number }>, walletRows: number) {
  const history = page.getByRole('article', { name: 'Credit transaction history table', exact: true });
  await expect(history.getByRole('columnheader', { name: 'Spendable change', exact: true })).toHaveCount(1);
  await expect(history.getByRole('row')).toHaveCount(expected.length + 1);
  for (const entry of expected) {
    const row = history.getByRole('row').filter({ has: page.getByText(entry.reason, { exact: true }) });
    await expect(row).toHaveCount(1); await expect(row).toContainText('Boreal Kitchen');
    const cell = row.getByRole('cell').nth(2);
    await cell.scrollIntoViewIfNeeded({ timeout: 5000 });
    await expect(cell).toBeInViewport(); await expect(cell).toHaveText(`+${entry.amount}`);
  }
  const summary = page.getByRole('article').filter({ has: page.getByText('positive wallet rows loaded', { exact: true }) });
  await expect(summary).toHaveCount(1); await expect(summary.getByText(String(walletRows), { exact: true })).toHaveCount(1);
}
async function debtScenario(page: Page, mode: DebtMode, body: (adapter: DebtAdapter) => Promise<void>) {
  const failures: unknown[] = [], pageErrors: string[] = [], consoleErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await observeDebtBodies(page); const adapter = await installDebtModel(page, mode);
  try {
    await loginAsSeedSuperAdmin(page, '/admin/credits'); await expect(tenant(page).getByRole('option')).toHaveCount(2);
    await tenant(page).selectOption(B); await body(adapter);
  } catch (error) { failures.push(error); }
  try { await debtEvidence(page, adapter, 'debt-final-rendered-and-independent-state'); } catch (error) { failures.push(error); }
  try { await adapter.close(); } catch (error) { failures.push(error); }
  let observed: { receipts: DebtReceipt[]; errors: string[] } | undefined;
  try {
    await expect.poll(async () => {
      observed = await page.evaluate(() => (window as DebtWindow).__creditDebtReceipts);
      return Boolean(observed && adapter.priorReceipts.length + observed.receipts.length === adapter.ledger.length
        && observed.receipts.every(row => row.complete));
    }, { timeout: 6000 }).toBe(true);
    if (!observed) throw new Error('Debt native observer missing');
    const actual = [...adapter.priorReceipts, ...observed.receipts].map(({ complete, ...receipt }) => JSON.stringify(receipt)).sort();
    const expected = adapter.ledger.map(row => JSON.stringify({ method: row.method, url: row.url, key: row.key, probe: row.probe,
      requestBody: row.requestBody, status: row.status, bodyBase64: Buffer.from(row.body).toString('base64'), error: null })).sort();
    expect(actual).toEqual(expected); expect([...adapter.priorObserverErrors, ...observed.errors]).toEqual([]);
    expect(adapter.errors).toEqual([]); expect(adapter.ledger.every(row => row.delivered)).toBe(true);
    expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([]);
  } catch (error) { failures.push(error); }
  await test.info().attach('debt-native-response-model-and-dialog-custody', { contentType: 'application/json', body: JSON.stringify({
    mode, initial: adapter.initial, ledger: adapter.ledger, settlements: adapter.settlements, dialogs: adapter.dialogs,
    observed, priorReceipts: adapter.priorReceipts, pageErrors, consoleErrors, adapterErrors: adapter.errors.map(String),
    scope: 'Finite local debt model only; independent GET is modeled state, not native DB/audit/provider qualification.' }) });
  if (failures.length) throw new AggregateError(failures, 'Rendered credit debt case or custody failed');
}

test.describe('Admin credit debt settlement browser custody', () => {
  test.skip(!mockMode, 'Controlled local debt model only; native settlement qualification is separately owned.');
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => { expect((await page.request.post('/api/v1/__e2e/reset')).status()).toBe(200); });

  test('renders debt repayment before spendable growth and preserves both explicit grants after reload', async ({ page }) => {
    await debtScenario(page, 'loaded', async adapter => {
      await amount(page).fill('20'); await reason(page).fill(DEBT_FIRST_REASON);
      await debtEvidence(page, adapter, 'loaded-debt-before-first-confirmation');
      await expectDebtPreview(page, { loadedWallet: '10', loadedDebt: '30', repayment: '20', walletAfter: '10', debtAfter: '10' });
      await debtPreviewLayoutWitness(page, 'nonzero-debt', { loadedWallet: '10', loadedDebt: '30', repayment: '20', walletAfter: '10', debtAfter: '10' });
      const firstConfirmation = 'Grant 20 credits to Boreal Kitchen? Estimated debt repayment: 20 credits. Estimated spendable balance: 10 credits. Estimated remaining debt: 10 credits. Estimates use loaded balances; the server settles against current balances.';
      await confirmDebt(page, adapter, firstConfirmation, false);
      expect(adapter.ledger.filter(row => row.method === 'POST')).toEqual([]); expect(adapter.settlements).toEqual([]);
      expect((await adapter.read()).tenants).toEqual(adapter.initial);
      await expect(amount(page)).toHaveValue('20'); await expect(reason(page)).toHaveValue(DEBT_FIRST_REASON);
      await confirmDebt(page, adapter, firstConfirmation, true); const first = await waitDebtGrant(page, adapter, 1);
      await expect(debtField(page, 'loadedDebt')).toHaveText('10');
      const firstState = (await debtEvidence(page, adapter, 'first-debt-only-grant-delivered')).state;
      expect(firstState.tenants).toEqual(adapter.initial.map(row => row.id === B ? { ...row, creditDebt: 10 } : row));
      expect(firstState.history).toHaveLength(1);
      expect(firstState.history[0]).toMatchObject({ amount: 0, reason: DEBT_FIRST_REASON, tenant: { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture' } });
      expect(JSON.parse(first.requestBody!)).toEqual({ tenantId: B, amount: 20, reason: DEBT_FIRST_REASON });
      expect(JSON.parse(first.body)).toEqual({ success: true, newBalance: 10 }); expect(first.effects).toBe(1); expect(first.replay).toBe(false);
      await debtHistoryWitness(page, [{ reason: DEBT_FIRST_REASON, amount: 0 }], 0);
      await amount(page).fill('30'); await reason(page).fill(DEBT_REMAINDER_REASON);
      await debtEvidence(page, adapter, 'remaining-debt-before-second-confirmation');
      await expectDebtPreview(page, { loadedWallet: '10', loadedDebt: '10', repayment: '10', walletAfter: '30', debtAfter: '0' });
      const secondConfirmation = 'Grant 30 credits to Boreal Kitchen? Estimated debt repayment: 10 credits. Estimated spendable balance: 30 credits. Estimated remaining debt: 0 credits. Estimates use loaded balances; the server settles against current balances.';
      await confirmDebt(page, adapter, secondConfirmation, true); const second = await waitDebtGrant(page, adapter, 2);
      await expect(debtField(page, 'loadedDebt')).toHaveText('0'); await expect(debtField(page, 'loadedWallet')).toHaveText('30');
      const final = (await debtEvidence(page, adapter, 'second-debt-and-wallet-grant-delivered')).state;
      expect(final.tenants).toEqual(adapter.initial.map(row => row.id === B ? { ...row, usageCredits: 30, creditDebt: 0 } : row));
      expect(final.history.map(row => ({ amount: row.amount, reason: row.reason }))).toEqual([
        { amount: 20, reason: DEBT_REMAINDER_REASON }, { amount: 0, reason: DEBT_FIRST_REASON },
      ]);
      expect(new Set(final.history.map(row => row.id)).size).toBe(2);
      expect(JSON.parse(second.requestBody!)).toEqual({ tenantId: B, amount: 30, reason: DEBT_REMAINDER_REASON });
      expect(JSON.parse(second.body)).toEqual({ success: true, newBalance: 30 }); expect(second.key).not.toBe(first.key);
      expect(second.effects).toBe(2); expect(second.replay).toBe(false);
      expect(adapter.settlements.map(row => ({ spendable: row.spendable, debtDelta: row.debtDelta }))).toEqual([
        { spendable: 0, debtDelta: -20 }, { spendable: 20, debtDelta: -10 },
      ]);
      await debtHistoryWitness(page, [{ reason: DEBT_FIRST_REASON, amount: 0 }, { reason: DEBT_REMAINDER_REASON, amount: 20 }], 1);
      await adapter.retainBeforeReload(); await page.reload(); await expect(tenant(page).getByRole('option')).toHaveCount(2);
      expect(await adapter.read()).toEqual(final); await tenant(page).selectOption(B);
      await expect(debtField(page, 'loadedWallet')).toHaveText('30'); await expect(debtField(page, 'loadedDebt')).toHaveText('0');
      await debtHistoryWitness(page, [{ reason: DEBT_FIRST_REASON, amount: 0 }, { reason: DEBT_REMAINDER_REASON, amount: 20 }], 1);
      expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(2); expect(adapter.settlements).toHaveLength(2);
    });
  });

  test('keeps missing-debt estimates unavailable while allowing an explicit debt-first grant and truthful reload', async ({ page }) => {
    await debtScenario(page, 'missing-initial', async adapter => {
      await amount(page).fill('20'); await reason(page).fill(DEBT_MISSING_REASON);
      const initial = await debtEvidence(page, adapter, 'missing-initial-debt-rendering-and-authority');
      expect(initial.state.tenants).toEqual(adapter.initial);
      const omitted = adapter.ledger.filter(row => row.missingDebt);
      expect(omitted).toHaveLength(1);
      expect(JSON.parse(omitted[0].body).tenants.find((row: Tenant) => row.id === B)).not.toHaveProperty('creditDebt');
      await expectDebtPreview(page, { loadedWallet: '10', loadedDebt: 'Unavailable', repayment: '-', walletAfter: '-', debtAfter: '-' });
      await debtPreviewLayoutWitness(page, 'missing-debt', { loadedWallet: '10', loadedDebt: 'Unavailable', repayment: '-', walletAfter: '-', debtAfter: '-' });
      await expect(page.getByText(DEBT_UNAVAILABLE, { exact: true })).toBeVisible(); await expect(submit(page)).toBeEnabled();
      const confirmation = 'Grant 20 credits to Boreal Kitchen? A balance estimate is unavailable; refresh balances for debt details. Outstanding debt is repaid first, and the server determines the final balances.';
      await confirmDebt(page, adapter, confirmation, false);
      expect(adapter.ledger.filter(row => row.method === 'POST')).toEqual([]); expect(adapter.settlements).toEqual([]);
      await expect(tenant(page)).toHaveValue(B); await expect(amount(page)).toHaveValue('20'); await expect(reason(page)).toHaveValue(DEBT_MISSING_REASON);
      await confirmDebt(page, adapter, confirmation, true); const delivered = await waitDebtGrant(page, adapter, 1);
      await expect(debtField(page, 'loadedDebt')).toHaveText('10');
      const committed = (await debtEvidence(page, adapter, 'missing-debt-explicit-grant-delivered')).state;
      expect(committed.tenants).toEqual(adapter.initial.map(row => row.id === B ? { ...row, creditDebt: 10 } : row));
      expect(committed.history).toHaveLength(1);
      expect(committed.history[0]).toMatchObject({ amount: 0, reason: DEBT_MISSING_REASON, tenant: { id: B, name: 'Boreal Kitchen', slug: 'boreal-fixture' } });
      expect(JSON.parse(delivered.requestBody!)).toEqual({ tenantId: B, amount: 20, reason: DEBT_MISSING_REASON });
      expect(JSON.parse(delivered.body)).toEqual({ success: true, newBalance: 10 }); expect(delivered.effects).toBe(1); expect(delivered.replay).toBe(false);
      await expect(page.getByText(DEBT_UNAVAILABLE, { exact: true })).toHaveCount(0);
      await expectDebtPreview(page, { loadedWallet: '10', loadedDebt: '10', repayment: '10', walletAfter: '20', debtAfter: '0' });
      await debtHistoryWitness(page, [{ reason: DEBT_MISSING_REASON, amount: 0 }], 0);
      await adapter.retainBeforeReload(); await page.reload(); await expect(tenant(page).getByRole('option')).toHaveCount(2);
      expect(await adapter.read()).toEqual(committed); await tenant(page).selectOption(B);
      await expectDebtPreview(page, { loadedWallet: '10', loadedDebt: '10', repayment: '-', walletAfter: '-', debtAfter: '-' });
      await expect(page.getByText(DEBT_UNAVAILABLE, { exact: true })).toHaveCount(0);
      await debtHistoryWitness(page, [{ reason: DEBT_MISSING_REASON, amount: 0 }], 0);
      expect(adapter.ledger.filter(row => row.method === 'POST')).toHaveLength(1); expect(adapter.settlements).toHaveLength(1);
      expect(adapter.ledger.filter(row => row.missingDebt)).toHaveLength(1);
    });
  });
});
