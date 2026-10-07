import { createHash } from 'node:crypto';
import type { ConsoleMessage, Locator, Request as PlaywrightRequest } from '@playwright/test';
import { expect, test, type Page, type Route } from './qa-isolation-fixture';
import { loginAsSeedAdmin, runFullStack } from './support';

// Actual browser/client/React boundary against a closed in-memory HTTP model.
// This does not execute PostgreSQL, native current authority or a payroll provider.
// These are ordinary strict tests; currently red behavior is never expected-fail.
const mockMode = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const ROOT = '/api/v2/payroll';
const EXPORT_SUCCESS_NOTICE = /payroll export (?:created|was created)/i;
const A = '93000000-0000-4000-8000-000000000001', B = '93000000-0000-4000-8000-000000000002';
const EXPORT_A = '94000000-0000-4000-8000-000000000001', EXPORT_B = '94000000-0000-4000-8000-000000000002';
const POST = `${ROOT}/periods/${A}/exports`, STATE = `${ROOT}/__response_proof/state`;
const PROBE = 'x-payroll-response-proof', COST = 1;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Mode = 'positive' | 'wrong-period-ack' | 'malformed-ack' | 'foreign-detail';
const POLICY = { id: '95000000-0000-4000-8000-000000000001', version: 1, timeZone: 'America/Los_Angeles',
  cadence: 'WEEKLY', anchorDate: '2026-07-06', effectiveFrom: '2026-07-06', createdByUserId: '20000000-0000-4000-8000-000000000101', createdAt: '2026-07-06T16:00:00.000Z' };
