import type { Locator } from '@playwright/test';
import { expect, test, type Page, type Route } from './qa-isolation-fixture';
import { loginAsSeedAdmin, runFullStack } from './support';

// Closed HTTP model + real browser/client/React. No native DB/session, quota,
// scheduling-history or production qualification is claimed by these cases.
// Strict regression assertions: no expected-fail, retry or timeout overrides.
const mockMode = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const ROOT = '/api/v2/locations', STATE = `${ROOT}/__custody/state`;
const PROBE = 'x-location-custody-probe', WIRE = 'x-location-custody-wire';
const A = '91000000-0000-4000-8000-000000000001', B = '91000000-0000-4000-8000-000000000002';
const V1 = '2026-07-20T10:00:00.000Z', V2 = '2026-07-20T11:00:00.000Z', V3 = '2026-07-20T12:00:00.000Z';
const STALE = 'This location changed while you were editing. Your draft has not been saved. Cancel this edit and refresh Locations before trying again.';
type Location = { id: string; name: string; address: string | null; timezone: string; createdAt: string; updatedAt: string };
type Draft = { name: string; address: string; timezone: string };
type WriteBody = Draft & { expectedUpdatedAt: string };
type Wire = { sequence: number; method: string; path: string; rawBody: string; body: unknown;
  csrfPresent: boolean; status: number; authoritative: unknown; delivered: unknown; deliveredBytes: string; complete: boolean };
