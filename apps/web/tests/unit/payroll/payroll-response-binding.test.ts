import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, fetchJsonWithSession } from '@/lib/client-api';
import { createPayrollExport, fetchPayrollPeriod } from '../../../app/dashboard/payroll/payroll-api';

vi.mock('@/lib/client-api', async original => ({
  ...await original<typeof import('@/lib/client-api')>(), fetchJsonWithSession: vi.fn(),
}));
const transport = vi.mocked(fetchJsonWithSession);
const A = '93000000-0000-4000-8000-000000000001';
const B = '93000000-0000-4000-8000-000000000002';
const KEY = '99000000-0000-4000-8000-000000000001';
const batch = (overrides: Record<string, unknown> = {}) => ({
  id: '95000000-0000-4000-8000-000000000001', periodId: A, formatVersion: 1,
  status: 'GENERATED', contentSha256: 'a'.repeat(64), rowCount: 0, totalPayableMinutes: 0,
  settlement: { consumedCredits: 1, newBalance: 9 }, createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z', downloadedAt: null, reconciledAt: null,
  lines: [], nextLineCursor: null, reconciliation: { acceptedCount: 0, rejectedCount: 0, pendingCount: 0,
    providerTotalMinutes: null, latestProvider: null, latestProviderEventId: null, latestPayloadSha256: null },
  ...overrides,
});
beforeEach(() => transport.mockReset());

describe('payroll requested-resource response binding', () => {
  it('accepts a direct native receipt and preserves the exact sent command and key', async () => {
    transport.mockResolvedValueOnce(batch());
    await expect(createPayrollExport(A, 1, KEY)).resolves.toMatchObject({ id: batch().id, periodId: A,
      status: 'GENERATED', settlement: { consumedCredits: 1, newBalance: 9 } });
    expect(transport).toHaveBeenCalledTimes(1);
    const [path, init] = transport.mock.calls[0];
    expect(path).toBe(`/payroll/periods/${A}/exports`);
    expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toEqual({ expectedCreditCost: 1 });
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(KEY);
  });
  it('preserves legacy opaque IDs, compatible envelopes, zero charges and signed payable totals', async () => {
    const receipt = batch({ id: 'legacy-batch-A', periodId: 'legacy/period A', totalPayableMinutes: -15,
      settlement: { consumedCredits: 0, newBalance: 0 } });
    transport.mockResolvedValueOnce({ exportBatch: receipt });
    await expect(createPayrollExport('legacy/period A', 1, KEY)).resolves.toMatchObject({
      id: 'legacy-batch-A', periodId: 'legacy/period A', totalPayableMinutes: -15,
      settlement: { consumedCredits: 0, newBalance: 0 } });
    expect(transport.mock.calls[0][0]).toBe('/payroll/periods/legacy%2Fperiod%20A/exports');
  });
  it('rejects foreign-period direct and enveloped acknowledgements without retrying the command', async () => {
    for (const receipt of [batch({ periodId: B }), { exportBatch: batch({ periodId: B }) }]) {
      transport.mockReset().mockResolvedValueOnce(receipt);
      await expect(createPayrollExport(A, 1, KEY)).rejects.toThrow('acknowledgement could not be verified');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects missing or malformed acknowledgement evidence before normalizer defaults can confirm it', async () => {
    const invalid: unknown[] = [null, {}, [], 'ok', { id: 'batch', periodId: A }, { exportBatch: {} },
      batch({ id: '' }), batch({ id: '   ' }), batch({ periodId: null }), batch({ formatVersion: 0 }),
      batch({ formatVersion: '1' }), batch({ status: 'unexpected' }), batch({ status: ['GENERATED'] }),
      batch({ contentSha256: 'not-a-hash' }), batch({ rowCount: -1 }), batch({ rowCount: '0' }),
      batch({ totalPayableMinutes: 0.5 }), batch({ settlement: null }),
      batch({ settlement: { consumedCredits: '1', newBalance: 9 } }),
      batch({ settlement: { consumedCredits: 1, newBalance: -1 } }),
      batch({ settlement: { consumedCredits: 1 } }), batch({ createdAt: 'invalid' })];
    for (const receipt of invalid) {
      transport.mockReset().mockResolvedValueOnce(receipt);
      await expect(createPayrollExport(A, 1, KEY), JSON.stringify(receipt)).rejects.toThrow('acknowledgement could not be verified');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('keeps a structurally valid charge mismatch confirmed for the existing caller warning', async () => {
    transport.mockResolvedValueOnce(batch({ settlement: { consumedCredits: 2, newBalance: 8 } }));
    await expect(createPayrollExport(A, 1, KEY)).resolves.toMatchObject({ periodId: A,
      settlement: { consumedCredits: 2, newBalance: 8 } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('binds direct and enveloped period details to the exact requested ID while preserving cursors', async () => {
    for (const receipt of [{ id: A, cards: { data: [], nextCursor: 'next-card' } },
      { period: { id: A }, cards: [], nextCardCursor: 'next-card' }]) {
      transport.mockReset().mockResolvedValueOnce(receipt);
      await expect(fetchPayrollPeriod(A, 'card / cursor')).resolves.toMatchObject({ period: { id: A }, nextCardCursor: 'next-card' });
      expect(transport).toHaveBeenCalledExactlyOnceWith(`/payroll/periods/${A}?cardLimit=250&lineLimit=500&cardCursor=card+%2F+cursor`);
    }
  });
  it('rejects foreign or missing period identity before a readback can replace the requested period', async () => {
    for (const receipt of [{ id: B }, { period: { id: B } }, {}, null, { period: {} }]) {
      transport.mockReset().mockResolvedValueOnce(receipt);
      await expect(fetchPayrollPeriod(A)).rejects.toThrow('does not match the requested period');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('preserves server rejection errors and does not turn validation into an HTTP rejection', async () => {
    const rejected = new ApiRequestError('Configured credit cost changed', 409);
    transport.mockRejectedValueOnce(rejected);
    await expect(createPayrollExport(A, 1, KEY)).rejects.toBe(rejected);
    transport.mockResolvedValueOnce({});
    const invalid = await createPayrollExport(A, 1, KEY).catch(error => error as unknown);
    expect(invalid).toBeInstanceOf(Error); expect(invalid).not.toBeInstanceOf(ApiRequestError);
  });
});
