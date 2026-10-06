import { createHash } from 'node:crypto';
import type { TimeCardCorrectionRequest, TimeCardRecord } from '@lunchlineup/api-contract';
import type { Locator, Response } from '@playwright/test';
import { expect, test, type Page } from './qa-isolation-fixture';
import { loginAsSeedAdmin, runFullStack } from './support';
import { installTimeCardCorrectionAdapter, STAFF, MANAGER, LOCATION, CARD, OTHER, CORRECTION_URL,
  type ResponseRecord } from './time-card-correction-stateful-adapter';

const mockMode = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const REFUSAL = 'retains refused correction drafts and explicitly recovers a stale version';
const localInput = (iso: string) => iso.slice(0, 16); // Seeded card displays UTC.
const offset = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
const region = (page: Page) => page.getByRole('region', { name: 'Correct Mock Staff time card', exact: true });
const teamMember = (page: Page) => page.getByRole('combobox', { name: /^Team member(?:\s|$)/ });
const teamLocation = (page: Page) => page.getByRole('combobox', { name: /^Team location(?:\s|$)/ });
const selectedRow = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Correction Kitchen', exact: true }) });
const patchRows = (rows: ResponseRecord[]) => rows.filter(row => row.method === 'PATCH' && !row.probe);
type Adapter = Awaited<ReturnType<typeof installTimeCardCorrectionAdapter>>;
type Diagnostics = { errors: string[]; console: Array<{ type: string; text: string; url: string; line: number; column: number }>; responses: Array<{ url: string; status: number; code: string; sha256: string }> };
const diagnostics = new WeakMap<Page, Diagnostics>();

type BrowserBodyReceipt = {
  url: string; method: string; sequence: number; probe: boolean; requestBodySha256: string | null;
  status: number | null; bytes: number | null; bodyBase64: string | null; complete: boolean; error: string | null;
};
type BrowserBodyObserver = { receipts: BrowserBodyReceipt[]; errors: string[] };
type ObservedTimeCardWindow = Window & { __timeCardBodyObserver?: BrowserBodyObserver };

async function installBrowserBodyObserver(page: Page) {
  await page.addInitScript(() => {
    const observer: BrowserBodyObserver = { receipts: [], errors: [] };
    (window as ObservedTimeCardWindow).__timeCardBodyObserver = observer;
    const originalFetch = window.fetch.bind(window);
    let sequence = 0;
    window.fetch = (input, init) => {
      // Return the identical original Promise and Response to the application.
      // Read only a clone, with no await before returning its original Promise.
      const pending = originalFetch(input, init);
      try {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), window.location.href);
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        if (method === 'PATCH' && url.origin === window.location.origin
          && /^\/api\/v2\/time-cards\/[^/]+\/correction$/.test(url.pathname)) {
          const receipt: BrowserBodyReceipt = { url: url.href, method, sequence: ++sequence,
            probe: new Headers(init?.headers ?? request?.headers).has('x-timecard-fixture-probe'),
            requestBodySha256: null, status: null, bytes: null, bodyBase64: null, complete: false, error: null };
          observer.receipts.push(receipt);
          // Actual jsonWriteInit and adapter probe both send a serialized string
          // in init.body. Unsupported inputs fail this observer, never the fetch.
          const requestBody = init?.body;
          void pending.then(async response => {
            receipt.status = response.status;
            const clone = response.clone();
            if (typeof requestBody !== 'string') throw new Error('TimeCard observer requires the actual serialized request body');
            const requestBytes = new TextEncoder().encode(requestBody);
            const [digest, buffer] = await Promise.all([
              crypto.subtle.digest('SHA-256', requestBytes), clone.arrayBuffer(),
            ]);
            receipt.requestBodySha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
            const bytes = new Uint8Array(buffer);
            receipt.bytes = bytes.length;
            receipt.bodyBase64 = btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''));
          }).catch(error => { receipt.error = String(error); })
            .finally(() => { receipt.complete = true; });
        }
      } catch (error) { observer.errors.push(String(error)); }
      return pending;
    };
  });
}
async function exactBrowserDecodedBody(page: Page, adapter: Adapter, row: ResponseRecord, received: Response) {
  const url = new URL(CORRECTION_URL, page.url()).href;
  const request = received.request();
  expect(received.url()).toBe(url); expect(received.status()).toBe(row.status);
  expect(request.method()).toBe('PATCH');
  expect(Boolean(request.headers()['x-timecard-fixture-probe'])).toBe(row.probe);
  const payload = request.postData();
  if (payload === null) throw new Error('Issued correction request body is unavailable');
  expect(JSON.parse(payload)).toEqual(row.body);
  const sequence = adapter.ledger.filter(record => record.method === 'PATCH').indexOf(row) + 1;
  expect(sequence, 'actual issued PATCH order including independent probes').toBeGreaterThan(0);
  const requestBodySha256 = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
  const expected: BrowserBodyObserver = { receipts: [{ url, method: 'PATCH', sequence, probe: row.probe,
    requestBodySha256, status: row.status, bytes: row.bytes.length, bodyBase64: row.bytes.toString('base64'),
    complete: true, error: null }], errors: [] };
  let observed: BrowserBodyObserver = { receipts: [], errors: [] };
  try {
    await expect.poll(async () => {
      observed = await page.evaluate(sequence => {
        const observer = (window as ObservedTimeCardWindow).__timeCardBodyObserver;
        if (!observer) throw new Error('Browser TimeCard body observer was not installed');
        return { receipts: observer.receipts.filter(receipt => receipt.sequence === sequence).map(receipt => ({ ...receipt })),
          errors: [...observer.errors] };
      }, sequence);
      return observed;
    }, { message: 'one complete native-fetch-clone response bound to issued correction payload and sequence' }).toEqual(expected);
  } finally {
    await test.info().attach(`timecard-browser-decoded-response-${sequence}`, { contentType: 'application/json',
      body: JSON.stringify({ expected, observed, observation: 'Native browser fetch clone complete decoded bytes; CDP loadingFinished/body retention is not claimed.' }) });
  }
}

