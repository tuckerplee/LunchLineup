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
  return normalizePayrollPeriodDetail(await fetchJsonWithSession<unknown>(payrollPeriodDetailPath(periodId, cardCursor)));
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

export async function createPayrollExport(periodId: string, expectedCreditCost: number, idempotencyKey: string): Promise<PayrollExportBatch> {
  return normalizePayrollExport(await fetchJsonWithSession<unknown>(
    `/payroll/periods/${encodeURIComponent(periodId)}/exports`,
    jsonRequest('POST', { expectedCreditCost }, idempotencyKey),
  ));
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
