import { webcrypto } from 'node:crypto';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, clientComponentHarness, deferred, nodes } from './client-component-harness';

const mocks = vi.hoisted(() => ({ hooks: null as any, entitlement: vi.fn(), period: vi.fn(), periods: vi.fn(), create: vi.fn(), json: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => mocks.hooks.useState(...args),
  useRef: (...args: any[]) => mocks.hooks.useRef(...args),
  useEffect: (...args: any[]) => mocks.hooks.useEffect(...args),
  useCallback: (...args: any[]) => mocks.hooks.useCallback(...args),
  useMemo: (...args: any[]) => mocks.hooks.useMemo(...args),
}));
vi.mock('@/lib/client-api', async original => ({
  ...await original<typeof import('@/lib/client-api')>(), fetchJsonWithSession: mocks.json,
}));
vi.mock('../../app/dashboard/payroll/payroll-api', () => ({
  fetchPayrollPolicy: async () => null, fetchPayrollPolicies: async () => ({ data: [] }),
  fetchPayrollPeriods: mocks.periods, fetchPayrollPeriod: mocks.period,
  fetchPayrollExportEntitlement: mocks.entitlement, createPayrollExport: mocks.create,
}));
import { usePayrollWorkspace } from '../../app/dashboard/payroll/use-payroll-workspace';
import { PayrollPeriodDetail } from '../../app/dashboard/payroll/PayrollPeriodDetail';

// Actual hook and actual digest/key custody helpers. Explicit hook ledger and
// controlled transport/crypto waits are not React/DOM/browser or server proof.
const summary = (id: string) => ({ id, status: 'LOCKED' as const, revision: 2,
  localStartDate: id === 'A' ? '2026-10-01' : '2026-09-01', localEndDateExclusive: '2026-10-08',
  startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-08T00:00:00.000Z',
  timeZone: 'UTC', cadence: 'WEEKLY' as const, policyVersionId: 'policy', lockedEntryCount: 1,
  summary: { cardCount: 1, closedCardCount: 1, approvedCardCount: 1, rejectedCardCount: 0,
    pendingCardCount: 0, amendmentCount: 0, pendingAmendmentCount: 0, approvedAmendmentCount: 0, lockedEntryCount: 1 } });
const batch = { id: 'batch-A', periodId: 'A', status: 'GENERATED', settlement: { consumedCredits: 2, newBalance: 8 } };
const detail = (id: string, exported = false) => ({ period: { ...summary(id), ...(exported ? { exportBatch: batch } : {}) },
  cards: [], lockedEntries: [], amendments: [], nextCardCursor: null });
const eligible = { eligible: true, creditCost: 2, reason: 'Eligible' };
let h: ReturnType<typeof clientComponentHarness>;
let owner: string;
let state: ReturnType<typeof usePayrollWorkspace>;
let writes: Array<{ key: string; value: string; owner: string }>;
let digestGate: ReturnType<typeof deferred<void>> | null;
let digestEntered: ReturnType<typeof deferred<void>>;
let exported: boolean;
function storage() {
  const rows = new Map<string, string>();
  return { get length() { return rows.size; }, key: (index: number) => [...rows.keys()][index] ?? null,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push({ key, value, owner }); rows.set(key, value); },
    removeItem: (key: string) => { rows.delete(key); } };
}
function render() { mocks.hooks = h.hooks; state = h.render() as ReturnType<typeof usePayrollWorkspace>; return state; }
async function switchPeriod() { await render().loadPeriod('B'); render(); }
async function switchOwner() {
  owner = 'owner-B'; render(); h.flushEffects();
  await h.until(value => (value as typeof state).busyAction === null && (value as typeof state).detail?.period.id === 'A'); render();
}
function attemptWrites() { return writes.filter(write => write.key.startsWith('lunchlineup.payroll-attempt.v3:')); }
beforeEach(async () => {
  mocks.json.mockReset();
  owner = 'owner-A'; writes = []; digestGate = null; digestEntered = deferred<void>(); exported = false;
  mocks.entitlement.mockReset().mockResolvedValue(eligible);
  mocks.periods.mockReset().mockResolvedValue({ data: [summary('A'), summary('B')], nextCursor: null });
  mocks.period.mockReset().mockImplementation(async (id: string) => detail(id, id === 'A' && exported));
  mocks.create.mockReset().mockImplementation(async () => { exported = true; return batch; });
  vi.stubGlobal('window', { sessionStorage: storage(), localStorage: storage(), location: { href: 'https://controlled.test/dashboard/payroll' } });
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('crypto', { randomUUID: () => webcrypto.randomUUID(), subtle: {
    digest: async (algorithm: string, bytes: Uint8Array) => {
      if (digestGate && new TextDecoder().decode(bytes) === 'A') {
        const gate = digestGate; digestEntered.resolve(); await gate.promise;
      }
      return webcrypto.subtle.digest(algorithm, bytes as BufferSource);
    },
  } });
  h = clientComponentHarness(() => usePayrollWorkspace(true, owner)); mocks.hooks = h.hooks;
  render(); h.flushEffects(); await h.until(value => (value as typeof state).busyAction === null && (value as typeof state).detail?.period.id === 'A'); render();
  // Bootstrap and its authoritative entitlement have completed before each gate.
  mocks.entitlement.mockClear(); writes = [];
});
afterEach(() => { digestGate?.resolve(); h?.unmount(); vi.unstubAllGlobals(); });

