import { PAYROLL_CARD_PAGE_SIZE, PAYROLL_EXPORT_LINE_PAGE_SIZE, PAYROLL_PERIOD_PAGE_SIZE, PAYROLL_POLICY_PAGE_SIZE } from './payroll-contract';

export function payrollPoliciesPath(cursor?: string | null): string {
  const query = new URLSearchParams({ limit: String(PAYROLL_POLICY_PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  return `/payroll/policies?${query.toString()}`;
}

export function payrollPeriodsPath(cursor?: string | null): string {
  const query = new URLSearchParams({ limit: String(PAYROLL_PERIOD_PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  return `/payroll/periods?${query.toString()}`;
}

export function payrollPeriodDetailPath(periodId: string, cardCursor?: string | null): string {
  const query = new URLSearchParams({
    cardLimit: String(PAYROLL_CARD_PAGE_SIZE),
    lineLimit: String(PAYROLL_EXPORT_LINE_PAGE_SIZE),
  });
  if (cardCursor) query.set('cardCursor', cardCursor);
  return `/payroll/periods/${encodeURIComponent(periodId)}?${query.toString()}`;
}

export function payrollExportPath(exportId: string, lineCursor?: string | null): string {
  const query = new URLSearchParams({ lineLimit: String(PAYROLL_EXPORT_LINE_PAGE_SIZE) });
  if (lineCursor) query.set('lineCursor', lineCursor);
  return `/payroll/exports/${encodeURIComponent(exportId)}?${query.toString()}`;
}
