import {
  ApiRequestError,
  fetchJsonWithSession,
  fetchWithSession,
  withIdempotencyKey,
} from '@/lib/client-api';
import { payrollExportPath, payrollPeriodDetailPath, payrollPeriodsPath, payrollPoliciesPath } from './payroll-paths';
import {
  normalizePayrollAmendment,
  normalizePayrollExport,
  normalizePayrollPeriod,
  normalizePayrollPeriodDetail,
  normalizePayrollPolicy,
  normalizePayrollPolicyEnvelope,
} from './payroll-normalize';
import type {
  PayrollAmendment,
  PayrollDecision,
  PayrollExportBatch,
  PayrollPeriodDetail,
  PayrollPeriodSummary,
  PayrollPeriodsPage,
  PayrollPoliciesPage,
  PayrollPolicyInput,
  PayrollPolicyVersion,
  PayrollReconciliationInput,
} from './payroll-types';

function jsonRequest(method: 'POST' | 'PUT', payload: unknown, idempotencyKey?: string): RequestInit {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
  return idempotencyKey ? withIdempotencyKey(init, idempotencyKey) : init;
}

export async function fetchPayrollPolicy(): Promise<PayrollPolicyVersion | null> {
  return normalizePayrollPolicyEnvelope(await fetchJsonWithSession<unknown>('/payroll/policy'));
}

export async function fetchPayrollPolicies(cursor?: string | null): Promise<PayrollPoliciesPage> {
  const payload = await fetchJsonWithSession<{ data?: unknown[]; nextCursor?: string | null }>(payrollPoliciesPath(cursor));
  return { data: (payload.data ?? []).map(normalizePayrollPolicy), nextCursor: payload.nextCursor ?? null };
}

export async function createPayrollPolicyVersion(input: PayrollPolicyInput, idempotencyKey: string): Promise<PayrollPolicyVersion> {
  return normalizePayrollPolicy(await fetchJsonWithSession<unknown>(
    '/payroll/policy',
    jsonRequest('PUT', input, idempotencyKey),
  ));
}

export async function fetchPayrollPeriods(cursor?: string | null): Promise<PayrollPeriodsPage> {
  const payload = await fetchJsonWithSession<{ data?: unknown[]; nextCursor?: string | null }>(payrollPeriodsPath(cursor));
  return { data: (payload.data ?? []).map(normalizePayrollPeriod), nextCursor: payload.nextCursor ?? null };
}

export async function createPayrollPeriod(localStartDate: string, idempotencyKey: string): Promise<PayrollPeriodSummary> {
  return normalizePayrollPeriod(await fetchJsonWithSession<unknown>(
    '/payroll/periods',
    jsonRequest('POST', { localStartDate }, idempotencyKey),
  ));
}

export async function fetchPayrollPeriod(periodId: string, cardCursor?: string | null): Promise<PayrollPeriodDetail> {
  const detail = normalizePayrollPeriodDetail(await fetchJsonWithSession<unknown>(payrollPeriodDetailPath(periodId, cardCursor)));
  if (detail.period.id !== periodId) throw new Error('The payroll period response does not match the requested period. Refresh payroll.');
  return detail;
}

export type VersionBoundRows = {
  cards: Array<{ id: string; expectedRevision: number }>;
};

export async function adoptPayrollCards(
  periodId: string,
  payload: VersionBoundRows,
  idempotencyKey: string,
): Promise<{ adoptedCount: number }> {
  const response = await fetchJsonWithSession<{ cards?: unknown[] }>(
    `/payroll/periods/${encodeURIComponent(periodId)}/adopt`,
    jsonRequest('POST', payload, idempotencyKey),
  );
  return { adoptedCount: response.cards?.length ?? payload.cards.length };
}

export async function startPayrollReview(periodId: string, expectedRevision: number, idempotencyKey: string): Promise<PayrollPeriodSummary> {
  return normalizePayrollPeriod(await fetchJsonWithSession<unknown>(
    `/payroll/periods/${encodeURIComponent(periodId)}/review`,
    jsonRequest('POST', { expectedRevision }, idempotencyKey),
  ));
}

export async function decidePayrollCards(
  periodId: string,
  payload: { decisions: Array<{ timeCardId: string; expectedRevision: number; decision: PayrollDecision; reason?: string }> },
  idempotencyKey: string,
): Promise<{ decidedCount: number }> {
  const response = await fetchJsonWithSession<{ decisions?: unknown[] }>(
    `/payroll/periods/${encodeURIComponent(periodId)}/decisions`,
    jsonRequest('POST', payload, idempotencyKey),
  );
  return { decidedCount: response.decisions?.length ?? payload.decisions.length };
}