async function prepare(page: Page, open: boolean) {
  await installBrowserBodyObserver(page);
  const adapter = await installTimeCardCorrectionAdapter(page, open);
  try {
    await loginAsSeedAdmin(page, '/dashboard/time-cards');
    await expect(page.getByRole('heading', { name: 'Time Cards', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Team Time', exact: true }).click();
    await expect(teamMember(page)).toHaveCount(1);
    await teamMember(page).selectOption(STAFF);
    await expect(teamLocation(page)).toHaveCount(1);
    await teamLocation(page).selectOption(LOCATION);
    await expect(page.getByTestId('time-card-selected-person')).toContainText('Mock Staff');
    await expect(selectedRow(page)).toHaveCount(1);
    await expect(selectedRow(page).getByRole('button', { name: /^Correct time card for Mock Staff clocked in / })).toBeEnabled();
    return adapter;
  } catch (primary) {
    try { await adapter.close(); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], 'Preparation and adapter cleanup failed', { cause: primary }); }
    throw primary;
  }
}
async function openCorrection(page: Page) {
  const row = selectedRow(page);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: /^Correct time card for Mock Staff clocked in / }).click();
  await expect(region(page)).toHaveCount(1);
  await expect(region(page)).toBeVisible();
}
async function activateDisabledPointer(page: Page, button: Locator, label: string) {
  await expect(button).toHaveCount(1);
  await expect(button).toBeDisabled();
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box, `${label} measured rectangle`).not.toBeNull();
  if (!box) throw new Error(`${label} has no measured rectangle`);
  const viewport = page.viewportSize();
  expect(viewport, 'canonical fixed viewport').not.toBeNull();
  if (!viewport) throw new Error('Expected canonical fixed viewport');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0);
  expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThan(viewport.width);
  expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThan(viewport.height);
  expect(await button.evaluate((node, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return hit === node || (hit !== null && node.contains(hit));
  }, point), `${label} center actually hits its control`).toBe(true);
  await test.info().attach(`timecard-pointer-${label}`, { contentType: 'application/json',
    body: JSON.stringify({ label, box, point, viewport, disabled: true }) });
  // Browser input at measured coordinates: no forced locator click or synthetic
  // dispatchEvent that could bypass the native disabled-control behavior.
  await page.mouse.click(point.x, point.y);
}