describe('actual payroll export intent and response custody', () => {
  it.each(['foreign', 'malformed'] as const)('retains the exact attempt for a %s acknowledgement through the real API boundary', async mode => {
    const api = await vi.importActual<typeof import('../../app/dashboard/payroll/payroll-api')>('../../app/dashboard/payroll/payroll-api');
    const rawBatch = { ...batch, formatVersion: 1, contentSha256: 'a'.repeat(64), rowCount: 1,
      totalPayableMinutes: 450, createdAt: '2026-10-01T12:00:00.000Z', lines: [] };
    const readback = deferred<unknown>(); const entered = deferred<void>();
    mocks.create.mockImplementation(api.createPayrollExport); mocks.period.mockImplementation(api.fetchPayrollPeriod);
    mocks.json.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/payroll/periods/A/exports' && init?.method === 'POST') {
        return Promise.resolve(mode === 'foreign' ? { ...rawBatch, periodId: 'B', id: 'batch-B' } : {});
      }
      if (path === '/payroll/periods/A?cardLimit=250&lineLimit=500') { entered.resolve(); return readback.promise; }
      throw new Error('Unexpected controlled payroll path: ' + path);
    });
    const operation = render().exportPeriod(2);
    let staged: ReturnType<typeof attemptWrites>[number] | undefined;
    try {
      await entered.promise;
      expect(render().notice).toBeNull(); expect(state.detail?.period.exportBatch).toBeUndefined();
      expect(attemptWrites()).toHaveLength(1); staged = attemptWrites()[0];
      expect(JSON.parse(staged.value).key).toBe(mocks.create.mock.calls[0][2]);
      expect(window.sessionStorage.getItem(staged.key)).toBe(staged.value);
    } finally {
      readback.resolve({ ...detail('A'), period: { ...summary('A'), exportBatch: rawBatch } }); await operation;
    }
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith('A', 2, expect.any(String));
    expect(mocks.json).toHaveBeenCalledTimes(2);
    expect(render().detail?.period.id).toBe('A'); expect(state.detail?.period.exportBatch?.id).toBe('batch-A');
    expect(state.notice).toBeNull(); expect(state.error).toContain('unclear');
    expect(staged).toBeDefined(); expect(window.sessionStorage.getItem(staged!.key)).toBe(staged!.value);
  });
  it('retains a verified A acknowledgement when real period validation rejects a foreign readback', async () => {
    const api = await vi.importActual<typeof import('../../app/dashboard/payroll/payroll-api')>('../../app/dashboard/payroll/payroll-api');
    const rawBatch = { ...batch, formatVersion: 1, contentSha256: 'a'.repeat(64), rowCount: 1,
      totalPayableMinutes: 450, createdAt: '2026-10-01T12:00:00.000Z', lines: [] };
    mocks.create.mockImplementation(api.createPayrollExport); mocks.period.mockImplementation(api.fetchPayrollPeriod);
    mocks.json.mockResolvedValueOnce(rawBatch).mockResolvedValueOnce(detail('B'));
    await render().exportPeriod(2);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith('A', 2, expect.any(String));
    expect(mocks.json).toHaveBeenCalledTimes(2);
    expect(render().selectedPeriodId).toBe('A'); expect(state.detail?.period.id).toBe('A');
    expect(state.detail?.period.exportBatch?.id).toBe('batch-A');
    expect(state.notice).toContain('Payroll export created for 2 credits; balance 8');
    expect(state.error).toContain('succeeded'); expect(state.error).toContain('do not repeat');
    expect(attemptWrites()).toHaveLength(1);
    expect(window.sessionStorage.getItem(attemptWrites()[0].key)).toBeNull();
    expect(state.periods.find(period => period.id === 'B')?.exportBatch).toBeUndefined();
  });
  it('keeps a verified differing charge terminal through the real API without clearing the warning', async () => {
    const api = await vi.importActual<typeof import('../../app/dashboard/payroll/payroll-api')>('../../app/dashboard/payroll/payroll-api');
    const rawBatch = { ...batch, formatVersion: 1, contentSha256: 'a'.repeat(64), rowCount: 1,
      totalPayableMinutes: 450, createdAt: '2026-10-01T12:00:00.000Z', lines: [],
      settlement: { consumedCredits: 3, newBalance: 7 } };
    mocks.create.mockImplementation(api.createPayrollExport); mocks.period.mockImplementation(api.fetchPayrollPeriod);
    mocks.json.mockResolvedValueOnce(rawBatch).mockResolvedValueOnce({ ...detail('A'), period: { ...summary('A'), exportBatch: rawBatch } });
    await render().exportPeriod(2);
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.json).toHaveBeenCalledTimes(2);
    expect(render().notice).toBe('The payroll export was created but its credit charge differs from the confirmation. Do not create it again.');
    expect(state.error).toBeNull(); expect(state.detail?.period.exportBatch?.settlement).toEqual({ consumedCredits: 3, newBalance: 7 });
    expect(attemptWrites()).toHaveLength(1); expect(window.sessionStorage.getItem(attemptWrites()[0].key)).toBeNull();
  });
  it('exports current A with one exact-cost request and acknowledged readback', async () => {
    await render().exportPeriod(2);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith('A', 2, expect.any(String));
    expect(render().detail?.period.exportBatch?.id).toBe('batch-A');
    expect(state.notice).toContain('Payroll export created for 2 credits; balance 8');
  });
  it('keeps acknowledged A terminal when its follow-up readback fails', async () => {
    mocks.period.mockRejectedValueOnce(new Error('controlled readback failure'));
    await render().exportPeriod(2);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(render().detail?.period.exportBatch?.id).toBe('batch-A');
    expect(state.error).toContain('succeeded'); expect(state.error).toContain('do not repeat');
    expect(state.notice).toContain('Payroll export created');
  });
  it('refuses obsolete A after selecting B while entitlement waits', async () => {
    const gate = deferred<typeof eligible>(); mocks.entitlement.mockReturnValueOnce(gate.promise);
    const operation = render().exportPeriod(2);
    try { await switchPeriod(); } finally { gate.resolve(eligible); await operation; }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(render().selectedPeriodId).toBe('B'); expect(state.detail?.period.id).toBe('B');
  });
  it('refuses obsolete A after selecting B while actual key hashing waits', async () => {
    digestGate = deferred<void>(); const operation = render().exportPeriod(2);
    try { await digestEntered.promise; await switchPeriod(); } finally { digestGate.resolve(); await operation; }
    expect(mocks.create).not.toHaveBeenCalled(); expect(attemptWrites()).toHaveLength(0);
    expect(render().selectedPeriodId).toBe('B'); expect(state.detail?.period.id).toBe('B');
  });
  it('refuses an old owner continuation while entitlement waits', async () => {
    const gate = deferred<typeof eligible>(); mocks.entitlement.mockReturnValueOnce(gate.promise);
    const operation = render().exportPeriod(2);
    try { await switchOwner(); } finally { gate.resolve(eligible); await operation; }
    expect(mocks.create).not.toHaveBeenCalled(); expect(attemptWrites()).toHaveLength(0);
  });
  it('cannot write an old owner attempt after hashing resumes in a new owner', async () => {
    digestGate = deferred<void>(); const operation = render().exportPeriod(2);
    try { await digestEntered.promise; await switchOwner(); } finally { digestGate.resolve(); await operation; }
    expect(mocks.create).not.toHaveBeenCalled(); expect(attemptWrites()).toHaveLength(0);
  });
  it('registers one export flight synchronously before entitlement returns', async () => {
    const gate = deferred<typeof eligible>(); mocks.entitlement.mockReturnValue(gate.promise);
    const callback = render().exportPeriod;
    const first = callback(2); const second = callback(2);
    gate.resolve(eligible); await Promise.all([first, second]);
    expect(mocks.entitlement).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('requires reconfirmation when fresh authoritative cost changes', async () => {
    mocks.entitlement.mockResolvedValueOnce({ ...eligible, creditCost: 3 });
    await render().exportPeriod(2);
    expect(mocks.create).not.toHaveBeenCalled(); expect(render().error).toContain('Confirm the new exact cost');
  });
  it('does not replace B detail when a sent A export completes later', async () => {
    const gate = deferred<typeof batch>(); const entered = deferred<void>();
    mocks.create.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const operation = render().exportPeriod(2);
    try {
      await entered.promise;
      expect(mocks.create).toHaveBeenCalledTimes(1); await switchPeriod(); exported = true;
    } finally { gate.resolve(batch); await operation; }
    expect(render().selectedPeriodId).toBe('B'); expect(state.detail?.period.id).toBe('B');
    expect(state.periods.find(period => period.id === 'A')?.exportBatch?.id).toBe('batch-A');
  });
  it('replays the exact sent A request key after an ambiguous lost response', async () => {
    mocks.create.mockRejectedValueOnce(new Error('controlled lost response'));
    await render().exportPeriod(2); const original = [...mocks.create.mock.calls[0]];
    expect(render().error).toContain('unclear');
    await state.exportPeriod(2);
    expect(mocks.create.mock.calls[1]).toEqual(original); expect(state.selectedPeriodId).toBe('A');
    expect(render().detail?.period.exportBatch?.id).toBe('batch-A');
  });
  it('does not install a late A follow-up readback after acknowledged export and selection of B', async () => {
    const gate = deferred<ReturnType<typeof detail>>(); const entered = deferred<void>();
    mocks.period.mockImplementation(async (id: string) => {
      if (id === 'A' && exported) { entered.resolve(); return gate.promise; }
      return detail(id);
    });
    const operation = render().exportPeriod(2);
    try { await entered.promise; expect(render().detail?.period.exportBatch?.id).toBe('batch-A'); await switchPeriod(); }
    finally { gate.resolve(detail('A', true)); await operation; }
    expect(render().selectedPeriodId).toBe('B'); expect(state.detail?.period.id).toBe('B');
    expect(state.periods.find(period => period.id === 'A')?.exportBatch?.id).toBe('batch-A');
  });
  it('a sent old owner response cannot clear the new owner exact replay custody or feedback', async () => {
    const gate = deferred<typeof batch>(); const entered = deferred<void>();
    mocks.create.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const oldOperation = render().exportPeriod(2);
    try {
      await entered.promise; await switchOwner();
      mocks.create.mockRejectedValueOnce(new Error('new owner controlled lost response'));
      await render().exportPeriod(2);
      const newCall = [...mocks.create.mock.calls[1]];
      const error = render().error; const before = attemptWrites().map(write => write.value);
      expect(error).toContain('unclear');
      gate.resolve(batch); await oldOperation;
      expect(render().error).toBe(error); expect(state.notice).toBeNull();
      expect(state.detail?.period.exportBatch).toBeUndefined();
      expect(attemptWrites().map(write => write.value)).toEqual(before);
      await state.exportPeriod(2); expect(mocks.create.mock.calls[2]).toEqual(newCall);
    } finally { gate.resolve(batch); await oldOperation; }
  });
  it('the actual confirmation cancel handler invalidates an unsent entitlement continuation', async () => {
    const gate = deferred<typeof eligible>(); mocks.entitlement.mockReturnValueOnce(gate.promise);
    let operation: Promise<void> | undefined;
    let reopenedPanelSurvived = false;
    const callback = render().exportPeriod;
    const cancel = state.cancelExportPreparation;
    const component = clientComponentHarness(() => createElement(PayrollPeriodDetail, {
      detail: state.detail, periods: state.periods, currentUserId: owner,
      capabilities: { canExportPayroll: true }, creditCost: 2, creditCostError: null,
      reconciliationReplay: null, busyAction: state.busyAction,
      onExport: (cost: number) => { operation = callback(cost); return operation; },
      onCancelExportPreparation: cancel,
    } as any));
    const draw = () => { mocks.hooks = component.hooks; return component.render(); };
    try {
      draw(); component.flushEffects();
      button(draw(), 'Create payroll export').props.onClick();
      button(draw(), 'Create export').props.onClick();
      render();
      const close = nodes(draw()).find(node => node.props['aria-label'] === 'Cancel confirmation');
      expect(close).toBeDefined(); close!.props.onClick();
      render();
      button(draw(), 'Create payroll export').props.onClick();
    } finally {
      gate.resolve(eligible); await operation;
      reopenedPanelSurvived = nodes(draw()).some(node => node.props.role === 'alertdialog');
      component.unmount();
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(render().busyAction).toBeNull();
    // Completion of the canceled handler must not dismiss the reopened panel.
    expect(reopenedPanelSurvived).toBe(true);
  });
  it('cancellation after dispatch preserves an ambiguous sent attempt for exact replay', async () => {
    const gate = deferred<typeof batch>(); const entered = deferred<void>();
    mocks.create.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const operation = render().exportPeriod(2);
    try { await entered.promise; render().cancelExportPreparation(); }
    finally { gate.reject(new Error('controlled lost sent response')); await operation; }
    const original = [...mocks.create.mock.calls[0]];
    await render().exportPeriod(2); expect(mocks.create.mock.calls[1]).toEqual(original);
    expect(render().detail?.period.exportBatch?.id).toBe('batch-A');
  });
});