function period(id: string, batch: ReturnType<typeof exportBatch> | null = null) {
  const isA = id === A;
  return { id, policyVersionId: POLICY.id, localStartDate: isA ? '2026-07-13' : '2026-07-06',
    localEndDateExclusive: isA ? '2026-07-20' : '2026-07-13', startsAt: isA ? '2026-07-13T07:00:00.000Z' : '2026-07-06T07:00:00.000Z',
    endsAt: isA ? '2026-07-20T07:00:00.000Z' : '2026-07-13T07:00:00.000Z', timeZone: POLICY.timeZone, cadence: POLICY.cadence,
    status: 'LOCKED', revision: 2, reviewStartedAt: isA ? '2026-07-20T16:00:00.000Z' : '2026-07-13T16:00:00.000Z',
    lockedAt: isA ? '2026-07-20T17:00:00.000Z' : '2026-07-13T17:00:00.000Z', lockedEntrySha256: (isA ? 'a' : 'b').repeat(64),
    createdAt: isA ? '2026-07-13T07:00:00.000Z' : '2026-07-06T07:00:00.000Z',
    updatedAt: isA ? '2026-07-20T17:00:00.000Z' : '2026-07-13T17:00:00.000Z',
    lockedEntryCount: 1, totalPayableMinutes: isA ? 450 : 300,
    summary: { cardCount: 1, closedCardCount: 1, approvedCardCount: 1, rejectedCardCount: 0, pendingCardCount: 0,
      amendmentCount: 0, pendingAmendmentCount: 0, approvedAmendmentCount: 0, lockedEntryCount: 1 }, exportBatch: batch };
}
function entry(id: string) {
  const isA = id === A;
  return { id: isA ? '96000000-0000-4000-8000-000000000001' : '96000000-0000-4000-8000-000000000002',
    sequence: 0, sourceType: 'TIME_CARD', sourceId: isA ? '97000000-0000-4000-8000-000000000001' : '97000000-0000-4000-8000-000000000002',
    sourceRevision: 3, employeeId: '20000000-0000-4000-8000-000000000001', employeeName: 'Mock Staff', locationId: '10000000-0000-4000-8000-000000000001',
    workTimeZone: POLICY.timeZone, clockInAt: isA ? '2026-07-15T16:00:00.000Z' : '2026-07-08T16:00:00.000Z',
    clockOutAt: isA ? '2026-07-16T00:00:00.000Z' : '2026-07-08T21:30:00.000Z', breakMinutes: 30,
    payableMinutes: isA ? 450 : 300, approvedAt: isA ? '2026-07-20T16:30:00.000Z' : '2026-07-13T16:30:00.000Z',
    approvedByUserId: '20000000-0000-4000-8000-000000000101', canonicalSha256: (isA ? 'c' : 'd').repeat(64) };
}
function exportBatch(id: string, balance: number) {
  const isA = id === A;
  return { id: isA ? EXPORT_A : EXPORT_B, periodId: id, formatVersion: 1, status: 'GENERATED',
    contentSha256: (isA ? 'e' : 'f').repeat(64), rowCount: 1, totalPayableMinutes: isA ? 450 : 300,
    settlement: { consumedCredits: COST, newBalance: balance }, createdAt: '2026-07-21T18:00:00.000Z',
    updatedAt: '2026-07-21T18:00:00.000Z', downloadedAt: null, reconciledAt: null,
    lines: [{ id: isA ? '98000000-0000-4000-8000-000000000001' : '98000000-0000-4000-8000-000000000002',
      lineNumber: 1, lockedEntryId: entry(id).id, employeeId: entry(id).employeeId, payableMinutes: isA ? 450 : 300,
      canonicalSha256: (isA ? '1' : '2').repeat(64), reconciliationStatus: 'PENDING', reconciliationReason: null }],
    nextLineCursor: null, reconciliation: { acceptedCount: 0, rejectedCount: 0, pendingCount: 1,
      providerTotalMinutes: null, latestProvider: null, latestProviderEventId: null, latestPayloadSha256: null } };
}
function detail(id: string, batch: ReturnType<typeof exportBatch> | null) {
  return { period: period(id, batch), cards: [], nextCardCursor: null, lockedEntries: [entry(id)], amendments: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(ok => { resolve = ok; });
  return { promise, resolve };
}
async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded 6s`)), 6000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type Wire = { sequence: number; method: string; url: string; key: string; probe: boolean; body: unknown;
  requestBodySha256: string; csrfPresent: boolean; status: number; authoritativeBodyBase64: string;
  deliveredBodyBase64: string; originalHeaders: Record<string, string>; deliveredHeaders: Record<string, string>;
  effects: number; delivered: boolean };
type Receipt = { visit: string; sequence: number; method: string; url: string; key: string; probe: boolean;
  requestBodySha256: string | null; status: number | null; bodyBase64: string | null; complete: boolean; error: string | null };
type Observer = { receipts: Receipt[]; errors: string[] };
type ObservedWindow = Window & { __payrollResponseObserver?: Observer };
async function observe(page: Page) {
  await page.addInitScript(() => {
    const observer: Observer = { receipts: [], errors: [] }, visit = crypto.randomUUID();
    (window as ObservedWindow).__payrollResponseObserver = observer;
    const originalFetch = window.fetch.bind(window);
    let sequence = 0;
    window.fetch = (input, init) => {
      // The application receives the identical native Promise/Response. Only a
      // Response clone is read; request headers/body and original timing are untouched.
      const pending = originalFetch(input, init);
      try {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), location.href);
        if (url.origin === location.origin && url.pathname.startsWith('/api/v2/payroll/')) {
          const headers = new Headers(init?.headers ?? request?.headers), method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
          const row: Receipt = { visit, sequence: ++sequence, method, url: url.href, key: headers.get('idempotency-key') ?? '',
            probe: headers.has('x-payroll-response-proof'), requestBodySha256: null, status: null, bodyBase64: null, complete: false, error: null };
          observer.receipts.push(row);
          const body = init?.body;
          void pending.then(async response => {
            row.status = response.status;
            const clone = response.clone();
            if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('Unmodeled browser request body');
            if (request && body === undefined && !['GET', 'HEAD'].includes(method)) throw new Error('Unmodeled Request-body observer input');
            const [digest, buffer] = await Promise.all([crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof body === 'string' ? body : '')), clone.arrayBuffer()]);
            row.requestBodySha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
            row.bodyBase64 = btoa(Array.from(new Uint8Array(buffer), value => String.fromCharCode(value)).join(''));
          }).catch(error => { row.error = String(error); }).finally(() => { row.complete = true; });
        }
      } catch (error) { observer.errors.push(String(error)); }
      return pending;
    };
  });
}
async function install(page: Page, mode: Mode) {
  const baselineB = detail(B, null), unaffected = { tenantId: 'unaffected-tenant', usageCredits: 41, creditDebt: 0, exports: [], ledger: [] };
  let wallet = 10, batch: ReturnType<typeof exportBatch> | null = null;
  const debits: Array<{ tenantId: string; periodId: string; exportId: string; amount: number; balanceAfter: number; key: string; body: unknown }> = [];
  const wire: Wire[] = [], failures: unknown[] = [], handlers: Promise<void>[] = [], observed: Receipt[] = [];
  const observerErrors: string[] = [], seen = new Set<string>();
  const ackReady = deferred<Wire>(), readbackReady = deferred<Wire>(), ackRelease = deferred<void>(), readbackRelease = deferred<void>();
  let postKey: string | null = null, readbackHeld = false, closing = false;
  const financial = () => copy({ tenantId: 'tenant-e2e', wallet, creditDebt: 0, a: detail(A, batch), b: baselineB, debits, unaffected });
  const initial = financial();
  const handle = async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), headers = request.headers();
    const probe = Object.hasOwn(headers, PROBE), raw = request.postData() ?? '', key = headers['idempotency-key'] ?? '';
    let payload: unknown, delivered: unknown, status = 200, effects = 0, held: 'ack' | 'readback' | null = null;
    try {
      if (closing) throw new Error('Payroll request arrived after fixture closure');
      if (probe && (method !== 'GET' || url.pathname !== STATE || url.search !== '')) throw new Error('Unmodeled independent probe');
      const queryMatches = (expected: Record<string, string>) => {
        const entries = [...url.searchParams.entries()];
        return entries.length === Object.keys(expected).length && entries.every(([name, value]) =>
          Object.hasOwn(expected, name) && expected[name] === value && url.searchParams.getAll(name).length === 1);
      };
      if (method === 'GET' && url.pathname === STATE && probe) payload = financial();
      else if (method === 'GET' && url.pathname === `${ROOT}/export-entitlement` && url.search === '') payload = { eligible: true, creditCost: COST, reason: 'Synthetic paid entitlement and separately available usage credits.' };
      else if (method === 'GET' && url.pathname === `${ROOT}/policy` && url.search === '') payload = POLICY;
      else if (method === 'GET' && url.pathname === `${ROOT}/policies` && queryMatches({ limit: '25' })) payload = { data: [POLICY], nextCursor: null };
      else if (method === 'GET' && url.pathname === `${ROOT}/periods` && queryMatches({ limit: '25' })) payload = { data: [period(A, batch), period(B)], nextCursor: null };
      else if (method === 'GET' && [A, B].some(id => url.pathname === `${ROOT}/periods/${id}`)
        && queryMatches({ cardLimit: '250', lineLimit: '500' })) {
        const id = url.pathname.endsWith(A) ? A : B;
        payload = detail(id, id === A ? batch : null);
        if (!probe && id === A && batch && mode !== 'positive' && !readbackHeld) {
          readbackHeld = true; held = 'readback';
          if (mode === 'foreign-detail') delivered = detail(B, null);
        }
      } else if (method === 'POST' && url.pathname === POST && url.search === '' && !probe) {
        const body: unknown = JSON.parse(raw);
        if (JSON.stringify(body) !== JSON.stringify({ expectedCreditCost: COST })) throw new Error('Export body must contain only the exact confirmed cost');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw new Error('Missing actual UUID4 export key');
        if (!headers['x-csrf-token'] || !headers['content-type']?.includes('application/json')) throw new Error('Missing actual JSON/CSRF unsafe-request contract');
        if (batch && postKey !== key) throw new Error('Unexpected distinct export attempt after committed canonical batch');
        if (!batch) {
          wallet -= COST; batch = exportBatch(A, wallet); postKey = key; effects = 1;
          debits.push({ tenantId: 'tenant-e2e', periodId: A, exportId: EXPORT_A, amount: -COST, balanceAfter: wallet, key, body });
        }
        // Existing retained-controller/mock201 is intentionally exercised. The
        // native APIv2 route normally returns200; no native status claim is made.
        status = 201; payload = batch; held = 'ack';
        if (mode === 'wrong-period-ack') delivered = exportBatch(B, 77);
        if (mode === 'malformed-ack') delivered = {};
      } else throw new Error(`Unmodeled payroll request ${method} ${url.pathname}${url.search}`);
      delivered ??= payload;
      const authoritativeBytes = Buffer.from(JSON.stringify(payload)), bytes = Buffer.from(JSON.stringify(delivered));
      const originalHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'content-length': String(authoritativeBytes.length) };
      const deliveredHeaders = { ...originalHeaders, 'content-length': String(bytes.length) };
      const row: Wire = { sequence: wire.length + 1, method, url: url.href, key, probe, body: raw ? JSON.parse(raw) as unknown : null,
        requestBodySha256: hash(Buffer.from(raw)), csrfPresent: Boolean(headers['x-csrf-token']), status,
        authoritativeBodyBase64: authoritativeBytes.toString('base64'), deliveredBodyBase64: bytes.toString('base64'),
        originalHeaders, deliveredHeaders, effects, delivered: false };
      wire.push(row);
      if (held === 'ack') { ackReady.resolve(row); await ackRelease.promise; }
      if (held === 'readback') { readbackReady.resolve(row); await readbackRelease.promise; }
      await route.fulfill({ status, headers: deliveredHeaders, body: bytes }); row.delivered = true;
    } catch (error) { failures.push(error); await route.abort().catch(error => failures.push(error)); }
  };
  const handler = (route: Route) => { const pending = handle(route); handlers.push(pending); return pending; };
  await page.route('**/api/v2/payroll/**', handler);
  const read = async () => {
    const result = await page.evaluate(async ({ path, header }) => {
      const response = await fetch(path, { method: 'GET', headers: { [header]: '1' }, cache: 'no-store' });
      if (response.status !== 200) throw new Error('Independent financial GET refused');
      return response.json() as Promise<ReturnType<typeof financial>>;
    }, { path: STATE, header: PROBE });
    return result;
  };
  const collect = async (complete: boolean) => {
    let snapshot: Observer = { receipts: [], errors: [] };
    const take = async () => {
      snapshot = await page.evaluate(() => {
        const state = (window as ObservedWindow).__payrollResponseObserver;
        if (!state) throw new Error('Native fetch observer absent'); return copyObserver(state);
        function copyObserver(value: Observer): Observer { return { receipts: value.receipts.map(row => ({ ...row })), errors: [...value.errors] }; }
      });
      return snapshot.receipts.every(row => row.complete);
    };
    if (complete) await expect.poll(take, { timeout: 6000 }).toBe(true); else await take();
    for (const row of snapshot.receipts) if (row.complete && !seen.has(`${row.visit}:${row.sequence}`)) { seen.add(`${row.visit}:${row.sequence}`); observed.push(row); }
    observerErrors.push(...snapshot.errors);
    return snapshot;
  };
  const decoded = async (row: Wire) => {
    let matched: Receipt[] = [];
    await expect.poll(async () => {
      const state = await collect(false);
      matched = state.receipts.filter(receipt => receipt.method === row.method && receipt.url === row.url && receipt.key === row.key
        && receipt.probe === row.probe && receipt.requestBodySha256 === row.requestBodySha256 && receipt.bodyBase64 === row.deliveredBodyBase64);
      return matched.filter(receipt => receipt.complete);
    }, { timeout: 6000 }).toEqual([expect.objectContaining({ status: row.status, bodyBase64: row.deliveredBodyBase64, complete: true, error: null })]);
    await test.info().attach(`payroll-decoded-${row.sequence}`, { contentType: 'application/json', body: JSON.stringify({ wire: row, nativeFetchClones: matched }) });
  };
  const settle = async () => {
    let count = 0;
    while (count < handlers.length) {
      const batch = handlers.slice(count); count += batch.length;
      const results = await bounded(Promise.allSettled(batch), 'actual route handlers');
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    }
  };
  return { mode, initial, wire, observed, financial: read, ackReady: () => bounded(ackReady.promise, 'issued export'),
    readbackReady: () => bounded(readbackReady.promise, 'ordinary followup detail read'), releaseAck: () => ackRelease.resolve(), releaseReadback: () => readbackRelease.resolve(),
    decoded, collect,
    async close() {
      ackRelease.resolve(); readbackRelease.resolve();
      // Transport fulfillment is not application settlement. Keep the closed
      // routes available until the actual export continuation has completed.
      if (wire.some(row => row.method === 'POST')) {
        await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled({ timeout: 6000 }).catch(error => failures.push(error));
      }
      await settle(); await collect(true).catch(error => failures.push(error)); closing = true;
      await page.unroute('**/api/v2/payroll/**', handler).catch(error => failures.push(error)); await settle();
      await collect(true).catch(error => failures.push(error));
      const signature = (row: { method: string; url: string; key: string; probe: boolean; requestBodySha256: string | null; status: number | null }, body: string | null) =>
        JSON.stringify([row.method, row.url, row.key, row.probe, row.requestBodySha256, row.status, body]);
      const actual = observed.map(row => signature(row, row.bodyBase64)).sort(), expected = wire.filter(row => row.delivered).map(row => signature(row, row.deliveredBodyBase64)).sort();
      await test.info().attach('payroll-full-response-custody', { contentType: 'application/json', body: JSON.stringify({ wire, observed, observerErrors, failures: failures.map(error => String(error)), actual, expected }) });
      expect(actual).toEqual(expected); expect(observed.every(row => row.complete && row.error === null)).toBe(true); expect(observerErrors).toEqual([]);
      if (failures.length) throw new AggregateError(failures, 'Payroll route/observer fixture failed');
    } };
}
type Adapter = Awaited<ReturnType<typeof install>>;
const selector = (page: Page) => page.getByRole('combobox', { name: 'Selected period', exact: true });
const selectedHeading = (page: Page) => page.getByRole('heading', { name: '2026-07-13 to 2026-07-20', exact: true });
const confirmation = (page: Page) => page.getByRole('alertdialog', { name: 'Create the payroll export?', exact: true });
function posts(adapter: Adapter) { return adapter.wire.filter(row => row.method === 'POST'); }
async function storage(page: Page) {
  return page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => {
    const key = sessionStorage.key(index) ?? ''; return { name: key, value: sessionStorage.getItem(key) ?? '' };
  }).filter(row => row.name.startsWith('lunchlineup.payroll-attempt.v3:')));
}
async function expectAttempt(page: Page, row: Wire) {
  const actual = (await storage(page)).map(item => ({ name: item.name, attempt: JSON.parse(item.value) as unknown }));
  expect(actual).toEqual([{ name: `lunchlineup.payroll-attempt.v3:export:${hash(Buffer.from(A))}`,
    attempt: { action: 'export', key: row.key,
      payloadDigest: hash(Buffer.from(JSON.stringify({ expectedCreditCost: COST, periodId: A }))) } }]);
}
async function oneSettlement(page: Page, adapter: Adapter, row: Wire) {
  const state = await adapter.financial();
  expect(state.wallet).toBe(9); expect(state.creditDebt).toBe(0); expect(state.a).toEqual(detail(A, exportBatch(A, 9)));
  expect(state.b).toEqual(adapter.initial.b); expect(state.unaffected).toEqual(adapter.initial.unaffected);
  expect(state.debits).toEqual([{ tenantId: 'tenant-e2e', periodId: A, exportId: EXPORT_A, amount: -1, balanceAfter: 9, key: row.key, body: { expectedCreditCost: 1 } }]);
  expect(posts(adapter)).toHaveLength(1); expect(posts(adapter)[0]).toBe(row); expect(row.effects).toBe(1);
  await test.info().attach('payroll-independent-financial-readback', { contentType: 'application/json', body: JSON.stringify(state) });
}
async function issued(page: Page, adapter: Adapter) {
  await expect(selector(page)).toHaveValue(A); await expect(selectedHeading(page)).toBeVisible();
  await page.getByRole('button', { name: 'Create payroll export', exact: true }).click();
  await expect(confirmation(page)).toContainText('uses 1 credit');
  await confirmation(page).getByRole('button', { name: 'Create export', exact: true }).click();
  const row = await adapter.ackReady();
  expect(new URL(row.url).pathname).toBe(POST); expect(row.method).toBe('POST'); expect(row.body).toEqual({ expectedCreditCost: 1 });
  expect(row.key).toMatch(/^[0-9a-f-]{36}$/i); expect(row.csrfPresent).toBe(true); expect(row.status).toBe(201);
  await expectAttempt(page, row);
  await oneSettlement(page, adapter, row); return row;
}
async function snapshot(page: Page, adapter: Adapter, label: string) {
  const evidence = { label, mode: adapter.mode, ui: await page.locator('main').innerText({ timeout: 3000 }),
    storage: await storage(page), financial: await adapter.financial(), clones: await adapter.collect(false), wire: adapter.wire };
  await test.info().attach(label, { contentType: 'application/json', body: JSON.stringify(evidence) });
  await test.info().attach(`${label}-viewport`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
}
async function verifiedA(page: Page) {
  await expect(selector(page)).toHaveValue(A); await expect(selectedHeading(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: '2026-07-06 to 2026-07-13', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Export ready', exact: true })).toBeVisible();
  const details = page.getByRole('region', { name: 'Export ready', exact: true });
  await expect(details.locator('dl > div').filter({ has: page.getByText('Credits used', { exact: true }) }).locator('dd')).toHaveText('1');
  await expect(details.locator('dl > div').filter({ has: page.getByText('Credit balance', { exact: true }) }).locator('dd')).toHaveText('9');
  const audit = page.locator('details').filter({ has: page.getByText('Audit details', { exact: true }) });
  if (await audit.getAttribute('open') === null) await audit.locator('summary').click();
  await expect(audit.locator('code').filter({ hasText: 'e'.repeat(64) })).toHaveCount(1);
  await expect(audit.locator('code').filter({ hasText: 'f'.repeat(64) })).toHaveCount(0);
}
async function reloadVerified(page: Page, adapter: Adapter, row: Wire) {
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await adapter.collect(true); await page.reload(); await verifiedA(page); await oneSettlement(page, adapter, row);
}
async function layout(page: Page) {
  const original = page.viewportSize(); if (!original) throw new Error('Canonical viewport absent');
  const widths = test.info().project.name === 'chromium' ? [...new Set([320, 393, original.width])] : [original.width];
  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height: original.height });
      const select: Locator = selector(page), action = page.getByRole('button', { name: 'Create payroll export', exact: true });
      await expect(select).toBeEnabled(); await expect(action).toBeEnabled();
      await select.focus(); const trail = [];
      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press('Tab'); trail.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''));
        if (await action.evaluate(node => document.activeElement === node)) break;
      }
      const box = await action.boundingBox();
      await test.info().attach(`payroll-${width}-keyboard-geometry`, { contentType: 'application/json', body: JSON.stringify({ width, box, trail, viewport: page.viewportSize() }) });
      await test.info().attach(`payroll-${width}-keyboard-viewport`, { contentType: 'image/png', body: await page.screenshot({ timeout: 5000 }) });
      await expect(action).toBeFocused(); await expect(action).toBeInViewport({ ratio: 1 });
      expect(box).not.toBeNull(); if (!box) throw new Error('Export control rectangle absent');
      if (width <= 768) { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); }
      const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(size.scroll).toBeLessThanOrEqual(size.client);
    }
  } finally { await page.setViewportSize(original); }
}
async function scenario(page: Page, mode: Mode, run: (adapter: Adapter) => Promise<void>) {
  const pageErrors: string[] = [], consoleErrors: Array<{ text: string; url: string }> = [], requestFailures: string[] = [];
  const onError = (error: Error) => pageErrors.push(String(error));
  const onConsole = (message: ConsoleMessage) => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url }); };
  const onRequest = (request: PlaywrightRequest) => { if (new URL(request.url()).pathname.startsWith(ROOT + '/')) requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`); };
  page.on('pageerror', onError); page.on('console', onConsole); page.on('requestfailed', onRequest);
  await observe(page); const adapter = await install(page, mode);
  let failed = false, primary: unknown;
  const secondary: unknown[] = [];
  try {
    await loginAsSeedAdmin(page, '/dashboard/payroll'); await expect(selectedHeading(page)).toBeVisible();
    await expect(selector(page)).toHaveValue(A); expect(await adapter.financial()).toEqual(adapter.initial);
    await run(adapter);
  } catch (error) { failed = true; primary = error; }
  finally {
    // Capture the original failure/UI before releasing the ordinary readback
    // that may replace a foreign/default batch. Always release and join handlers.
    try { await snapshot(page, adapter, 'payroll-terminal-before-gate-release'); } catch (error) { secondary.push(error); }
    adapter.releaseAck(); adapter.releaseReadback();
    try { await adapter.close(); } catch (error) { secondary.push(error); }
    try {
      await test.info().attach('payroll-browser-diagnostics', { contentType: 'application/json', body: JSON.stringify({ pageErrors, consoleErrors, requestFailures }) });
      expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([]); expect(requestFailures).toEqual([]);
    } catch (error) { secondary.push(error); }
    page.off('pageerror', onError); page.off('console', onConsole); page.off('requestfailed', onRequest);
  }
  if (secondary.length) throw new AggregateError(failed ? [primary, ...secondary] : secondary, 'Payroll reproduction/cleanup failed', failed ? { cause: primary } : undefined);
  if (failed) throw primary;
}