async function blocked(page: Page, open: boolean) {
  await expect(page.getByRole('button', { name: open ? 'Clock out Mock Staff from Correction Kitchen' : 'Clock in Mock Staff at Correction Kitchen', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'My Time', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Team Time', exact: true })).toBeDisabled();
  await expect(teamMember(page)).toBeDisabled();
  await expect(teamLocation(page)).toBeDisabled();
  const correct = page.getByRole('button', { name: /^Correct time card for Mock Staff clocked in / });
  await expect(correct).toHaveCount(2);
  for (const button of await correct.all()) await expect(button).toBeDisabled();
  await expect(page.getByRole('note').filter({ hasText: 'Save or cancel the correction before refreshing' })).toBeVisible();
  await expect(page.getByTestId('time-card-selected-person')).toContainText('Mock Staff');
  await expect(teamMember(page)).toHaveValue(STAFF);
  await expect(teamLocation(page)).toHaveValue(LOCATION);
}
async function enabled(page: Page, open: boolean) {
  await expect(region(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(teamMember(page)).toBeEnabled();
  await expect(teamLocation(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: 'My Time', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Team Time', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: open ? 'Clock out Mock Staff from Correction Kitchen' : 'Clock in Mock Staff at Correction Kitchen', exact: true })).toBeEnabled();
}
function original(adapter: Adapter, id = CARD) {
  const rows = adapter.initial.filter(row => row.id === id);
  expect(rows).toHaveLength(1); return rows[0];
}
async function readback(adapter: Adapter, id: string) {
  const reply = await adapter.read(id);
  expect(reply.status).toBe(200);
  expect(reply.originalHeaders['content-type']).toContain('application/json');
  return reply.payload as TimeCardRecord;
}
async function noteRefusal(page: Page, row: ResponseRecord, received: Response, adapter: Adapter) {
  expect([422, 409]).toContain(row.status);
  expect(received.url()).toBe(new URL(CORRECTION_URL, page.url()).href);
  expect(received.status()).toBe(row.status);
  // The browser must receive the exact decoded bytes retained for fulfillment.
  await exactBrowserDecodedBody(page, adapter, row, received);
  const payload = JSON.parse(row.bytes.toString('utf8')) as { code: string };
  expect(payload.code).toBe(row.status === 422 ? 'invalid_time_card_input' : 'concurrent_time_card_change');
  diagnostics.get(page)!.responses.push({ url: received.url(), status: row.status, code: payload.code, sha256: row.sha256 });
}
async function withAdapter(page: Page, open: boolean, body: (adapter: Adapter) => Promise<void>) {
  const adapter = await prepare(page, open);
  let failed = false, primary: unknown;
  try { await body(adapter); }
  catch (error) { failed = true; primary = error; }
  const cleanup: unknown[] = [];
  try { await adapter.close(); } catch (error) { cleanup.push(error); }
  try {
    await test.info().attach('timecard-model-request-response-ledger', { contentType: 'application/json', body: JSON.stringify({
      scope: 'Stateful local browser-route model; no native, SQL, identity, payroll audit or wallet proof.',
      initial: adapter.initial,
      rows: adapter.ledger.map(row => ({ ...row, bytes: row.bytes.length, bodyBase64: row.bytes.toString('base64') })),
    }, null, 2) });
  } catch (error) { cleanup.push(error); }
  if (failed && cleanup.length) throw new AggregateError([primary, ...cleanup], 'Case and cleanup failed', { cause: primary });
  if (failed) throw primary;
  if (cleanup.length) throw new AggregateError(cleanup, 'Adapter cleanup/evidence failed');
}
function saveResponse(page: Page) {
  const promise = page.waitForResponse(response => new URL(response.url()).pathname === CORRECTION_URL
    && response.request().method() === 'PATCH' && !response.request().headers()['x-timecard-fixture-probe']);
  void promise.catch(() => undefined);
  return promise;
}
async function exactPayload(row: ResponseRecord, expected: TimeCardCorrectionRequest) {
  expect(row.path).toBe(CORRECTION_URL); expect(row.method).toBe('PATCH'); expect(row.probe).toBe(false);
  expect(row.body).toEqual(expected);
  expect(row.requestKey).toBeNull(); // No invented idempotency protocol for correction.
  expect(row.deliveryHeaders['content-length']).toBe(String(row.bytes.length));
  expect(row.deliveryHeaders).not.toHaveProperty('content-encoding');
  expect(row.deliveryHeaders).not.toHaveProperty('transfer-encoding');
}

test.describe('Time Card correction browser custody', () => {
  test.skip(!mockMode, 'Local model browser proof only; real TimeCard owner requires separately admitted target fixtures.');
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    const values: Diagnostics = { errors: [], console: [], responses: [] }; diagnostics.set(page, values);
    page.on('pageerror', error => values.errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const location = message.location();
      values.console.push({ type: message.type(), text: message.text(), url: location.url,
        line: location.lineNumber, column: location.columnNumber });
    });
    const reset = await page.request.post('/api/v1/__e2e/reset');
    expect(reset.status()).toBe(200);
  });
  test.afterEach(async ({ page }) => {
    const values = diagnostics.get(page)!;
    const expected = test.info().title === REFUSAL ? values.responses : [];
    const permitted = values.console.filter(error => expected.some(reply => error.url === reply.url
      && ((reply.status === 422 && reply.code === 'invalid_time_card_input'
        && error.text === 'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)')
        || (reply.status === 409 && reply.code === 'concurrent_time_card_change'
        && error.text === 'Failed to load resource: the server responded with a status of 409 (Conflict)'))));
    await test.info().attach('timecard-browser-diagnostics', { contentType: 'application/json', body: JSON.stringify({ ...values,
      disposition: 'Only exact console resource errors tied to this refusal case delivered URL/status/code and retained bytes are allowed. Unknown spellings/locations fail; zero browser resource logs is allowed.' }) });
    expect(values.errors, 'page exceptions').toEqual([]);
    expect(values.console.filter(error => !permitted.includes(error)), 'unexpected console errors').toEqual([]);
    for (const reply of expected) expect(permitted.filter(error => error.url === reply.url && error.text.includes(`status of ${reply.status} `)).length).toBeLessThanOrEqual(1);
    if (test.info().title === REFUSAL) expect(expected.map(reply => reply.status)).toEqual([422, 409]);
    else expect(values.responses).toEqual([]);
  });

  test('preserves an idle correction and restores eligible actions only after explicit Cancel', async ({ page }) => {
    await withAdapter(page, true, async adapter => {
      const before = original(adapter), other = original(adapter, OTHER);
      const mainNotes = page.getByLabel('Notes', { exact: true });
      const mainBreak = page.getByLabel('Break minutes', { exact: true });
      await expect(mainNotes).toBeEnabled(); await expect(mainBreak).toBeEnabled();
      await mainNotes.fill('Keep this main note until the person changes');
      await mainBreak.fill('7');
      await expect(mainNotes).toHaveValue('Keep this main note until the person changes');
      await expect(mainBreak).toHaveValue('7');
      await openCorrection(page);
      const reason = region(page).getByRole('textbox', { name: 'Correction reason', exact: true });
      await reason.fill('Keep this unsaved manager correction');
      await expect(reason).toBeFocused();
      await blocked(page, true);
      await expect(reason).toHaveValue('Keep this unsaved manager correction');
      await expect(mainNotes).toHaveValue('Keep this main note until the person changes');
      await expect(mainBreak).toHaveValue('7');
      expect(patchRows(adapter.ledger)).toHaveLength(0);
      expect(await readback(adapter, CARD)).toEqual(before);
      expect(await readback(adapter, OTHER)).toEqual(other);
      // Real keyboard Tab from the final textarea reaches the enabled Cancel,
      // while the blocked main controls remain outside the native tab sequence.
      await reason.focus(); await page.keyboard.press('Tab');
      await expect(region(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await enabled(page, true);
      await expect(mainNotes).toHaveValue('Keep this main note until the person changes');
      await expect(mainBreak).toHaveValue('7');
      expect(patchRows(adapter.ledger)).toHaveLength(0);
      await teamMember(page).selectOption(MANAGER);
      await expect(page.getByTestId('time-card-selected-person')).toContainText('Mock Manager');
      await expect(teamLocation(page)).toHaveValue('');
      await expect(page.getByLabel('Notes', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Break minutes', { exact: true })).toHaveValue('30');
      expect(await readback(adapter, CARD)).toEqual(before);
    });
  });

  test('keeps competing actions blocked through a delayed correction acknowledgement and exact readback', async ({ page }) => {
    await withAdapter(page, false, async adapter => {
      const before = original(adapter), other = original(adapter, OTHER);
      await openCorrection(page);
      const panel = region(page);
      await panel.getByLabel('Clock out', { exact: true }).fill(localInput(offset(before.clockOutAt!, 30)));
      await panel.getByRole('button', { name: 'Add break', exact: true }).click();
      const startAt = offset(before.clockInAt, 120), endAt = offset(before.clockInAt, 150);
      await panel.getByLabel('Break 1 start', { exact: true }).fill(localInput(startAt));
      await panel.getByLabel('Break 1 end', { exact: true }).fill(localInput(endAt));
      await panel.getByRole('textbox', { name: 'Correction reason', exact: true }).fill('Correct the end punch and recorded break');
      const held = adapter.holdNext(), delivered = saveResponse(page);
      try {
        await panel.getByRole('button', { name: 'Save correction', exact: true }).click();
        await held.observed;
        const row = await held.ready;
        await exactPayload(row, { clockInAt: before.clockInAt, clockOutAt: offset(before.clockOutAt!, 30),
          expectedUpdatedAt: before.updatedAt, reason: 'Correct the end punch and recorded break', breakIntervals: [{ startAt, endAt }] });
        expect(row.status).toBe(200);
        await blocked(page, false);
        await expect(panel.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
        await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
        await expect(panel.getByRole('textbox', { name: 'Correction reason', exact: true })).toHaveValue('Correct the end punch and recorded break');
        expect(patchRows(adapter.ledger)).toHaveLength(1);
        // Real attempts while response delivery is held, not a disabled/count-only
        // witness: both pointer controls are hit-tested at measured coordinates.
        await activateDisabledPointer(page, panel.getByRole('button', { name: 'Saving...', exact: true }), 'disabled-save');
        await activateDisabledPointer(page, page.getByRole('button', {
          name: 'Clock in Mock Staff at Correction Kitchen', exact: true,
        }), 'disabled-clock-in');
        const clockOutInput = panel.getByLabel('Clock out', { exact: true });
        await clockOutInput.focus(); await expect(clockOutInput).toBeFocused();
        await page.keyboard.press('Enter');
        // Two browser frame callbacks bound the input-observation checkpoint;
        // this is neither an arbitrary sleep nor a general React-settlement proof.
        await page.evaluate(() => new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await blocked(page, false);
        await expect(panel.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
        await expect(panel.getByLabel('Clock in', { exact: true })).toHaveValue(localInput(before.clockInAt));
        await expect(clockOutInput).toHaveValue(localInput(offset(before.clockOutAt!, 30)));
        await expect(panel.getByLabel('Break 1 start', { exact: true })).toHaveValue(localInput(startAt));
        await expect(panel.getByLabel('Break 1 end', { exact: true })).toHaveValue(localInput(endAt));
        await expect(panel.getByRole('textbox', { name: 'Correction reason', exact: true })).toHaveValue('Correct the end punch and recorded break');
        expect(patchRows(adapter.ledger)).toHaveLength(1);
        expect(adapter.ledger.filter(record => record.method !== 'GET' && !record.probe)).toHaveLength(1);
      } finally { held.release(); }
      await held.finished; const acknowledged = await delivered; expect(acknowledged.status()).toBe(200);
      await exactBrowserDecodedBody(page, adapter, patchRows(adapter.ledger)[0], acknowledged);
      await expect(page.getByRole('status').filter({ hasText: 'Time card corrected.' })).toBeVisible();
      await enabled(page, false);
      const saved = await readback(adapter, CARD);
      expect(saved).toMatchObject({ id: CARD, userId: STAFF, locationId: LOCATION, clockInAt: before.clockInAt,
        clockOutAt: offset(before.clockOutAt!, 30), revision: 2, status: 'CLOSED', grossMinutes: 510,
        workedMinutes: 480, breakMinutes: 30, breaks: [{ id: expect.any(String), startAt, endAt }] });
      expect(saved.updatedAt).not.toBe(before.updatedAt);
      expect(await readback(adapter, OTHER)).toEqual(other);
      expect(patchRows(adapter.ledger)).toHaveLength(1);
      await page.reload();
      await page.getByRole('button', { name: 'Team Time', exact: true }).click();
      await teamMember(page).selectOption(STAFF); await teamLocation(page).selectOption(LOCATION);
      await expect(selectedRow(page).getByRole('cell', { name: '8h 00m', exact: true })).toHaveCount(1);
      expect(await readback(adapter, CARD)).toEqual(saved);
    });
  });

  test('retains refused correction drafts and explicitly recovers a stale version', async ({ page }) => {
    await withAdapter(page, false, async adapter => {
      const before = original(adapter), other = original(adapter, OTHER);
      await openCorrection(page);
      const panel = region(page), reason = 'Keep the refused punch draft';
      await panel.getByRole('textbox', { name: 'Correction reason', exact: true }).fill(reason);
      const invalid = offset(before.clockInAt, -30);
      await panel.getByLabel('Clock out', { exact: true }).fill(localInput(invalid));
      const held = adapter.holdNext(), delivered422 = saveResponse(page);
      let refused!: ResponseRecord;
      try {
        await panel.getByRole('button', { name: 'Save correction', exact: true }).click();
        await held.observed; refused = await held.ready;
        await exactPayload(refused, { clockInAt: before.clockInAt, clockOutAt: invalid, expectedUpdatedAt: before.updatedAt, reason });
        expect(refused.status).toBe(422); expect(refused.effects).toBe(0);
        await blocked(page, false);
      } finally { held.release(); }
      await held.finished; await noteRefusal(page, refused, await delivered422, adapter);
      await expect(panel.getByRole('alert')).toHaveText('Clock out must be after clock in.');
      await expect(panel.getByRole('textbox', { name: 'Correction reason', exact: true })).toHaveValue(reason);
      await expect(panel.getByLabel('Clock out', { exact: true })).toHaveValue(localInput(invalid));
      await blocked(page, false); expect(await readback(adapter, CARD)).toEqual(before);
      await expect(panel.getByRole('button', { name: 'Save correction', exact: true })).toBeEnabled();
      const editedEnd = offset(before.clockOutAt!, 30);
      await panel.getByLabel('Clock out', { exact: true }).fill(localInput(editedEnd));
      // An independent mock HTTP writer commits before the old browser draft.
      // No production auth/transaction/locking proof is implied by this model.
      const winnerReply = await adapter.compete({ clockInAt: before.clockInAt, clockOutAt: offset(before.clockOutAt!, 60),
        expectedUpdatedAt: before.updatedAt, reason: 'Independent competing correction' });
      expect(winnerReply.status).toBe(200);
      const winner = await readback(adapter, CARD); expect(winner.revision).toBe(2);
      const delivered409 = saveResponse(page);
      await panel.getByRole('button', { name: 'Save correction', exact: true }).click();
      const response409 = await delivered409;
      const stale = patchRows(adapter.ledger).at(-1)!;
      await exactPayload(stale, { clockInAt: before.clockInAt, clockOutAt: editedEnd, expectedUpdatedAt: before.updatedAt, reason });
      await noteRefusal(page, stale, response409, adapter);
      await expect(panel.getByRole('alert')).toHaveText('This time card changed while you were editing it. Refresh and try again.');
      await expect(panel.getByRole('textbox', { name: 'Correction reason', exact: true })).toHaveValue(reason);
      await expect(panel.getByLabel('Clock out', { exact: true })).toHaveValue(localInput(editedEnd));
      await blocked(page, false);
      expect(await readback(adapter, CARD)).toEqual(winner);
      expect(patchRows(adapter.ledger).map(row => row.status)).toEqual([422, 409]);
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await enabled(page, false);
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      await openCorrection(page);
      const freshEnd = offset(before.clockOutAt!, 90);
      await region(page).getByLabel('Clock out', { exact: true }).fill(localInput(freshEnd));
      await region(page).getByRole('textbox', { name: 'Correction reason', exact: true }).fill('Explicit recovery on the current version');
      const acknowledged = saveResponse(page);
      await region(page).getByRole('button', { name: 'Save correction', exact: true }).click();
      expect((await acknowledged).status()).toBe(200); await enabled(page, false);
      await exactPayload(patchRows(adapter.ledger).at(-1)!, { clockInAt: before.clockInAt, clockOutAt: freshEnd,
        expectedUpdatedAt: winner.updatedAt, reason: 'Explicit recovery on the current version' });
      const saved = await readback(adapter, CARD);
      expect(saved).toMatchObject({ id: CARD, userId: STAFF, clockOutAt: freshEnd, revision: 3,
        grossMinutes: 570, workedMinutes: 570, breakMinutes: 0, breaks: [] });
      expect(await readback(adapter, OTHER)).toEqual(other);
      expect(patchRows(adapter.ledger).map(row => row.status)).toEqual([422, 409, 200]);
      expect(adapter.ledger.filter(row => row.method === 'PATCH' && row.probe)).toHaveLength(1);
    });
  });

  // Prospective source lead only: this case has not been executed or confirmed.
  test('preserves newer correction inputs accepted while an earlier save acknowledgement is pending', async ({ page }) => {
    await withAdapter(page, false, async adapter => {
      const before = original(adapter), other = original(adapter, OTHER);
      const issuedEnd = offset(before.clockOutAt!, 30), newerEnd = offset(before.clockOutAt!, 60);
      const issuedReason = 'Issued correction before newer local editing';
      const newerReason = 'Newer manager draft must remain available after the earlier save';
      await openCorrection(page);
      const panel = region(page), clockOut = panel.getByLabel('Clock out', { exact: true });
      const reason = panel.getByRole('textbox', { name: 'Correction reason', exact: true });
      await clockOut.fill(localInput(issuedEnd)); await reason.fill(issuedReason);
      const held = adapter.holdNext(), delivered = saveResponse(page);
      let issued!: ResponseRecord;
      try {
        await panel.getByRole('button', { name: 'Save correction', exact: true }).click();
        await held.observed; issued = await held.ready;
        await exactPayload(issued, { clockInAt: before.clockInAt, clockOutAt: issuedEnd,
          expectedUpdatedAt: before.updatedAt, reason: issuedReason });
        expect(issued.status).toBe(200); expect(issued.effects).toBe(1);
        await blocked(page, false);
        await expect(panel.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
        await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
        // Real enabled inputs accept edits only after old payload capture/model
        // commit, and while its response delivery is still held.
        await expect(reason).toBeEnabled(); await expect(clockOut).toBeEnabled();
        await reason.fill(newerReason); await reason.focus(); await expect(reason).toBeFocused();
        await clockOut.fill(localInput(newerEnd)); await clockOut.focus(); await expect(clockOut).toBeFocused();
        await expect(reason).toHaveValue(newerReason); await expect(clockOut).toHaveValue(localInput(newerEnd));
        expect(patchRows(adapter.ledger)).toHaveLength(1);
        await test.info().attach('pending-newer-correction-draft-before-old-ack', { contentType: 'application/json',
          body: JSON.stringify({ clockOut: await clockOut.inputValue(), reason: await reason.inputValue(),
            clockOutFocused: await clockOut.evaluate(node => document.activeElement === node),
            issuedPayload: issued.body, issuedStatus: issued.status }) });
      } finally { held.release(); }
      await held.finished;
      const acknowledged = await delivered;
      expect(acknowledged.status()).toBe(200);
      await exactBrowserDecodedBody(page, adapter, issued, acknowledged);
      await expect(page.getByRole('status').filter({ hasText: 'Time card corrected.' })).toBeVisible();
      // Separate actual GET through the existing model proves old issued save,
      // not newer local values. It does not claim native/durable database proof.
      const saved = await readback(adapter, CARD);
      expect(saved).toMatchObject({ id: CARD, userId: STAFF, locationId: LOCATION,
        clockInAt: before.clockInAt, clockOutAt: issuedEnd, revision: 2, status: 'CLOSED' });
      expect(saved.updatedAt).not.toBe(before.updatedAt);
      expect(await readback(adapter, OTHER)).toEqual(other);
      expect(patchRows(adapter.ledger)).toHaveLength(1);
      expect(adapter.ledger.filter(row => row.method !== 'GET' && !row.probe)).toHaveLength(1);
      // Retain post-ack actual DOM even if the survival oracle fails below.
      await test.info().attach('pending-newer-correction-draft-after-old-ack', { contentType: 'application/json',
        body: JSON.stringify({ panelCount: await panel.count(),
          reason: await reason.count() ? await reason.inputValue() : null,
          clockOut: await clockOut.count() ? await clockOut.inputValue() : null,
          saved, scope: 'Browser DOM and local route-model observation; source lead remains unconfirmed before execution.' }) });
      await expect(panel).toBeVisible();
      await expect(reason).toHaveValue(newerReason);
      await expect(clockOut).toHaveValue(localInput(newerEnd));
      await expect(panel.getByRole('button', { name: 'Save correction', exact: true })).toBeEnabled();
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
      await expect(teamMember(page)).toBeDisabled(); await expect(teamLocation(page)).toBeDisabled();
    });
  });
});