export async function lockPayrollPeriod(periodId: string, expectedRevision: number, idempotencyKey: string): Promise<PayrollPeriodSummary> {
  return normalizePayrollPeriod(await fetchJsonWithSession<unknown>(
    `/payroll/periods/${encodeURIComponent(periodId)}/lock`,
    jsonRequest('POST', { expectedRevision }, idempotencyKey),
  ));
}

export type PayrollAmendmentInput = {
  adjustmentPeriodId: string;
  reason: string;
  replacementClockInAt: string;
  replacementClockOutAt: string;
  replacementBreakMinutes: number;
};

export async function createPayrollAmendment(
  lockedEntryId: string,
  payload: PayrollAmendmentInput,
  idempotencyKey: string,
): Promise<PayrollAmendment> {
  return normalizePayrollAmendment(await fetchJsonWithSession<unknown>(
    `/payroll/entries/${encodeURIComponent(lockedEntryId)}/amendments`,
    jsonRequest('POST', payload, idempotencyKey),
  ));
}

export async function decidePayrollAmendment(
  amendmentId: string,
  payload: { decision: PayrollDecision; reason?: string },
  idempotencyKey: string,
): Promise<void> {
  await fetchJsonWithSession<unknown>(
    `/payroll/amendments/${encodeURIComponent(amendmentId)}/decision`,
    jsonRequest('POST', payload, idempotencyKey),
  );
}

function payrollResponseRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requirePayrollExportAcknowledgement(value: unknown, periodId: string): void {
  const root = payrollResponseRecord(value);
  const source = root && Object.prototype.hasOwnProperty.call(root, 'exportBatch')
    ? payrollResponseRecord(root.exportBatch) : root;
  const settlement = payrollResponseRecord(source?.settlement);
  const nonnegativeInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  // Validate acknowledgement evidence before normalization can invent defaults.
  // Opaque legacy IDs and native public UUIDs are both supported; period binding
  // is exact. A valid but unexpected charge is still a confirmed export, so the
  // caller retains its existing charge-warning behavior rather than replaying it.
  if (!source || typeof source.id !== 'string' || source.id.trim().length === 0
    || source.periodId !== periodId
    || !Number.isSafeInteger(source.formatVersion) || Number(source.formatVersion) < 1
    || typeof source.status !== 'string' || !['GENERATED', 'DOWNLOADED', 'RECONCILING', 'RECONCILED'].includes(source.status)
    || typeof source.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.contentSha256)
    || !nonnegativeInteger(source.rowCount) || !Number.isSafeInteger(source.totalPayableMinutes)
    || !settlement || !nonnegativeInteger(settlement.consumedCredits) || !nonnegativeInteger(settlement.newBalance)
    || typeof source.createdAt !== 'string' || !Number.isFinite(Date.parse(source.createdAt))) {
    // No HTTP rejection is inferred: the server may already have committed.
    throw new Error('The payroll export acknowledgement could not be verified. Refresh payroll before trying again.');
  }
}

export async function createPayrollExport(periodId: string, expectedCreditCost: number, idempotencyKey: string): Promise<PayrollExportBatch> {
  const response = await fetchJsonWithSession<unknown>(
    `/payroll/periods/${encodeURIComponent(periodId)}/exports`,
    jsonRequest('POST', { expectedCreditCost }, idempotencyKey),
  );
  requirePayrollExportAcknowledgement(response, periodId);
  return normalizePayrollExport(response);
}

export async function fetchPayrollExport(exportId: string, lineCursor?: string | null): Promise<PayrollExportBatch> {
  return normalizePayrollExport(await fetchJsonWithSession<unknown>(payrollExportPath(exportId, lineCursor)));
}

export async function reconcilePayrollExport(
  exportId: string,
  payload: PayrollReconciliationInput,
): Promise<void> {
  await fetchJsonWithSession<unknown>(
    `/payroll/exports/${encodeURIComponent(exportId)}/reconciliation`,
    jsonRequest('POST', {
      provider: payload.provider,
      providerEventId: payload.providerEventId,
      providerTotalMinutes: payload.providerTotalMinutes,
      outcomes: payload.lines,
    }),
  );
}

export async function downloadPayrollExport(exportId: string): Promise<void> {
  const response = await fetchWithSession(`/payroll/exports/${encodeURIComponent(exportId)}/download`);
  if (!response.ok) throw new ApiRequestError('Unable to download the payroll export.', response.status);
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = filenameMatch?.[1]?.replace(/[^A-Za-z0-9._-]/g, '_') || `payroll-${exportId}.csv`;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export async function fetchPayrollExportEntitlement(): Promise<unknown> {
  return fetchJsonWithSession<unknown>('/payroll/export-entitlement');
}
