import { createHash, randomUUID } from 'node:crypto';
import type { APIResponse, Locator } from '@playwright/test';
import type {
  ProblemDetails, ScheduleBoardResponse, ScheduleChangeSetRequest,
  ScheduleChangeSetResponse, ScheduleCreateResponse,
} from '@lunchlineup/api-contract';
import { expect, test, type Page, type Route } from './qa-isolation-fixture';
import { apiJson, loginAsSeedAdmin, runFullStack } from './support';

// Local React/DOM and state-backed mock HTTP evidence only. No native admission,
// durable SQL/replay proof or forced React enqueue-before-commit proof is issued.
const mockMode = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const DATE = '2030-01-15';
const LOCATION = '10000000-0000-4000-8000-000000000001';
const STAFF = '20000000-0000-4000-8000-000000000001';
const MANAGER = '20000000-0000-4000-8000-000000000002';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE = `/dashboard/scheduling?date=${DATE}&location=${LOCATION}`;
const BOARD = `/api/v2/schedule-board?date=${DATE}&view=threeDay&locationId=${LOCATION}`;
const A = { userId: STAFF, role: 'STAFF', startTime: '2030-01-15T17:00:00.000Z', endTime: '2030-01-16T01:00:00.000Z' };
const B = { userId: MANAGER, role: 'MANAGER', startTime: '2030-01-15T18:00:00.000Z', endTime: '2030-01-16T02:00:00.000Z' };
const UPDATED_A_END = '2030-01-16T00:00:00.000Z';
const UPDATED_B = { startTime: '2030-01-15T19:00:00.000Z', endTime: '2030-01-16T03:00:00.000Z' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  // A handler can fail before its observation is awaited; retain the rejection
  // for the caller without generating a detached unhandled rejection.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

type IssuedRequest = { path: string; key: string; ifMatch: string | null; body: unknown };
type RetainedMutation<T> = { request: IssuedRequest; status: number; bytes: Buffer; payload: T };

async function holdMutation<T>(page: Page, endpoint: string, pauseBeforeFetch = false) {
  const observed = deferred<IssuedRequest>();
  const retained = deferred<RetainedMutation<T>>();
  const finished = deferred<void>();
  const forward = deferred<void>();
  const delivery = deferred<void>();
  let count = 0;
  let record: RetainedMutation<T> | undefined;
  const handlerSettlements: Promise<void>[] = [];
  const cleanupFailures: unknown[] = [];
  if (!pauseBeforeFetch) forward.resolve();
  const handleRoute = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    count += 1;
    let response: APIResponse | undefined;
    try {
      if (count !== 1) throw new Error('Unexpected second matching mutation while the first response is held.');
      const request = route.request();
      const issued = {
        path: new URL(request.url()).pathname,
        key: request.headers()['idempotency-key'] ?? '',
        ifMatch: request.headers()['if-match'] ?? null,
        body: request.postDataJSON() as unknown,
      };
      observed.resolve(issued);
      await forward.promise;
      response = await route.fetch({ maxRetries: 0, timeout: 10_000 });
      const bytes = await response.body();
      record = { request: issued, status: response.status(), bytes, payload: JSON.parse(bytes.toString('utf8')) as T };
      retained.resolve(record);
      await delivery.promise;
      // Deliver the actual retained status, headers and complete body. Do not
      // fabricate a success or re-read a browser protocol resource after navigation.
      await route.fulfill({ response, body: bytes });
      await response.dispose();
      response = undefined;
      finished.resolve();
    } catch (error) {
      observed.reject(error); retained.reject(error); finished.reject(error);
      await route.abort().catch(error => cleanupFailures.push(error));
    } finally {
      if (response) await response.dispose().catch(error => {
        cleanupFailures.push(error); finished.reject(error);
      });
    }
  };
  const handler = (route: Route) => {
    const settlement = handleRoute(route);
    handlerSettlements.push(settlement);
    return settlement;
  };
  await page.route(endpoint, handler);
  return {
    observed: observed.promise, retained: retained.promise, finished: finished.promise,
    forward: () => forward.resolve(), release: () => delivery.resolve(),
    async close() {
      forward.resolve(); delivery.resolve();
      let failure: unknown;
      let failed = false;
      try { if (count) await finished.promise; }
      catch (error) { failed = true; failure = error; }
      // finished is a protocol result, not handler-settlement proof. Await the
      // actual handler promises including abort/dispose before removing the route.
      let settledCount = 0;
      const settleHandlers = async () => {
        while (settledCount < handlerSettlements.length) {
          const batch = handlerSettlements.slice(settledCount);
          settledCount += batch.length;
          const outcomes = await Promise.allSettled(batch);
          for (const outcome of outcomes) if (outcome.status === 'rejected') cleanupFailures.push(outcome.reason);
        }
      };
      await settleHandlers();
      try { await page.unroute(endpoint, handler); }
      catch (error) { cleanupFailures.push(error); }
      // Account for a handler delivered while the unroute command was pending.
      await settleHandlers();
      if (record) await test.info().attach('held-calendar-mutation', {
        body: JSON.stringify({ request: record.request, status: record.status, bytes: record.bytes.length,
          bodyBase64: record.bytes.toString('base64') }), contentType: 'application/json',
      });
      if (cleanupFailures.length) {
        await test.info().attach('calendar-gate-cleanup-failures', {
          body: JSON.stringify(cleanupFailures.map(error => String(error))), contentType: 'application/json',
        });
        if (failed) throw new AggregateError([failure, ...cleanupFailures], 'Calendar mutation and cleanup failed.', { cause: failure });
        throw new AggregateError(cleanupFailures, 'Calendar gate cleanup failed.');
      }
      if (failed) throw failure;
      if (count) expect(count, 'exactly one held mutation').toBe(1);
    },
  };
}

