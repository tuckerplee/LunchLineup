import { expect, test, type Page, type Route } from '@playwright/test';

import { loginAsSeedAdmin, loginAsSeedManager, runFullStack } from './support';

const runMockReadiness = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const MILLISECONDS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

const policy = {
  id: 'payroll-policy-1',
  version: 1,
  timeZone: 'America/Los_Angeles',
  cadence: 'WEEKLY',
  anchorDate: '2026-07-06',
  effectiveFrom: '2026-07-06',
  createdByUserId: 'user-admin',
  createdAt: '2026-07-06T16:00:00.000Z',
};

function nextWeeklyBoundary(anchorDate: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = Date.parse(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
  const anchor = Date.parse(`${anchorDate}T00:00:00.000Z`);
  const periods = Math.max(0, Math.floor((today - anchor) / MILLISECONDS_PER_WEEK) + 1);
  return new Date(anchor + periods * MILLISECONDS_PER_WEEK).toISOString().slice(0, 10);
}

function exportBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payroll-batch-1',
    periodId: 'payroll-period-1',
    formatVersion: 1,
    status: 'GENERATED',
    contentSha256: 'b'.repeat(64),
    rowCount: 1,
    totalPayableMinutes: 450,
    settlement: { consumedCredits: 1, newBalance: 499 },
    createdAt: '2026-07-16T17:00:00.000Z',
    downloadedAt: null,
    reconciledAt: null,
    lines: [{
      id: 'payroll-line-1',
      lineNumber: 1,
      lockedEntryId: 'payroll-entry-1',
      employeeId: 'user-mock-staff',
      payableMinutes: 450,
      canonicalSha256: 'c'.repeat(64),
      reconciliationStatus: 'PENDING',
      reconciliationReason: null,
    }],
    nextLineCursor: null,
    reconciliation: {
      acceptedCount: 0,
      rejectedCount: 0,
      pendingCount: 1,
      providerTotalMinutes: null,
      latestProvider: null,
      latestProviderEventId: null,
    },
    ...overrides,
  };
}

function period(batch: ReturnType<typeof exportBatch> | null) {
  return {
    id: 'payroll-period-1',
    policyVersionId: policy.id,
    localStartDate: '2026-07-06',
    localEndDateExclusive: '2026-07-13',
    startsAt: '2026-07-06T07:00:00.000Z',
    endsAt: '2026-07-13T07:00:00.000Z',
    timeZone: policy.timeZone,
    cadence: policy.cadence,
    status: 'LOCKED',
    revision: 2,
    reviewStartedAt: '2026-07-14T16:00:00.000Z',
    lockedAt: '2026-07-15T16:00:00.000Z',
    lockedEntrySha256: 'a'.repeat(64),
    lockedEntryCount: 1,
    totalPayableMinutes: 450,
    summary: {
      cardCount: 1,
      closedCardCount: 1,
      approvedCardCount: 1,
      rejectedCardCount: 0,
      pendingCardCount: 0,
      amendmentCount: 0,
      pendingAmendmentCount: 0,
      approvedAmendmentCount: 0,
      lockedEntryCount: 1,
    },
    exportBatch: batch,
  };
}

function futurePeriod() {
  return {
    ...period(null),
    id: 'payroll-period-2',
    localStartDate: '2026-07-20',
    localEndDateExclusive: '2026-07-27',
    startsAt: '2026-07-20T07:00:00.000Z',
    endsAt: '2026-07-27T07:00:00.000Z',
    status: 'OPEN',
    revision: 1,
    reviewStartedAt: null,
    lockedAt: null,
    lockedEntrySha256: null,
    lockedEntryCount: null,
    totalPayableMinutes: null,
    summary: {
      cardCount: 0,
      closedCardCount: 0,
      approvedCardCount: 0,
      rejectedCardCount: 0,
      pendingCardCount: 0,
      amendmentCount: 0,
      pendingAmendmentCount: 0,
      approvedAmendmentCount: 0,
      lockedEntryCount: 0,
    },
  };
}

