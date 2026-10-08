import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  lunchBreakDayWindow,
  lunchBreakShiftDraft,
  lunchBreakShiftRange,
  lunchBreakShiftLabel,
  lunchBreakTimeValue,
  resolveLunchBreakInstant,
} from '../../app/dashboard/lunch-breaks/lunch-break-time';

describe('lunch break location time helpers', () => {
  it('queries the selected location calendar day across DST', () => {
    expect(lunchBreakDayWindow('2026-03-08', 'America/Los_Angeles')).toEqual({
      startIso: '2026-03-08T08:00:00.000Z',
      endIso: '2026-03-09T07:00:00.000Z',
    });
  });

  it('persists wall-clock setup shifts in the selected location timezone', () => {
    expect(lunchBreakShiftRange('2026-07-09', '09:00', '17:00', 0, 'America/Los_Angeles')).toEqual({
      startIso: '2026-07-09T16:00:00.000Z',
      endIso: '2026-07-10T00:00:00.000Z',
    });
  });

  it('keeps overnight shifts on local calendar boundaries', () => {
    const range = lunchBreakShiftRange('2026-11-01', '22:00', '02:00', 1, 'America/Los_Angeles');
    expect(range).toEqual({
      startIso: '2026-11-02T06:00:00.000Z',
      endIso: '2026-11-02T10:00:00.000Z',
    });
    expect(resolveLunchBreakInstant(range!.startIso, range!.endIso, '01:30', 'America/Los_Angeles')).toBe(
      '2026-11-02T09:30:00.000Z',
    );
    expect(lunchBreakTimeValue(range!.startIso, 'America/Los_Angeles')).toBe('22:00');
  });

  it('round-trips an overnight 23:00-07:00 interval with an explicit next-day end', () => {
    const range = lunchBreakShiftRange('2026-07-09', '23:00', '07:00', 1, 'America/Los_Angeles');
    expect(range).toEqual({
      startIso: '2026-07-10T06:00:00.000Z',
      endIso: '2026-07-10T14:00:00.000Z',
    });
    expect(lunchBreakShiftDraft(range!.startIso, range!.endIso, 'America/Los_Angeles')).toEqual({
      dateValue: '2026-07-09',
      startTime: '23:00',
      endTime: '07:00',
      endDayOffset: 1,
    });
  });

  it.each([
    ['2026-11-01', '01:30', '03:00', 0],
    ['2026-11-01', '00:30', '01:30', 0],
    ['2026-10-31', '22:00', '01:30', 1],
    ['2026-03-08', '02:30', '04:00', 0],
    ['2026-03-08', '00:30', '02:30', 0],
  ] as const)('refuses an ambiguous or nonexistent setup boundary %s %s–%s +%s', (date, start, end, offset) => {
    expect(lunchBreakShiftRange(date, start, end, offset, 'America/Los_Angeles')).toBeNull();
  });

  it.each([
    ['2026-11-01T07:00:00.000Z', '2026-11-01T12:00:00.000Z', '01:30'],
    ['2026-11-01T05:00:00.000Z', '2026-11-01T12:00:00.000Z', '01:30'],
    ['2026-03-08T08:00:00.000Z', '2026-03-08T12:00:00.000Z', '02:30'],
  ])('refuses a fold or gap break within shift %s–%s', (start, end, clock) => {
    expect(resolveLunchBreakInstant(start, end, clock, 'America/Los_Angeles')).toBeNull();
  });

  it('accepts unambiguous boundaries surrounding each DST transition with exact elapsed instants', () => {
    expect(lunchBreakShiftRange('2026-11-01', '00:30', '02:30', 0, 'America/Los_Angeles')).toEqual({
      startIso: '2026-11-01T07:30:00.000Z', endIso: '2026-11-01T10:30:00.000Z',
    });
    expect(lunchBreakShiftRange('2026-03-08', '01:30', '03:30', 0, 'America/Los_Angeles')).toEqual({
      startIso: '2026-03-08T09:30:00.000Z', endIso: '2026-03-08T10:30:00.000Z',
    });
  });

  it.each(['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z'])(
    'retains the authoritative %s fold occurrence for an unchanged displayed clock', original => {
      expect(lunchBreakTimeValue(original, 'America/Los_Angeles')).toBe('01:30');
      expect(resolveLunchBreakInstant('2026-11-01T07:00:00.000Z', '2026-11-01T12:00:00.000Z',
        '01:30', 'America/Los_Angeles', original)).toBe(original);
      // A changed repeated clock must not borrow the original occurrence implicitly.
      expect(resolveLunchBreakInstant('2026-11-01T07:00:00.000Z', '2026-11-01T12:00:00.000Z',
        '01:45', 'America/Los_Angeles', original)).toBeNull();
      // A real, unambiguous edit supersedes the original persisted instant.
      expect(resolveLunchBreakInstant('2026-11-01T07:00:00.000Z', '2026-11-01T12:00:00.000Z',
        '02:30', 'America/Los_Angeles', original)).toBe('2026-11-01T10:30:00.000Z');
    },
  );

  it.each([null, 'not-an-instant', '2026-10-31T08:30:00.000Z', '2026-11-02T09:30:00.000Z'])(
    'does not use invalid or outside-shift original instant %s to resolve a fold', original => {
      expect(resolveLunchBreakInstant('2026-11-01T07:00:00.000Z', '2026-11-01T12:00:00.000Z',
        '01:30', 'America/Los_Angeles', original)).toBeNull();
    },
  );

  it('preserves a valid next-day overnight original without borrowing an outside-shift fold', () => {
    expect(resolveLunchBreakInstant('2026-11-02T06:00:00.000Z', '2026-11-02T10:00:00.000Z',
      '01:30', 'America/Los_Angeles', '2026-11-02T09:30:00.000Z')).toBe('2026-11-02T09:30:00.000Z');
    expect(resolveLunchBreakInstant('2026-11-02T06:00:00.000Z', '2026-11-02T10:00:00.000Z',
      '01:30', 'America/Los_Angeles', '2026-11-01T09:30:00.000Z')).toBe('2026-11-02T09:30:00.000Z');
  });

  it('fails closed instead of inferring or clamping an invalid same-day overnight range', () => {
    expect(lunchBreakShiftRange('2026-07-09', '23:00', '07:00', 0, 'America/Los_Angeles')).toBeNull();
    expect(lunchBreakShiftDraft(
      '2026-07-10T06:00:00.000Z',
      '2026-07-12T14:00:00.000Z',
      'America/Los_Angeles',
    )).toBeNull();
  });
});