async function board(page: Page) {
  return apiJson<ScheduleBoardResponse>(page, 'GET', BOARD);
}

async function prepare(page: Page, withSchedule: boolean, withShifts = false) {
  await loginAsSeedAdmin(page, PAGE);
  await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
  const initial = await board(page);
  expect(initial.data.selectedLocationId).toBe(LOCATION);
  expect(initial.data.locations.find(location => location.id === LOCATION)?.timezone).toBe('America/Los_Angeles');
  expect(initial.data.staff).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: STAFF, name: 'Mock Staff', role: 'STAFF' }),
    expect.objectContaining({ id: MANAGER, name: 'Mock Manager', role: 'MANAGER' }),
  ]));
  expect(initial.data.schedules).toHaveLength(0);
  expect(initial.data.shifts).toHaveLength(0);
  if (!withSchedule) return null;
  const schedule = await apiJson<ScheduleCreateResponse>(page, 'POST', `/api/v2/locations/${LOCATION}/schedules`,
    { startDate: '2030-01-15T08:00:00.000Z', endDate: '2030-01-17T08:00:00.000Z' }, 200,
    { 'Idempotency-Key': randomUUID() });
  let aId = ''; let bId = '';
  let revision = 0; let etag = schedule.data.etag;
  if (withShifts) {
    const aClient = randomUUID(); const bClient = randomUUID();
    const seeded = await apiJson<ScheduleChangeSetResponse>(page, 'POST', `/api/v2/schedules/${schedule.data.id}/change-sets`,
      { operations: [{ op: 'shift.create', clientId: aClient, ...A }, { op: 'shift.create', clientId: bClient, ...B }] }, 200,
      { 'Idempotency-Key': randomUUID(), 'If-Match': etag });
    aId = seeded.data.created.find(row => row.clientId === aClient)?.shiftId ?? '';
    bId = seeded.data.created.find(row => row.clientId === bClient)?.shiftId ?? '';
    expect(aId).toMatch(UUID); expect(bId).toMatch(UUID);
    revision = seeded.data.revision; etag = seeded.data.etag;
  }
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add shift', exact: true })).toBeEnabled();
  return { scheduleId: schedule.data.id, aId, bId, revision, etag };
}