function periodDetail(batch: ReturnType<typeof exportBatch> | null, amendments: unknown[] = []) {
  return {
    period: period(batch),
    cards: [],
    nextCardCursor: null,
    lockedEntries: [{
      id: 'payroll-entry-1',
      sequence: 0,
      sourceType: 'TIME_CARD',
      sourceId: 'time-card-1',
      sourceRevision: 3,
      employeeId: 'user-mock-staff',
      employeeName: 'Mock Staff',
      locationId: 'loc-downtown',
      workTimeZone: policy.timeZone,
      clockInAt: '2026-07-08T16:00:00.000Z',
      clockOutAt: '2026-07-09T00:00:00.000Z',
      breakMinutes: 30,
      payableMinutes: 450,
      approvedAt: '2026-07-14T17:00:00.000Z',
      approvedByUserId: 'user-admin',
      canonicalSha256: 'd'.repeat(64),
    }],
    amendments,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

type PayrollApiOptions = {
  ambiguousReconciliation?: boolean;
  ambiguousPolicyOnce?: boolean;
  ambiguousAmendmentOnce?: boolean;
  amendmentRequests?: Array<{ key: string; body: unknown }>;
  exportEntitlement?: unknown;
  failNextPostExportRefresh?: boolean;
  includeFuturePeriod?: boolean;
  initialBatch?: ReturnType<typeof exportBatch>;
  policyRequests?: Array<{ key: string; body: unknown }>;
  reconciliationRequests?: unknown[];
};

async function installPayrollApi(
  page: Page,
  exportRequests: Array<{ key: string; body: unknown }>,
  options: PayrollApiOptions = {},
) {
  let currentBatch = options.initialBatch ?? null;
  const amendments: unknown[] = [];
  let postExportRefreshFailed = false;
  await page.route('**/api/v2/payroll/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() === 'GET' && path.endsWith('/payroll/export-entitlement')) {
      await fulfillJson(route, options.exportEntitlement ?? {
        eligible: true,
        creditCost: 1,
        reason: 'Enabled by active paid subscription and separately purchased credits.',
      });
      return;
    }
    if (request.method() === 'PUT' && path.endsWith('/payroll/policy')) {
      options.policyRequests?.push({
        key: request.headers()['idempotency-key'] ?? '',
        body: request.postDataJSON(),
      });
      if (options.ambiguousPolicyOnce && options.policyRequests?.length === 1) {
        await fulfillJson(route, { message: 'Temporary policy write uncertainty.' }, 503);
        return;
      }
      await fulfillJson(route, {
        ...policy,
        ...(request.postDataJSON() as Record<string, unknown>),
        id: 'payroll-policy-2',
        version: 2,
        createdAt: '2026-07-16T18:00:00.000Z',
      }, 201);
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/payroll/policy')) {
      await fulfillJson(route, policy);
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/payroll/policies')) {
      await fulfillJson(route, { data: [policy], nextCursor: null });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/payroll/periods')) {
      await fulfillJson(route, {
        data: [period(currentBatch), ...(options.includeFuturePeriod ? [futurePeriod()] : [])],
        nextCursor: null,
      });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/payroll/periods/payroll-period-1')) {
      if (currentBatch && options.failNextPostExportRefresh && !postExportRefreshFailed) {
        postExportRefreshFailed = true;
        await route.abort('connectionreset');
        return;
      }
      await fulfillJson(route, periodDetail(currentBatch, amendments));
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/payroll/periods/payroll-period-1/exports')) {
      exportRequests.push({
        key: request.headers()['idempotency-key'] ?? '',
        body: request.postDataJSON(),
      });
      currentBatch = exportBatch();
      await fulfillJson(route, currentBatch, 201);
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/payroll/entries/payroll-entry-1/amendments')) {
      const body = request.postDataJSON() as Record<string, unknown>;
      options.amendmentRequests?.push({
        key: request.headers()['idempotency-key'] ?? '',
        body,
      });
      if (options.ambiguousAmendmentOnce && options.amendmentRequests?.length === 1) {
        await fulfillJson(route, { message: 'Temporary amendment write uncertainty.' }, 503);
        return;
      }
      const amendment = {
        id: 'payroll-amendment-1',
        lockedEntryId: 'payroll-entry-1',
        requestedByUserId: 'user-admin',
        replacementPayableMinutes: 450,
        minuteDelta: 0,
        createdAt: '2026-07-16T18:30:00.000Z',
        decision: null,
        ...body,
      };
      amendments.push(amendment);
      await fulfillJson(route, amendment, 201);
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/payroll/exports/payroll-batch-1/reconciliation')) {
      options.reconciliationRequests?.push(request.postDataJSON());
      if (options.ambiguousReconciliation) {
        await route.abort('connectionreset');
        return;
      }
      await fulfillJson(route, { recorded: true });
      return;
    }

    await fulfillJson(route, { message: `Unhandled payroll fixture route: ${request.method()} ${path}` }, 501);
  });
}