type Model = { rows: Location[]; commits: Array<{ source: 'operator' | 'competing-editor'; before: Location; after: Location }> };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const baseline: Location[] = [
  { id: A, name: 'Custody Alpha', address: '10 Original Lane', timezone: 'America/Chicago', createdAt: V1, updatedAt: V1 },
  { id: B, name: 'Custody Beta', address: '20 Unchanged Lane', timezone: 'America/Denver', createdAt: V1, updatedAt: V1 },
];
const draft: Draft = { name: 'Custody Alpha edited', address: '11 Saved Lane', timezone: 'America/New_York' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within 5s`)), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function gate() { return { ready: deferred<Wire>(), release: deferred<void>() }; }
type Gate = ReturnType<typeof gate>;

async function install(page: Page, wrongTargetAck = false) {
  const model: Model = { rows: clone(baseline), commits: [] };
  const wire: Wire[] = [], failures: unknown[] = [], handlers: Promise<void>[] = [];
  const pageErrors: string[] = [], gates: Gate[] = [];
  let nextList: Gate | null = null, nextWrite: Gate | null = null;
  const pageError = (error: Error) => { pageErrors.push(String(error)); };
  page.on('pageerror', pageError);
  const snapshot = () => clone(model);
  const handle = async (route: Route) => {
    const request = route.request(), url = new URL(request.url());
    const method = request.method(), rawBody = request.postData() ?? '', headers = request.headers();
    let authoritative: unknown, delivered: unknown, status = 200, held: Gate | null = null;
    try {
      if (Object.hasOwn(headers, PROBE)) {
        if (method !== 'GET' || url.pathname !== STATE || url.search !== '') throw new Error('Unexpected independent probe');
        authoritative = snapshot();
      } else if (method === 'GET' && url.pathname === ROOT && url.search === '?limit=100') {
        authoritative = { data: clone(model.rows), pagination: { limit: 100, maxLimit: 200, returned: model.rows.length, hasMore: false, nextCursor: null } };
        held = nextList; nextList = null;
      } else if (method === 'PUT' && url.pathname === `${ROOT}/${A}` && url.search === '') {
        held = nextWrite; nextWrite = null;
        if (!held) throw new Error('Unexpected extra or unarmed location write');
        if (!headers['x-csrf-token'] || !headers['content-type']?.includes('application/json')) throw new Error('Missing actual CSRF/JSON write headers');
        const body = JSON.parse(rawBody) as WriteBody;
        if (Object.keys(body).sort().join(',') !== 'address,expectedUpdatedAt,name,timezone'
          || typeof body.name !== 'string' || typeof body.address !== 'string'
          || typeof body.timezone !== 'string' || typeof body.expectedUpdatedAt !== 'string') throw new Error('Unexpected location update shape');
        const before = clone(model.rows[0]);
        if (body.expectedUpdatedAt !== before.updatedAt) {
          status = 409;
          authoritative = { type: 'https://lunchlineup.com/problems/location-changed', title: 'Location changed', status,
            detail: STALE, message: STALE, instance: `/v2/locations/${A}`, code: 'location_changed', requestId: 'location-custody-stale' };
        } else {
          const after: Location = { ...before, name: body.name, address: body.address, timezone: body.timezone,
            updatedAt: before.updatedAt === V1 ? V2 : V3 };
          model.rows[0] = after;
          model.commits.push({ source: 'operator', before, after: clone(after) });
          authoritative = clone(after);
          // A really committed; only its response is replaced. This must not
          // pretend that rejecting an unbound ACK rolls the server write back.
          if (wrongTargetAck) delivered = { ...after, id: B };
        }
      } else throw new Error(`Unmodeled location request ${method} ${url.pathname}${url.search}`);
      delivered ??= authoritative;
      const row: Wire = { sequence: wire.length + 1, method, path: url.pathname + url.search,
        rawBody, body: rawBody ? JSON.parse(rawBody) as unknown : null, csrfPresent: Boolean(headers['x-csrf-token']),
        status, authoritative: clone(authoritative), delivered: clone(delivered), deliveredBytes: JSON.stringify(delivered), complete: false };
      wire.push(row);
      if (held) { held.ready.resolve(row); await bounded(held.release.promise, 'held location delivery'); }
      await route.fulfill({ status, headers: { 'content-type': status === 409 ? 'application/problem+json' : 'application/json',
        'cache-control': 'private, no-store', [WIRE]: String(row.sequence) }, body: row.deliveredBytes });
      row.complete = true;
    } catch (error) {
      failures.push(error);
      try { await route.abort(); } catch (abortError) { failures.push(abortError); }
    }
  };
  const handler = (route: Route) => { const pending = handle(route); handlers.push(pending); return pending; };
  await page.route('**/api/v2/locations**', handler);
  const read = () => bounded(page.evaluate(async ({ path, header }) => {
    const response = await fetch(path, { headers: { [header]: '1' }, cache: 'no-store' });
    if (response.status !== 200) throw new Error('Independent model readback refused');
    return response.json() as Promise<Model>;
  }, { path: STATE, header: PROBE }), 'independent location readback');
  return {
    wire, read,
    holdList() { if (nextList) throw new Error('List already armed'); const value = gate(); gates.push(value); nextList = value; return value; },
    holdWrite() { if (nextWrite) throw new Error('Write already armed'); const value = gate(); gates.push(value); nextWrite = value; return value; },
    advanceCompetingEditor() {
      if (model.rows[0].updatedAt !== V1 || model.commits.length) throw new Error('Competing edit must begin from V1');
      const before = clone(model.rows[0]);
      const after = { ...before, name: 'Custody Alpha competing', address: '12 Competing Lane', updatedAt: V2 };
      model.rows[0] = after; model.commits.push({ source: 'competing-editor', before, after: clone(after) });
    },
    async deliver(value: Gate) {
      const row = await bounded(value.ready.promise, 'issued location request');
      const received = page.waitForResponse(response => response.headers()[WIRE] === String(row.sequence), { timeout: 5000 });
      value.release.resolve();
      const response = await received;
      expect(response.request().method()).toBe(row.method);
      expect(new URL(response.url()).pathname + new URL(response.url()).search).toBe(row.path);
      expect(response.status()).toBe(row.status);
      expect(await response.finished()).toBeNull();
      expect(await response.text()).toBe(row.deliveredBytes);
      return row;
    },
    async close() {
      for (const value of gates) value.release.resolve();
      // Release pending routes even on a primary assertion failure, then retain
      // every transport/cleanup failure alongside that primary failure.
      let settled = 0;
      const settle = async () => {
        while (settled < handlers.length) {
          const batch = handlers.slice(settled); settled += batch.length;
          const results = await bounded(Promise.allSettled(batch), 'location route drain');
          for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
        }
      };
      try { await settle(); } catch (error) { failures.push(error); }
      if (wire.some(row => row.method === 'PUT')) {
        try { await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toHaveCount(0); }
        catch (error) { failures.push(error); }
      }
      if (wire.some(row => row.path === `${ROOT}?limit=100`)) {
        try { await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled(); }
        catch (error) { failures.push(error); }
      }
      try { await settle(); } catch (error) { failures.push(error); }
      try { await page.unroute('**/api/v2/locations**', handler); } catch (error) { failures.push(error); }
      try { await settle(); } catch (error) { failures.push(error); }
      page.off('pageerror', pageError);
      try {
        await test.info().attach('location-response-custody', { contentType: 'application/json', body: JSON.stringify({
          wire, model: snapshot(), pageErrors, failures: failures.map(String), scope: 'Closed mock/browser proof; native qualification pending.' }) });
      } catch (error) { failures.push(error); }
      if (pageErrors.length) failures.push(new Error(`Browser page errors: ${pageErrors.join('\n')}`));
      if (failures.length) throw new AggregateError(failures, 'Location fixture or cleanup failed');
    },
  };
}
type Adapter = Awaited<ReturnType<typeof install>>;
const card = (page: Page, id: string) => page.getByRole('article').filter({ has: page.locator(`a[href="/dashboard/scheduling?location=${id}"]`) });
const form = (page: Page, name = baseline[0].name) => page.getByRole('form', { name: `Edit ${name}`, exact: true });
const writes = (adapter: Adapter) => adapter.wire.filter(row => row.method === 'PUT');
async function assertDraft(edit: Locator, values: Draft) {
  await expect(edit.getByLabel('Location name', { exact: true })).toHaveValue(values.name);
  await expect(edit.getByLabel('Address', { exact: true })).toHaveValue(values.address);
  await expect(edit.getByLabel('IANA timezone', { exact: true })).toHaveValue(values.timezone);
}
async function assertUntouchedB(page: Page) {
  await expect(card(page, B).getByRole('heading', { name: baseline[1].name, exact: true })).toBeVisible();
  await expect(card(page, B)).toContainText(baseline[1].address!);
  await expect(card(page, B)).toContainText(`Timezone: ${baseline[1].timezone}`);
}
async function typeDraft(edit: Locator, values: Draft) {
  for (const [label, value] of [['Location name', values.name], ['Address', values.address], ['IANA timezone', values.timezone]]) {
    const input = edit.getByLabel(label, { exact: true });
    await input.fill(''); await input.pressSequentially(value);
  }
  await assertDraft(edit, values);
}
function assertWrite(row: Wire, values: Draft, version: string, status = 200) {
  expect(row).toMatchObject({ method: 'PUT', path: `${ROOT}/${A}`, csrfPresent: true, status });
  expect(row.body).toEqual({ ...values, expectedUpdatedAt: version });
  expect(JSON.parse(row.rawBody)).toEqual(row.body);
}
async function begin(page: Page, adapter: Adapter) {
  await loginAsSeedAdmin(page, '/dashboard/locations');
  await expect(card(page, A).getByRole('heading', { name: baseline[0].name, exact: true })).toBeVisible();
  await expect(card(page, B).getByRole('heading', { name: baseline[1].name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  expect(await adapter.read()).toEqual({ rows: baseline, commits: [] });
}
async function inModel(page: Page, wrongAck: boolean, run: (adapter: Adapter) => Promise<void>) {
  const adapter = await install(page, wrongAck);
  let primary: unknown;
  try { await begin(page, adapter); await run(adapter); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await adapter.close(); }
    catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 'Location assertion and cleanup failed');
      throw cleanupError;
    }
  }
}

test.describe('Location response browser custody', () => {
  test.skip(!mockMode, 'Closed local mock cases are separate from native qualification.');
  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok()).toBeTruthy();
  });

  test('keeps a confirmed location edit after an older refresh finishes', async ({ page }) => {
    await inModel(page, false, async adapter => {
      const refresh = adapter.holdList();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      const oldList = await bounded(refresh.ready.promise, 'refresh snapshot');
      expect(oldList.authoritative).toMatchObject({ data: baseline });
      await card(page, A).getByRole('button', { name: 'Edit', exact: true }).click();
      await typeDraft(form(page), draft);
      const ack = adapter.holdWrite();
      await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
      const issued = await bounded(ack.ready.promise, 'edit request');
      assertWrite(issued, draft, V1);
      await expect(form(page).getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
      const saved = await adapter.read();
      expect(saved.rows).toEqual([{ ...baseline[0], ...draft, updatedAt: V2 }, baseline[1]]);
      await adapter.deliver(ack);
      await expect(page.getByRole('status')).toHaveText('Location updated.');
      await expect(card(page, A).getByRole('heading', { name: draft.name, exact: true })).toBeVisible();
      await adapter.deliver(refresh);
      // Refresh enabled is the application finally/render barrier, not merely
      // route.fulfill completion. The old response must not revert saved fields.
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      await expect(card(page, A).getByRole('heading', { name: draft.name, exact: true })).toBeVisible();
      await expect(card(page, A)).toContainText(draft.address);
      await expect(card(page, A)).toContainText(`Timezone: ${draft.timezone}`);
      await assertUntouchedB(page);
      expect(await adapter.read()).toEqual(saved);
      expect(writes(adapter)).toHaveLength(1);
    });
  });

  test('refuses a different location in the update acknowledgment without discarding the typed draft', async ({ page }) => {
    await inModel(page, true, async adapter => {
      await card(page, A).getByRole('button', { name: 'Edit', exact: true }).click();
      await typeDraft(form(page), draft);
      const ack = adapter.holdWrite();
      await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
      const issued = await bounded(ack.ready.promise, 'wrong-target request');
      assertWrite(issued, draft, V1);
      expect(issued.authoritative).toMatchObject({ id: A, ...draft, updatedAt: V2 });
      expect(issued.delivered).toEqual({ ...(issued.authoritative as Location), id: B });
      await expect(form(page).getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
      const saved = await adapter.read();
      expect(saved.rows).toEqual([{ ...baseline[0], ...draft, updatedAt: V2 }, baseline[1]]);
      await adapter.deliver(ack);
      await expect(form(page).getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
      await assertDraft(form(page), draft);
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('status')).toHaveCount(0);
      await assertUntouchedB(page);
      expect(await adapter.read()).toEqual(saved);
      expect(saved.commits).toHaveLength(1);
      expect(writes(adapter)).toHaveLength(1);
    });
  });

  test('preserves a stale-version draft and uses the refreshed version only after an explicit new save', async ({ page }) => {
    await inModel(page, false, async adapter => {
      await card(page, A).getByRole('button', { name: 'Edit', exact: true }).click();
      await typeDraft(form(page), draft);
      adapter.advanceCompetingEditor();
      const competing = await adapter.read();
      expect(competing.rows[0]).toMatchObject({ id: A, name: 'Custody Alpha competing', updatedAt: V2 });
      const refused = adapter.holdWrite();
      await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
      const issued = await bounded(refused.ready.promise, 'stale edit request');
      assertWrite(issued, draft, V1, 409);
      await expect(form(page).getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
      await adapter.deliver(refused);
      await expect(form(page).getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
      await expect(page.getByRole('alert')).toHaveText(STALE);
      await assertDraft(form(page), draft);
      await expect(page.getByRole('status')).toHaveCount(0);
      expect(await adapter.read()).toEqual(competing);
      expect(writes(adapter)).toHaveLength(1);
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(card(page, A).getByRole('heading', { name: competing.rows[0].name, exact: true })).toBeVisible();
      await card(page, A).getByRole('button', { name: 'Edit', exact: true }).click();
      const freshForm = form(page, competing.rows[0].name);
      await assertDraft(freshForm, { name: competing.rows[0].name, address: competing.rows[0].address!, timezone: competing.rows[0].timezone });
      await typeDraft(freshForm, draft);
      expect(writes(adapter)).toHaveLength(1);
      const accepted = adapter.holdWrite();
      await freshForm.getByRole('button', { name: 'Save changes', exact: true }).click();
      assertWrite(await bounded(accepted.ready.promise, 'fresh edit request'), draft, V2);
      await expect(freshForm.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
      await adapter.deliver(accepted);
      await expect(page.getByRole('status')).toHaveText('Location updated.');
      await expect(card(page, A).getByRole('heading', { name: draft.name, exact: true })).toBeVisible();
      const saved = await adapter.read();
      expect(saved.rows).toEqual([{ ...baseline[0], ...draft, updatedAt: V3 }, baseline[1]]);
      expect(saved.commits.map(row => row.source)).toEqual(['competing-editor', 'operator']);
      await assertUntouchedB(page);
      expect(writes(adapter)).toHaveLength(2);
    });
  });

  test('accepts a same-target location acknowledgment and restores saved fields on reopen', async ({ page }) => {
    await inModel(page, false, async adapter => {
      await card(page, A).getByRole('button', { name: 'Edit', exact: true }).click();
      await typeDraft(form(page), draft);
      const ack = adapter.holdWrite();
      await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
      const issued = await bounded(ack.ready.promise, 'positive edit request');
      assertWrite(issued, draft, V1);
      expect(issued.delivered).toEqual(issued.authoritative);
      await expect(form(page).getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
      const saved = await adapter.read();
      expect(saved.rows).toEqual([{ ...baseline[0], ...draft, updatedAt: V2 }, baseline[1]]);
      expect(saved.commits).toHaveLength(1);
      await adapter.deliver(ack);
      await expect(page.getByRole('status')).toHaveText('Location updated.');
      await expect(form(page)).toHaveCount(0);
      await card(page, A).getByRole('button', { name: 'Edit', exact: true }).click();
      await assertDraft(form(page, draft.name), draft);
      await form(page, draft.name).getByRole('button', { name: 'Cancel', exact: true }).click();
      await assertUntouchedB(page);
      expect(await adapter.read()).toEqual(saved);
      expect(writes(adapter)).toHaveLength(1);
    });
  });
});