// Execute source-extracted page computations, not a copied implementation. This
// checks saved-field/preview/request wiring, not React, transport or persistence.
const pageSource = readFileSync(resolve(__dirname, '../../app/dashboard/lunch-breaks/page.tsx'), 'utf8');
const pageAst = ts.createSourceFile('page.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function pageComputation(name: string, bindings: Record<string, unknown>) {
  const matches: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push('(' + node.getText(pageAst) + ')');
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      if (name !== 'breaks' || node.initializer.getText(pageAst).startsWith('BREAK_KEYS.map')) matches.push(node.initializer.getText(pageAst));
    }
    ts.forEachChild(node, visit);
  }
  visit(pageAst);
  expect(matches).toHaveLength(1);
  const compiled = ts.transpileModule('const value = ' + matches[0] + ';', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), compiled + '\nreturn value;')(...Object.values(bindings));
}

describe('saved DST break page preview and request computation', () => {
  it.each(['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z'])(
    'keeps %s distinct through editable row, preview and no-op save body', original => {
      const build = pageComputation('buildEditableBreak', { lunchBreakTimeValue });
      const generated = { breaks: [{ type: 'lunch', startTime: original, durationMinutes: 30 }] };
      const row = { shiftId: 'shift-fold', employeeName: 'Ada', startTime: '2026-11-01T07:00:00.000Z', endTime: '2026-11-01T12:00:00.000Z',
        break1: build(generated, 'break1', 15, 'America/Los_Angeles'),
        lunch: build(generated, 'lunch', 30, 'America/Los_Angeles'),
        break2: build(generated, 'break2', 15, 'America/Los_Angeles') };
      expect(row.lunch).toMatchObject({ time: '01:30', originalStartIso: original, skipped: false });
      const bindings = { BREAK_KEYS: ['break1', 'lunch', 'break2'], row, activeTimeZone: 'America/Los_Angeles', resolveLunchBreakInstant };
      expect(pageComputation('breaks', bindings)).toEqual([
        { type: 'break1', skip: true }, { type: 'lunch', startTime: original, durationMinutes: 30, skip: false }, { type: 'break2', skip: true },
      ]);
      const preview = pageComputation('previewRows', { ...bindings, dayRows: [row], plannerMode: 'auto', canWriteLunchBreaks: true,
        standalonePreview: [], useMemo: (compute: () => unknown) => compute(), lunchBreakShiftLabel,
        BREAK_META: { lunch: { label: 'Lunch' } }, clamp: (value: number, low: number, high: number) => Math.max(low, Math.min(high, value)),
      });
      expect(preview[0].segments).toEqual([{ id: 'shift-fold-lunch', label: 'Lunch', tone: 'meal',
        leftPct: original === '2026-11-01T08:30:00.000Z' ? 30 : 50, widthPct: 10 }]);
      row.lunch.time = '01:45';
      expect(() => pageComputation('breaks', bindings)).toThrow('outside of the shift window');
    },
  );
});