async function payrollBrowserStorage(page: Page) {
  return page.evaluate(() => {
    const entries = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) ?? '';
      return [key, storage.getItem(key) ?? ''] as const;
    }).filter(([key]) => key.startsWith('lunchlineup.payroll-'));
    return { local: entries(window.localStorage), session: entries(window.sessionStorage) };
  });
}

test.describe('Payroll control surface', () => {
  test.skip(runFullStack, 'The mock-backed payroll surface has deterministic evidence fixtures.');
  test.skip(!runMockReadiness, 'Payroll control-surface smoke requires the local mock API.');
  test.skip(({ browserName }) => browserName !== 'chromium', 'Desktop and mobile Chromium cover this deterministic surface.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok(), `mock API reset returned ${response.status()}`).toBeTruthy();
  });

  test('loads and operates through the shared app mock without private route overrides', async ({ page }) => {
    await loginAsSeedAdmin(page, '/dashboard/payroll');

    await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();
    await expect(page.getByText('LOCKED', { exact: true })).toBeVisible();
    await expect(page.getByText(/Unhandled mock endpoint/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Create deterministic export' }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Create the deterministic export?' });
    await expect(confirmation).toContainText('consumes exactly 1 credit');
    await confirmation.getByRole('button', { name: 'Confirm exact cost' }).click();

    await expect(page.getByText(/Deterministic batch created for 1 credit; balance 499/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'GENERATED' })).toBeVisible();
  });

  test('shows terminal evidence and creates one exact-cost paid export', async ({ page }) => {
    const exportRequests: Array<{ key: string; body: unknown }> = [];
    await installPayrollApi(page, exportRequests);
    await loginAsSeedAdmin(page, '/dashboard/payroll');

    await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Immutable payroll calendar' })).toBeVisible();
    await expect(page.getByText('Version 1', { exact: true })).toBeVisible();
    await expect(page.getByText('LOCKED', { exact: true })).toBeVisible();
    await expect(page.getByText('Count 1')).toBeVisible();
    await expect(page.getByText(/external payroll system remains authoritative/i)).toBeVisible();

    await page.getByRole('button', { name: 'Create deterministic export' }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Create the deterministic export?' });
    await expect(confirmation).toContainText('consumes exactly 1 credit');
    await confirmation.getByRole('button', { name: 'Confirm exact cost' }).click();

    await expect(page.getByText(/Deterministic batch created for 1 credit; balance 499/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'GENERATED' })).toBeVisible();
    await expect(page.getByText('1 credits')).toBeVisible();
    expect(exportRequests).toHaveLength(1);
    expect(exportRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(exportRequests[0].body).toEqual({ expectedCreditCost: 1 });

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  });

  test('keeps an acknowledged paid export terminal when its follow-up refresh fails', async ({ page }) => {
    const exportRequests: Array<{ key: string; body: unknown }> = [];
    await installPayrollApi(page, exportRequests, { failNextPostExportRefresh: true });
    await loginAsSeedAdmin(page, '/dashboard/payroll');

    await page.getByRole('button', { name: 'Create deterministic export' }).click();
    await page.getByRole('alertdialog', { name: 'Create the deterministic export?' })
      .getByRole('button', { name: 'Confirm exact cost' }).click();

    await expect(page.getByText(/Deterministic batch created for 1 credit; balance 499/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'GENERATED' })).toBeVisible();
    await expect(page.getByText(/export creation succeeded, but the latest payroll state could not be refreshed/i)).toBeVisible();
    await expect(page.getByText(/outcome is unclear|outcome is unknown|replay uses the same/i)).toHaveCount(0);
    expect(exportRequests).toHaveLength(1);
  });

  test('keeps the default Manager payroll workspace read-only', async ({ page }) => {
    await installPayrollApi(page, []);
    await loginAsSeedManager(page, '/dashboard/payroll');

    await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();
    await expect(page.getByText('LOCKED', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create policy version' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create period' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create deterministic export' })).toHaveCount(0);
  });

  for (const ineligible of [
    {
      name: 'inactive subscription',
      reason: 'Billable features require a current active paid subscription.',
    },
    {
      name: 'insufficient separate credits',
      reason: 'Feature requires 1 separately purchased usage credit.',
    },
  ]) {
    test(`honors authoritative ${ineligible.name} export ineligibility without POST`, async ({ page }) => {
      const exportRequests: Array<{ key: string; body: unknown }> = [];
      await installPayrollApi(page, exportRequests, {
        exportEntitlement: { eligible: false, creditCost: 1, reason: ineligible.reason },
      });
      await loginAsSeedAdmin(page, '/dashboard/payroll');

      await expect(page.getByText(ineligible.reason, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create deterministic export' })).toBeDisabled();
      expect(exportRequests).toEqual([]);
    });
  }

  test('corrects a rejected export line to accepted', async ({ page }) => {
    const reconciliationRequests: unknown[] = [];
    const base = exportBatch();
    await installPayrollApi(page, [], {
      initialBatch: exportBatch({
        status: 'RECONCILING',
        downloadedAt: '2026-07-16T17:10:00.000Z',
        lines: [{ ...base.lines[0], reconciliationStatus: 'REJECTED', reconciliationReason: 'Provider rejected once.' }],
        reconciliation: {
          acceptedCount: 0,
          rejectedCount: 1,
          pendingCount: 0,
          providerTotalMinutes: 450,
          latestProvider: 'Provider A',
          latestProviderEventId: 'event-rejected',
        },
      }),
      reconciliationRequests,
    });
    await loginAsSeedAdmin(page, '/dashboard/payroll');

    await expect(page.getByLabel('Outcome for export line 1')).toHaveValue('REJECTED');
    await page.getByLabel('Provider', { exact: true }).fill('Provider A');
    await page.getByLabel('Provider event ID').fill('event-corrected');
    await page.getByLabel('Outcome for export line 1').selectOption('ACCEPTED');
    await page.getByRole('button', { name: 'Record explicit line outcomes' }).click();

    await expect.poll(() => reconciliationRequests.length).toBe(1);
    expect(reconciliationRequests[0]).toEqual({
      provider: 'Provider A',
      providerEventId: 'event-corrected',
      providerTotalMinutes: 450,
      outcomes: [{ lineId: 'payroll-line-1', status: 'ACCEPTED', reason: 'Provider rejected once.' }],
    });
  });

  test('replays an accepted line to correct an all-accepted wrong provider total', async ({ page }) => {
    const reconciliationRequests: unknown[] = [];
    const base = exportBatch();
    await installPayrollApi(page, [], {
      initialBatch: exportBatch({
        status: 'RECONCILING',
        downloadedAt: '2026-07-16T17:10:00.000Z',
        lines: [{ ...base.lines[0], reconciliationStatus: 'ACCEPTED' }],
        reconciliation: {
          acceptedCount: 1,
          rejectedCount: 0,
          pendingCount: 0,
          providerTotalMinutes: 449,
          latestProvider: 'Provider A',
          latestProviderEventId: 'event-wrong-total',
        },
      }),
      reconciliationRequests,
    });
    await loginAsSeedAdmin(page, '/dashboard/payroll');

    await expect(page.getByLabel('Outcome for export line 1')).toHaveValue('ACCEPTED');
    await page.getByLabel('Provider', { exact: true }).fill('Provider A');
    await page.getByLabel('Provider event ID').fill('event-total-corrected');
    await page.getByRole('button', { name: 'Record explicit line outcomes' }).click();

    await expect.poll(() => reconciliationRequests.length).toBe(1);
    expect(reconciliationRequests[0]).toEqual({
      provider: 'Provider A',
      providerEventId: 'event-total-corrected',
      providerTotalMinutes: 450,
      outcomes: [{ lineId: 'payroll-line-1', status: 'ACCEPTED' }],
    });
  });

  test('replays identical policy and amendment forms after ambiguous 503 readback', async ({ page }) => {
    const policyRequests: Array<{ key: string; body: unknown }> = [];
    const amendmentRequests: Array<{ key: string; body: unknown }> = [];
    await installPayrollApi(page, [], {
      ambiguousPolicyOnce: true,
      ambiguousAmendmentOnce: true,
      amendmentRequests,
      includeFuturePeriod: true,
      policyRequests,
    });
    await loginAsSeedAdmin(page, '/dashboard/payroll');

    const futureEffectiveDate = nextWeeklyBoundary(policy.anchorDate, policy.timeZone);
    const effectiveDate = page.getByLabel('Future effective date');
    await effectiveDate.fill(futureEffectiveDate);
    await page.getByRole('button', { name: 'Create policy version' }).click();
    await expect(page.getByText(/Policy creation is unconfirmed/i)).toBeVisible();
    await expect(effectiveDate).toHaveValue(futureEffectiveDate);
    await page.getByRole('button', { name: 'Create policy version' }).click();
    await expect(page.getByText(/Policy version 2 created/i)).toBeVisible();

    expect(policyRequests).toHaveLength(2);
    expect(policyRequests[1]).toEqual(policyRequests[0]);
    expect(policyRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);

    await page.getByRole('button', { name: 'Amend into future period' }).click();
    const reason = page.getByRole('textbox', { name: 'Reason' });
    await reason.fill('Correct approved source evidence after provider confirmation.');
    await page.getByRole('button', { name: 'Create amendment only' }).click();
    await expect(page.getByText(/Amendment creation is unconfirmed/i)).toBeVisible();
    await expect(reason).toHaveValue('Correct approved source evidence after provider confirmation.');
    await page.getByRole('button', { name: 'Create amendment only' }).click();

    await expect.poll(() => amendmentRequests.length).toBe(2);
    expect(amendmentRequests[1]).toEqual(amendmentRequests[0]);
    expect(amendmentRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('keeps sensitive retry data out of localStorage and prevents cross-user replay', async ({ page }) => {
    const markers = {
      provider: 'P1_PROVIDER_BROWSER_9f613a',
      event: 'P1_EVENT_BROWSER_64db2c',
      outcome: 'P1_OUTCOME_BROWSER_08af71',
      amendmentReason: 'P1_AMENDMENT_BROWSER_a7e5d3',
      rejectionReason: 'P1_REJECTION_BROWSER_d3a75e',
      timestamp: 'P1_TIMESTAMP_BROWSER_2026-07-16T22:17:04.329Z',
    };
    const reconciliationRequests: unknown[] = [];
    await installPayrollApi(page, [], { ambiguousReconciliation: true, reconciliationRequests });
    await page.goto('/auth/login');
    await page.evaluate((rawMarkers) => {
      localStorage.setItem('lunchlineup.payroll-reconciliation.v1:legacy', JSON.stringify(rawMarkers));
      sessionStorage.setItem('lunchlineup.payroll-attempt.v2:legacy', JSON.stringify(rawMarkers));
    }, markers);

    await loginAsSeedAdmin(page, '/dashboard/payroll');
    await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();
    await expect.poll(async () => (await payrollBrowserStorage(page)).local).toEqual([]);

    await page.getByRole('button', { name: 'Create deterministic export' }).click();
    await page.getByRole('alertdialog', { name: 'Create the deterministic export?' })
      .getByRole('button', { name: 'Confirm exact cost' }).click();
    await expect(page.getByRole('heading', { name: 'Line-level reconciliation' })).toBeVisible();
    await page.getByLabel('Provider', { exact: true }).fill(markers.provider);
    await page.getByLabel('Provider event ID').fill(markers.event);
    await page.getByLabel('Outcome for export line 1').selectOption('REJECTED');
    await page.getByLabel('Reason for export line 1').fill(markers.rejectionReason);
    await page.getByRole('button', { name: 'Record explicit line outcomes' }).click();

    await expect(page.getByRole('button', { name: 'Replay same request' })).toBeVisible();
    expect(reconciliationRequests).toHaveLength(1);
    const storedWhileAmbiguous = JSON.stringify(await payrollBrowserStorage(page));
    for (const marker of Object.values(markers)) expect(storedWhileAmbiguous).not.toContain(marker);

    await Promise.all([
      page.waitForURL(/\/auth\/logout(?:[?#].*)?$/),
      page.getByRole('link', { name: 'Sign out' }).first().click(),
    ]);
    expect(await payrollBrowserStorage(page)).toEqual({ local: [], session: [] });

    await page.context().clearCookies();
    await loginAsSeedManager(page, '/dashboard/payroll');
    await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replay same request' })).toHaveCount(0);
    expect(reconciliationRequests).toHaveLength(1);
    const storedAsManager = JSON.stringify(await payrollBrowserStorage(page));
    for (const marker of Object.values(markers)) expect(storedAsManager).not.toContain(marker);
  });
});