function editor(page: Page) { return page.getByRole('dialog').locator('form.shift-form'); }
async function fillDraft(form: Locator, userId: string, role: string, start: string, end: string) {
  await form.getByLabel('Staff', { exact: true }).selectOption(userId);
  await form.getByLabel('Shift role', { exact: true }).selectOption(role);
  await form.getByLabel('Date', { exact: true }).fill(DATE);
  await form.getByLabel('Start', { exact: true }).fill(start);
  await form.getByLabel('End', { exact: true }).fill(end);
}
async function expectDraft(form: Locator, userId: string, role: string, start: string, end: string) {
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Staff', { exact: true })).toHaveValue(userId);
  await expect(form.getByLabel('Shift role', { exact: true })).toHaveValue(role);
  await expect(form.getByLabel('Location', { exact: true })).toHaveValue(LOCATION);
  await expect(form.getByLabel('Date', { exact: true })).toHaveValue(DATE);
  await expect(form.getByLabel('Start', { exact: true })).toHaveValue(start);
  await expect(form.getByLabel('End', { exact: true })).toHaveValue(end);
}
async function openCreate(page: Page) {
  await page.getByRole('button', { name: 'Add shift', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create shift', exact: true })).toBeVisible();
}
async function closeEditor(page: Page) {
  await page.getByRole('button', { name: 'Close shift editor', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function openSaved(page: Page, shiftId: string) {
  const control = page.locator(`.shift-block[data-shift-event-id="${shiftId}"] .shift-details-button`);
  // Fixed same-day shifts have exactly one daily segment; no .first() fallback.
  await expect(control).toHaveCount(1);
  await control.click();
  await expect(page.getByRole('dialog', { name: 'Edit shift', exact: true })).toBeVisible();
}
async function expectBoardShift(page: Page, shiftId: string, start: string, end: string) {
  const control = page.locator(`.shift-block[data-shift-event-id="${shiftId}"] .shift-details-button`);
  await expect(control).toHaveCount(1);
  await expect(control).toHaveAttribute('aria-label', new RegExp(`shift, ${start} to ${end}$`));
}
async function deliver<T>(page: Page, gate: Awaited<ReturnType<typeof holdMutation<T>>>, status: number) {
  const response = page.waitForResponse(response => response.request().method() === 'POST'
    && response.status() === status && /\/api\/v2\/(schedules\/[^/]+\/change-sets|locations\/[^/]+\/schedules)$/.test(new URL(response.url()).pathname));
  gate.release();
  const delivered = await response;
  if (status === 412) {
    const expected = diagnostics.get(page)?.expectedStaleRefusal;
    if (!expected || delivered.url() !== expected.url) throw new Error('Unbound stale-refusal browser response.');
    expect(delivered.status()).toBe(expected.status);
    expected.actualResponse = { url: delivered.url(), status: delivered.status() };
  }
  await delivered.finished();
  await gate.finished;
}
async function attachBoard(page: Page, label: string) {
  const result = await board(page);
  await test.info().attach(label, { body: JSON.stringify(result), contentType: 'application/json' });
  return result;
}
function expectSchedule(result: ScheduleBoardResponse, id: string, revision: number) {
  expect(result.data.schedules).toHaveLength(1);
  expect(result.data.schedules[0]).toMatchObject({ id, locationId: LOCATION, status: 'DRAFT', revision });
}

type ConsoleError = { type: string; text: string; locationURL: string; lineNumber: number | null; columnNumber: number | null };
type ExpectedStaleRefusal = {
  url: string; status: 412; code: 'stale_schedule_revision'; responseBytesSha256: string;
  actualResponse?: { url: string; status: number };
};
type BrowserDiagnostics = { pageErrors: string[]; consoleErrors: ConsoleError[]; expectedStaleRefusal?: ExpectedStaleRefusal };
const diagnostics = new WeakMap<Page, BrowserDiagnostics>();
const STALE_REFUSAL_TITLE = 'keeps the newer editor and avoids an old-scope reload after a delayed stale update refusal';
// This exact Chromium resource-error spelling is the only permitted format.
// Other browser spellings/absent locations remain failures until actually reviewed.
const EXPECTED_412_TEXT = 'Failed to load resource: the server responded with a status of 412 (Precondition Failed)';
test.describe('Calendar pending-save editor custody', () => {
  test.skip(!mockMode, 'These cases qualify local mock ordering only; native counterparts need separate reviewed target fixtures.');
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    const values: BrowserDiagnostics = { pageErrors: [], consoleErrors: [] };
    diagnostics.set(page, values);
    page.on('pageerror', error => values.pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const location = message.location();
      values.consoleErrors.push({ type: message.type(), text: message.text(), locationURL: location.url,
        lineNumber: location.lineNumber ?? null, columnNumber: location.columnNumber ?? null });
    });
    const reset = await page.request.post('/api/v1/__e2e/reset');
    expect(reset.status()).toBe(200);
  });
  test.afterEach(async ({ page }) => {
    const values = diagnostics.get(page)!;
    const expected = values.expectedStaleRefusal;
    const bound412 = test.info().title === STALE_REFUSAL_TITLE && expected?.status === 412
      && expected.code === 'stale_schedule_revision' && expected.actualResponse?.url === expected.url
      && expected.actualResponse.status === 412;
    const expectedErrors = values.consoleErrors.filter(error => bound412 && error.type === 'error'
      && error.text === EXPECTED_412_TEXT && error.locationURL === expected!.url);
    const unexpectedErrors = values.consoleErrors.filter(error => !expectedErrors.includes(error));
    await test.info().attach('calendar-browser-errors', { body: JSON.stringify({ ...values, expectedErrors, unexpectedErrors,
      disposition: 'Only at most one exact resource error bound to this case issued change-set URL, real delivered 412 and retained stale_schedule_revision body is expected. Every other console error fails.' }), contentType: 'application/json' });
    expect(values.pageErrors, 'uncaught browser exceptions').toEqual([]);
    expect(expectedErrors.length, 'at most one bound stale-refusal resource error').toBeLessThanOrEqual(1);
    expect(unexpectedErrors, 'unexpected browser console errors').toEqual([]);
  });

  test('keeps a newer same-visit create draft while applying the acknowledged issued shift', async ({ page }) => {
    const seeded = await prepare(page, true);
    if (!seeded) throw new Error('Missing explicitly seeded draft schedule.');
    await openCreate(page);
    const form = editor(page);
    await fillDraft(form, STAFF, 'STAFF', '09:00', '17:00');
    const gate = await holdMutation<ScheduleChangeSetResponse>(page, `**/api/v2/schedules/${seeded.scheduleId}/change-sets`);
    let held!: RetainedMutation<ScheduleChangeSetResponse>;
    try {
      await form.getByRole('button', { name: 'Create shift', exact: true }).click();
      held = await gate.retained;
      expect(held.status).toBe(200);
      expect(held.request.body).toEqual({ operations: [{ op: 'shift.create', clientId: expect.stringMatching(UUID), ...A }] });
      const operation = (held.request.body as ScheduleChangeSetRequest).operations[0];
      expect(operation).toEqual({ op: 'shift.create', clientId: expect.stringMatching(UUID), ...A });
      if (operation.op !== 'shift.create' || !operation.clientId) throw new Error('Missing issued create client id.');
      expect(held.request.key).toBe(`${operation.clientId}:shift`);
      expect(held.request.ifMatch).toBe(seeded.etag);
      expect(held.payload.data.baseRevision).toBe(0);
      expect(held.payload.data.revision).toBe(1);
      await fillDraft(form, MANAGER, 'MANAGER', '10:00', '18:00');
      await expectDraft(form, MANAGER, 'MANAGER', '10:00', '18:00');
      await deliver(page, gate, 200);
      await expect(page.locator('.scheduler-status-pill')).toContainText('Shift created and saved');
      await expectDraft(form, MANAGER, 'MANAGER', '10:00', '18:00');
      const createdId = held.payload.data.created[0]?.shiftId;
      expect(createdId).toMatch(UUID);
      if (!createdId) throw new Error('Successful create omitted its shift id.');
      await expectBoardShift(page, createdId, '09:00', '17:00');
      const result = await attachBoard(page, 'issued-create-before-newer-save');
      expectSchedule(result, seeded.scheduleId, 1);
      expect(result.data.shifts).toEqual([expect.objectContaining({ id: createdId, ...A })]);
    } finally { await gate.close(); }
    const next = page.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).pathname === `/api/v2/schedules/${seeded.scheduleId}/change-sets`);
    await form.getByRole('button', { name: 'Create shift', exact: true }).click();
    const request = await next;
    expect(request.headers()['idempotency-key']).not.toBe(held.request.key);
    expect(request.postDataJSON()).toEqual({ operations: [{ op: 'shift.create', clientId: expect.stringMatching(UUID), ...B }] });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const second = await attachBoard(page, 'two-explicit-create-effects');
    expectSchedule(second, seeded.scheduleId, 2);
    expect(second.data.shifts).toHaveLength(2);
    expect(second.data.shifts).toEqual(expect.arrayContaining([expect.objectContaining(A), expect.objectContaining(B)]));
    // The unchanged second submission must clean its own editor normally.
    await openCreate(page);
    await expectDraft(editor(page), STAFF, 'STAFF', '09:00', '17:00');
    await closeEditor(page);
    await page.reload();
    await expectBoardShift(page, held.payload.data.created[0].shiftId, '09:00', '17:00');
    expect((await attachBoard(page, 'create-effects-after-reload')).data.shifts).toEqual(second.data.shifts);
  });

  test('keeps a replacement shift editor when an older update is acknowledged', async ({ page }) => {
    const seeded = await prepare(page, true, true);
    if (!seeded) throw new Error('Missing seeded shifts.');
    await openSaved(page, seeded.aId);
    await editor(page).getByLabel('End', { exact: true }).fill('16:00');
    const gate = await holdMutation<ScheduleChangeSetResponse>(page, `**/api/v2/schedules/${seeded.scheduleId}/change-sets`);
    let held!: RetainedMutation<ScheduleChangeSetResponse>;
    try {
      await editor(page).getByRole('button', { name: 'Save shift', exact: true }).click();
      held = await gate.retained;
      expect(held.status).toBe(200);
      expect(held.request.body).toEqual({ operations: [{ op: 'shift.update', shiftId: seeded.aId, endTime: UPDATED_A_END }] });
      expect(held.request.key).toMatch(UUID);
      expect(held.request.ifMatch).toBe(seeded.etag);
      await closeEditor(page);
      await openSaved(page, seeded.bId);
      await fillDraft(editor(page), MANAGER, 'MANAGER', '11:00', '19:00');
      await deliver(page, gate, 200);
      await expect(page.locator('.scheduler-status-pill')).toContainText('Shift changes saved');
      await expect(page.getByRole('dialog', { name: 'Edit shift', exact: true })).toBeVisible();
      await expectDraft(editor(page), MANAGER, 'MANAGER', '11:00', '19:00');
      await expectBoardShift(page, seeded.aId, '09:00', '16:00');
      const result = await attachBoard(page, 'old-update-newer-editor-preserved');
      expectSchedule(result, seeded.scheduleId, 2);
      expect(result.data.shifts).toHaveLength(2);
      expect(result.data.shifts).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: seeded.aId, ...A, endTime: UPDATED_A_END }), expect.objectContaining({ id: seeded.bId, ...B }),
      ]));
    } finally { await gate.close(); }
    const next = page.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).pathname === `/api/v2/schedules/${seeded.scheduleId}/change-sets`);
    await editor(page).getByRole('button', { name: 'Save shift', exact: true }).click();
    const request = await next;
    expect(request.headers()['idempotency-key']).not.toBe(held.request.key);
    expect(request.headers()['if-match']).toBe(held.payload.data.etag);
    expect(request.postDataJSON()).toEqual({ operations: [{ op: 'shift.update', shiftId: seeded.bId, ...UPDATED_B }] });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const saved = await attachBoard(page, 'replacement-update-readback');
    expectSchedule(saved, seeded.scheduleId, 3);
    expect(saved.data.shifts).toHaveLength(2);
    expect(saved.data.shifts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seeded.aId, endTime: UPDATED_A_END }), expect.objectContaining({ id: seeded.bId, ...B, ...UPDATED_B }),
    ]));
    await page.reload();
    await expectBoardShift(page, seeded.bId, '11:00', '19:00');
    expect((await board(page)).data.shifts).toEqual(saved.data.shifts);
  });

  test('keeps the newer editor and avoids an old-scope reload after a delayed stale update refusal', async ({ page }) => {
    const seeded = await prepare(page, true, true);
    if (!seeded) throw new Error('Missing seeded shifts.');
    await openSaved(page, seeded.aId);
    await editor(page).getByLabel('End', { exact: true }).fill('16:00');
    const gate = await holdMutation<ProblemDetails>(page, `**/api/v2/schedules/${seeded.scheduleId}/change-sets`, true);
    const browserBoardReads: string[] = [];
    const countBoard = (request: import('@playwright/test').Request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/v2/schedule-board') browserBoardReads.push(request.url());
    };
    page.on('request', countBoard);
    try {
      await editor(page).getByRole('button', { name: 'Save shift', exact: true }).click();
      const issued = await gate.observed;
      expect(issued.ifMatch).toBe(seeded.etag);
      expect(issued.body).toEqual({ operations: [{ op: 'shift.update', shiftId: seeded.aId, endTime: UPDATED_A_END }] });
      const competitorKey = randomUUID();
      expect(competitorKey).not.toBe(issued.key);
      const competitor = await apiJson<ScheduleChangeSetResponse>(page, 'POST', `/api/v2/schedules/${seeded.scheduleId}/change-sets`,
        { operations: [{ op: 'shift.update', shiftId: seeded.aId, startTime: '2030-01-15T16:00:00.000Z' }] }, 200,
        { 'Idempotency-Key': competitorKey, 'If-Match': seeded.etag });
      expect(competitor.data.revision).toBe(2);
      gate.forward();
      const refused = await gate.retained;
      expect(refused.status).toBe(412);
      expect(refused.payload).toMatchObject({ status: 412, code: 'stale_schedule_revision', currentEtag: competitor.data.etag });
      await closeEditor(page);
      await openSaved(page, seeded.bId);
      await fillDraft(editor(page), MANAGER, 'MANAGER', '11:00', '19:00');
      await expect(page.locator('.scheduler-status-pill')).toHaveText('Shift draft changed. Review and save it.');
      const readsBeforeDelivery = browserBoardReads.length;
      // The sole error disposition is established from the already-retained
      // genuine refusal before delivery, then matched to the actual browser response.
      diagnostics.get(page)!.expectedStaleRefusal = {
        url: new URL(refused.request.path, page.url()).href,
        status: 412, code: 'stale_schedule_revision',
        responseBytesSha256: createHash('sha256').update(refused.bytes).digest('hex'),
      };
      await deliver(page, gate, 412);
      // A post-delivery browser paint barrier, not an arbitrary time sleep or
      // proof of the separate queued-cleanup interleaving.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expectDraft(editor(page), MANAGER, 'MANAGER', '11:00', '19:00');
      await expect(page.locator('.scheduler-status-pill')).toHaveText('Shift draft changed. Review and save it.');
      expect(browserBoardReads).toHaveLength(readsBeforeDelivery);
      const result = await attachBoard(page, 'stale-refusal-independent-readback');
      expectSchedule(result, seeded.scheduleId, 2);
      expect(result.data.shifts).toHaveLength(2);
      expect(result.data.shifts).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: seeded.aId, ...A, startTime: '2030-01-15T16:00:00.000Z' }), expect.objectContaining({ id: seeded.bId, ...B }),
      ]));
      expect(result.data.shifts.find(shift => shift.id === seeded.aId)?.endTime).toBe(A.endTime);
      expect(browserBoardReads).toHaveLength(readsBeforeDelivery);
    } finally {
      page.off('request', countBoard);
      await gate.close();
    }
    await closeEditor(page);
    await page.reload();
    await expectBoardShift(page, seeded.aId, '08:00', '17:00');
    await expectBoardShift(page, seeded.bId, '10:00', '18:00');
  });

  test('retains the issued shift payload across delayed fallback schedule creation', async ({ page }) => {
    await prepare(page, false);
    await openCreate(page);
    await fillDraft(editor(page), STAFF, 'STAFF', '09:00', '17:00');
    const gate = await holdMutation<ScheduleCreateResponse>(page, `**/api/v2/locations/${LOCATION}/schedules`);
    const changes: Array<{ key: string; ifMatch: string | null; body: unknown; path: string }> = [];
    const captureChange = (request: import('@playwright/test').Request) => {
      if (request.method() === 'POST' && /^\/api\/v2\/schedules\/[^/]+\/change-sets$/.test(new URL(request.url()).pathname)) {
        changes.push({ key: request.headers()['idempotency-key'] ?? '', ifMatch: request.headers()['if-match'] ?? null,
          body: request.postDataJSON() as unknown, path: new URL(request.url()).pathname });
      }
    };
    page.on('request', captureChange);
    let held!: RetainedMutation<ScheduleCreateResponse>;
    try {
      try {
        await editor(page).getByRole('button', { name: 'Create shift', exact: true }).click();
        held = await gate.retained;
        expect(held.status).toBe(200);
        expect(held.request.path).toBe(`/api/v2/locations/${LOCATION}/schedules`);
        expect(held.request.body).toEqual({ startDate: '2030-01-15T08:00:00.000Z', endDate: '2030-01-16T08:00:00.000Z' });
        expect(held.request.key).toMatch(new RegExp(`${UUID.source.slice(0, -1)}:schedule$`, 'i'));
        await fillDraft(editor(page), MANAGER, 'MANAGER', '10:00', '18:00');
        const fallbackShiftResponse = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === `/api/v2/schedules/${held.payload.data.id}/change-sets`);
        await deliver(page, gate, 200);
        expect((await fallbackShiftResponse).status()).toBe(200);
        await expect(page.locator('.scheduler-status-pill')).toContainText('Shift created and saved');
        await expectDraft(editor(page), MANAGER, 'MANAGER', '10:00', '18:00');
        expect(changes).toHaveLength(1);
        const baseKey = held.request.key.slice(0, -':schedule'.length);
        expect(baseKey).toMatch(UUID);
        expect(changes[0]).toEqual({ key: `${baseKey}:shift`, ifMatch: held.payload.data.etag,
          path: `/api/v2/schedules/${held.payload.data.id}/change-sets`,
          body: { operations: [{ op: 'shift.create', clientId: baseKey, ...A }] } });
        const result = await attachBoard(page, 'fallback-issued-payload-readback');
        expectSchedule(result, held.payload.data.id, 1);
        expect(result.data.shifts).toEqual([expect.objectContaining(A)]);
        await expectBoardShift(page, result.data.shifts[0].id, '09:00', '17:00');
      } finally { await gate.close(); }
      await editor(page).getByRole('button', { name: 'Create shift', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(changes).toHaveLength(2);
      expect(changes[1].key).not.toBe(changes[0].key);
      expect(changes[1].body).toEqual({ operations: [{ op: 'shift.create', clientId: expect.stringMatching(UUID), ...B }] });
      const result = await attachBoard(page, 'fallback-and-new-draft-separate-effects');
      expectSchedule(result, held.payload.data.id, 2);
      expect(result.data.shifts).toHaveLength(2);
      expect(result.data.shifts).toEqual(expect.arrayContaining([expect.objectContaining(A), expect.objectContaining(B)]));
      await page.reload();
      const a = result.data.shifts.find(shift => shift.userId === STAFF);
      const b = result.data.shifts.find(shift => shift.userId === MANAGER);
      if (!a || !b) throw new Error('Missing independently saved fallback shifts.');
      await expectBoardShift(page, a.id, '09:00', '17:00');
      await expectBoardShift(page, b.id, '10:00', '18:00');
      expect((await board(page)).data.shifts).toEqual(result.data.shifts);
    } finally { page.off('request', captureChange); }
  });
});
