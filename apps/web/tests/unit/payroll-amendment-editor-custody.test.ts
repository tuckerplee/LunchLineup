import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeEvent, clientComponentHarness, deferred, form, nodes, submitEvent, text } from './client-component-harness';

const mocks = vi.hoisted(() => ({ hooks: null as any, create: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => mocks.hooks.useState(...args),
  useRef: (...args: any[]) => mocks.hooks.useRef(...args),
  useMemo: (...args: any[]) => mocks.hooks.useMemo(...args),
}));
import { PayrollAmendments } from '../../app/dashboard/payroll/PayrollAmendments';

// Actual component handlers + deterministic hook ledger and controlled callback.
// This is not React scheduling, DOM/browser, HTTP or persisted payroll proof.
const entry = (id: string, hour = '09') => ({ id, employeeId: `employee-${id}`, employeeName: id,
  sequence: id === 'A' ? 1 : 2, payableMinutes: 450, breakMinutes: 30, workTimeZone: 'UTC',
  clockInAt: `2026-10-01T${hour}:00:00.000Z`, clockOutAt: '2026-10-01T17:00:00.000Z' });
const period = (id: string, day: string) => ({ id, status: 'OPEN', startsAt: `2026-10-${day}T00:00:00.000Z`,
  localStartDate: `2026-10-${day}`, localEndDateExclusive: '2026-11-01' });
let h: ReturnType<typeof clientComponentHarness>;
function render() { mocks.hooks = h.hooks; return h.render(); }
function field(label: string) {
  const group = nodes(render()).find(node => node.type === 'label'
    && text(node.props.children).trim().startsWith(label));
  const found = group && nodes(group.props.children).find(node => ['input', 'textarea', 'select'].includes(String(node.type)));
  if (!found) throw new Error(`Missing amendment field: ${label}`);
  return found;
}
function change(label: string, value: string) { field(label).props.onChange(changeEvent(value)); }
function open(id: 'A' | 'B') {
  const buttons = nodes(render()).filter(node => node.type === 'button' && text(node).includes('Add future correction'));
  buttons[id === 'A' ? 0 : 1].props.onClick();
}
function cancel() { nodes(render()).find(node => node.props['aria-label'] === 'Cancel amendment')!.props.onClick(); }
function draft() { return ['Future open period', 'Replacement clock in', 'Replacement clock out', 'Replacement break minutes', 'Reason'].map(label => field(label).props.value); }
const payload = { adjustmentPeriodId: 'future-1', reason: 'Fix recorded break',
  replacementClockInAt: '2026-10-01T09:00:00.000Z', replacementClockOutAt: '2026-10-01T17:00:00.000Z', replacementBreakMinutes: 30 };
beforeEach(() => {
  mocks.create.mockReset();
  h = clientComponentHarness(() => createElement(PayrollAmendments, {
    entries: [entry('A'), entry('B', '10')], amendments: [],
    periods: [period('future-1', '08'), period('future-2', '15')],
    sourcePeriod: { endsAt: '2026-10-08T00:00:00.000Z' }, currentUserId: 'reviewer',
    canCreate: true, canDecide: false, isBusy: false, onCreate: mocks.create, onDecision: vi.fn(),
  } as any));
  open('A'); change('Reason', '  Fix recorded break  ');
});
afterEach(() => h.unmount());

describe('actual payroll amendment editor response custody', () => {
  it.each([
    ['Future open period', 'future-2'], ['Replacement clock in', '2026-10-01T08:30'],
    ['Replacement clock out', '2026-10-01T17:30'], ['Replacement break minutes', '15'],
    ['Reason', 'New draft reason'],
  ])('preserves newer %s after delayed success without mutating the submitted payload', async (label, value) => {
    const gate = deferred<boolean>(); mocks.create.mockReturnValueOnce(gate.promise);
    const operation = form(render()).props.onSubmit(submitEvent());
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith('A', payload);
    change(label, value); const newer = draft();
    gate.resolve(true); await operation;
    expect(draft()).toEqual(newer); expect(field(label).props.value).toBe(value);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith('A', payload);
  });
  it('closes the unchanged submitted draft after acknowledged success', async () => {
    const gate = deferred<boolean>(); mocks.create.mockReturnValueOnce(gate.promise);
    const operation = form(render()).props.onSubmit(submitEvent());
    expect(nodes(render()).filter(node => node.type === 'form')).toHaveLength(1);
    gate.resolve(true); await operation;
    expect(nodes(render()).filter(node => node.type === 'form')).toHaveLength(0);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith('A', payload);
  });
  it.each(['rejected-result', 'ambiguous-rejection'] as const)('retains exact draft after %s and never retries implicitly', async outcome => {
    const gate = deferred<boolean>(); mocks.create.mockReturnValueOnce(gate.promise);
    const before = draft(); const operation = form(render()).props.onSubmit(submitEvent());
    if (outcome === 'ambiguous-rejection') {
      const rejection = expect(operation).rejects.toThrow('controlled lost acknowledgement');
      gate.reject(new Error('controlled lost acknowledgement')); await rejection;
    } else { gate.resolve(false); await operation; }
    expect(draft()).toEqual(before); expect(mocks.create).toHaveBeenCalledExactlyOnceWith('A', payload);
  });
  it.each(['A', 'B'] as const)('preserves a canceled then reopened %s editor after the original A succeeds', async id => {
    const gate = deferred<boolean>(); mocks.create.mockReturnValueOnce(gate.promise);
    const operation = form(render()).props.onSubmit(submitEvent());
    cancel(); expect(nodes(render()).filter(node => node.type === 'form')).toHaveLength(0);
    open(id); change('Reason', `Reopened ${id} draft`); const reopened = draft();
    gate.resolve(true); await operation;
    expect(draft()).toEqual(reopened);
    expect(field('Replacement clock in').props.value).toBe(`2026-10-01T${id === 'A' ? '09' : '10'}:00`);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith('A', payload);
  });
});