test.describe('Payroll export response custody', () => {
  test.skip(!mockMode, 'Closed local response-boundary fixture requires canonical mock mode; no native acceptance credit.');
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    const reset = await page.request.post('/api/v1/__e2e/reset'); expect(reset.status()).toBe(200);
  });
  test('cancels then creates only the exact selected payroll export with one settlement and reload', async ({ page }) => {
    await scenario(page, 'positive', async adapter => {
      await layout(page);
      await page.getByRole('button', { name: 'Create payroll export', exact: true }).click();
      await expect(confirmation(page)).toContainText('uses 1 credit'); await confirmation(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(confirmation(page)).toHaveCount(0); expect(posts(adapter)).toHaveLength(0); expect(await adapter.financial()).toEqual(adapter.initial);
      const row = await issued(page, adapter); adapter.releaseAck(); await adapter.decoded(row);
      await expect(page.getByRole('status').filter({ hasText: 'Payroll export created for 1 credit; balance 9.' })).toBeVisible();
      await verifiedA(page); expect(await storage(page)).toEqual([]);
      await selector(page).selectOption(B); await expect(page.getByRole('heading', { name: '2026-07-06 to 2026-07-13', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Export ready', exact: true })).toHaveCount(0);
      await selector(page).selectOption(A); await verifiedA(page); await reloadVerified(page, adapter, row);
    });
  });
  test('rejects a foreign-period export acknowledgement before ordinary readback can mask it', async ({ page }) => {
    await scenario(page, 'wrong-period-ack', async adapter => {
      const row = await issued(page, adapter); expect(JSON.parse(Buffer.from(row.deliveredBodyBase64, 'base64').toString())).toEqual(exportBatch(B, 77));
      adapter.releaseAck(); await adapter.decoded(row); await adapter.readbackReady();
      await snapshot(page, adapter, 'wrong-period-ack-before-correct-readback'); await oneSettlement(page, adapter, row);
      await expect(page.getByRole('status').filter({ hasText: EXPORT_SUCCESS_NOTICE })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Export ready', exact: true })).toHaveCount(0);
      await expectAttempt(page, row);
      adapter.releaseReadback(); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      await expect(page.getByRole('main').getByRole('alert')).toBeVisible(); await verifiedA(page); await reloadVerified(page, adapter, row);
    });
  });
  test('retains an unconfirmed exact attempt after a malformed committed acknowledgement without another charge', async ({ page }) => {
    await scenario(page, 'malformed-ack', async adapter => {
      const row = await issued(page, adapter); expect(Buffer.from(row.deliveredBodyBase64, 'base64').toString()).toBe('{}');
      adapter.releaseAck(); await adapter.decoded(row); await adapter.readbackReady();
      await snapshot(page, adapter, 'malformed-ack-before-correct-readback'); await oneSettlement(page, adapter, row);
      await expect(page.getByRole('status').filter({ hasText: EXPORT_SUCCESS_NOTICE })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Export ready', exact: true })).toHaveCount(0);
      await expectAttempt(page, row);
      adapter.releaseReadback(); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      await expect(page.getByRole('main').getByRole('alert')).toBeVisible(); await verifiedA(page); await reloadVerified(page, adapter, row);
    });
  });
  test('keeps the acknowledged A export terminal when its detail request returns foreign period B', async ({ page }) => {
    await scenario(page, 'foreign-detail', async adapter => {
      const row = await issued(page, adapter); expect(JSON.parse(Buffer.from(row.deliveredBodyBase64, 'base64').toString())).toEqual(exportBatch(A, 9));
      adapter.releaseAck(); await adapter.decoded(row); const followup = await adapter.readbackReady();
      await verifiedA(page); expect(await storage(page)).toEqual([]);
      expect(JSON.parse(Buffer.from(followup.authoritativeBodyBase64, 'base64').toString())).toEqual(detail(A, exportBatch(A, 9)));
      expect(JSON.parse(Buffer.from(followup.deliveredBodyBase64, 'base64').toString())).toEqual(detail(B, null));
      adapter.releaseReadback(); await adapter.decoded(followup);
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      await snapshot(page, adapter, 'foreign-detail-after-valid-ack'); await oneSettlement(page, adapter, row);
      await verifiedA(page); await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Payroll export created for 1 credit; balance 9.' })).toBeVisible();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await verifiedA(page); await reloadVerified(page, adapter, row);
    });
  });
});
