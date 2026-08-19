import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  PayrollExportSchema,
  PayrollLockedEntrySchema,
  PayrollPeriodPathSchema,
  PayrollReconciliationRequestSchema,
} from './payroll';

const ids = {
  policy: '37d82160-1a96-47d9-a201-a7d6824c9a91',
  period: '6f96f164-cb4a-439b-af7e-4492e432345d',
  entry: 'a4ee6f95-a3de-43ac-9a93-36e8f7c34244',
  export: 'dc279e35-5d30-4e50-bf1a-f96a8143c485',
  line: '87ebd2d3-2625-4c80-ae85-2629d7cee5ca',
  user: 'd721f3fa-b0ce-4a12-b66d-e9c46b00ff58',
};

describe('API v2 payroll contract', () => {
  it('accepts a public-only immutable export with its bounded line page', () => {
    expect(Value.Check(PayrollExportSchema, {
      id: ids.export,
      periodId: ids.period,
      formatVersion: 1,
      status: 'DOWNLOADED',
      contentSha256: 'a'.repeat(64),
      rowCount: 1,
      totalPayableMinutes: 450,
      settlement: { consumedCredits: 1, newBalance: 4 },
      createdAt: '2026-07-19T00:00:00.000Z',
      downloadedAt: '2026-07-19T00:01:00.000Z',
      reconciledAt: null,
      updatedAt: '2026-07-19T00:01:00.000Z',
      lines: [{
        id: ids.line,
        lineNumber: 1,
        lockedEntryId: ids.entry,
        employeeId: ids.user,
        payableMinutes: 450,
        canonicalSha256: 'b'.repeat(64),
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
        latestPayloadSha256: null,
      },
    })).toBe(true);
  });

  it('accepts zero-based immutable snapshot sequence but rejects private IDs and caller tenant control', () => {
    expect(Value.Check(PayrollLockedEntrySchema, {
      id: ids.entry,
      sequence: 0,
      sourceType: 'TIME_CARD',
      sourceId: '0a1ca8f5-f2e0-4ecf-ba17-ae52942ce5b2',
      sourceRevision: 1,
      employeeId: ids.user,
      employeeName: 'Casey',
      locationId: null,
      workTimeZone: 'UTC',
      clockInAt: '2026-07-01T09:00:00.000Z',
      clockOutAt: '2026-07-01T16:30:00.000Z',
      breakMinutes: 0,
      payableMinutes: 450,
      approvedAt: '2026-07-02T00:00:00.000Z',
      approvedByUserId: ids.user,
      canonicalSha256: 'c'.repeat(64),
    })).toBe(true);
    expect(Value.Check(PayrollPeriodPathSchema, { periodId: 'private-period-primary-key' })).toBe(false);
    expect(Value.Check(PayrollReconciliationRequestSchema, {
      provider: 'Payroll Provider',
      providerEventId: 'evt-1',
      providerTotalMinutes: 450,
      outcomes: [{ lineId: ids.line, status: 'ACCEPTED' }],
      tenantId: 'caller-selected-tenant',
    })).toBe(false);
  });
});
