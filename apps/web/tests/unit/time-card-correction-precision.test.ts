import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { jsonWriteInit } from '../../app/dashboard/time-cards/time-card-api';
import {
    formatTimeCardDuration, formatTimeCardTimestamp,
    timeCardInstantToLocalInput, timeCardLocalInputCandidates,
} from '../../app/dashboard/time-cards/time-card-format';
import type { TimeCard } from '../../app/dashboard/time-cards/time-card-types';
import { validateTimeCardCorrection } from '../../../api-v2/src/time/validation';
import type { TimeCardCorrectionRequest, TimeCardRecord } from '@lunchlineup/api-contract';
import { correctionAcknowledgement } from '../../app/dashboard/time-cards/time-card-correction-ack';

// Evaluate the real panel's declarations, initializers and handlers with finite
// hook slots. Only its final JSX return is removed; there is no payload builder,
// mounted React, DOM/browser timing, network, database or native qualification.
const panelPath = resolve(process.cwd(), 'app/dashboard/time-cards/TimeCardCorrectionPanel.tsx');
const panelSource = readFileSync(panelPath, 'utf8');
const ast = ts.createSourceFile(panelPath, panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const components = ast.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'TimeCardCorrectionPanel');
if (components.length !== 1 || !components[0].body) throw new Error('Expected one actual correction panel');
const body = components[0].body;
const returns = body.statements.filter(ts.isReturnStatement);
if (returns.length !== 1 || body.statements.at(-1) !== returns[0]) throw new Error('Expected one final panel JSX return');
const declarationText = body.statements.slice(0, -1).map(node => node.getText(ast)).join('\n');
const utilityText = ast.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && ['breakFieldKey', 'withoutKey'].includes(node.name?.text ?? ''))
    .map(node => node.getText(ast)).join('\n');
const executable = ts.transpileModule(`${utilityText}\nfunction evaluatePanel({ card, onCancel, onSaved }) {
${declarationText}
return { submit, updateDateTime, inspectDateTime, renderAmbiguity, updateBreak, addBreak, removeBreak,
    setBreaksTouched, setReason, setClockInAt, setClockOutAt,
    setAmbiguitySelections, updateReason, updateAmbiguitySelection, clearLegacyBreak,
    clockInAt, clockOutAt, reason, breaks, error, isSaving, requiresRefresh };
}\nreturn evaluatePanel;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;

type PanelBindings = {
    submit(event: { preventDefault(): void }): Promise<void>;
    updateDateTime(key: string, value: string, setter: (value: string) => void): void;
    inspectDateTime(key: string, value: string): void;
    renderAmbiguity(key: string): unknown;
    updateBreak(key: string, field: 'startAt' | 'endAt', value: string): void;
    addBreak(): void; removeBreak(key: string): void;
    updateReason(value: string): void; updateAmbiguitySelection(key: string, value: string): void; clearLegacyBreak(): void;
    setBreaksTouched(value: boolean): void;
    setReason(value: string): void; setClockInAt(value: string): void; setClockOutAt(value: string): void;
    setAmbiguitySelections(value: Record<string, string>): void;
    clockInAt: string; clockOutAt: string;
    breaks: { key: string; startAt: string; endAt: string }[];
    reason: string; error: string | null; isSaving: boolean; requiresRefresh: boolean;
};

function card(overrides: Partial<TimeCard> = {}): TimeCard {
    return { id: '60000000-0000-4000-8000-000000000001', userId: '60000000-0000-4000-8000-000000000002',
        clockInAt: '2026-10-04T09:00:00.000Z', clockOutAt: '2026-10-04T10:00:00.000Z',
        breakMinutes: 0, status: 'CLOSED', grossMinutes: 60, workedMinutes: 60,
        updatedAt: '2026-10-04T10:01:00.000Z', displayTimeZone: 'UTC', breaks: [], ...overrides };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

function acknowledged(selected: TimeCard, payload: TimeCardCorrectionRequest, ordinal: number): TimeCardRecord {
    return { ...selected, locationId: selected.locationId ?? null, shiftId: null,
        clockInAt: payload.clockInAt!, clockOutAt: payload.clockOutAt!,
        status: payload.clockOutAt === null ? 'OPEN' : 'CLOSED', revision: ordinal + 1,
        notes: selected.notes ?? null, createdAt: selected.clockInAt,
        updatedAt: new Date(new Date(selected.updatedAt).getTime() + ordinal * 1000).toISOString(),
        breaks: (payload.breakIntervals ?? selected.breaks ?? []).map((interval, index) => ({
            id: `60000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
            startAt: interval.startAt, endAt: interval.endAt,
        })),
        user: { id: selected.userId, name: 'Time actor', username: null, role: 'STAFF' },
        location: selected.location ?? null };
}

type FixtureOptions = {
    hold?: Promise<void>; entered?: () => void;
    respond?: (ack: TimeCardRecord, payload: TimeCardCorrectionRequest) => unknown;
    invalidJson?: boolean;
};
function fixture(selected: TimeCard, now = new Date('2026-10-04T20:00:00.000Z'), responseStatus = 200,
    options: FixtureOptions = {}) {
    const slots: unknown[] = []; let index = 0;
    const writes: { path: string; init: RequestInit; payload: TimeCardCorrectionRequest }[] = [];
    const onSaved = vi.fn(async (_ack: TimeCard, _canClose: () => boolean) => undefined), onCancel = vi.fn();
    let cleanup: (() => void) | undefined;
    const useState = (initial: unknown) => {
        const slot = index++;
        if (slot === slots.length) slots.push(typeof initial === 'function' ? initial() : initial);
        return [slots[slot], (next: unknown) => {
            slots[slot] = typeof next === 'function' ? next(slots[slot]) : next;
        }];
    };
    const fetchWithSession = vi.fn(async (path: string, init: RequestInit) => {
        if (path !== `/time-cards/${selected.id}/correction` || init.method !== 'PATCH'
            || typeof init.body !== 'string') throw new Error('Unexpected correction handoff');
        const payload = JSON.parse(init.body) as TimeCardCorrectionRequest;
        writes.push({ path, init, payload });
        const ack = acknowledged(selected, payload, writes.length);
        const body = responseStatus === 200 ? options.respond?.(ack, payload) ?? ack
            : { message: 'This time card belongs to a locked payroll period.' };
        options.entered?.(); await options.hold;
        return new Response(options.invalidJson ? '{' : JSON.stringify(body), { status: responseStatus,
            headers: { 'Content-Type': 'application/json' } });
    });
    const bindings = { useState,
        useRef: (initial: unknown) => { const slot = index++; if (slot === slots.length) slots.push({ current: initial }); return slots[slot]; },
        useEffect: (effect: () => () => void) => { if (!cleanup) cleanup = effect(); },
        correctionAcknowledgement, fetchWithSession, jsonWriteInit, formatTimeCardDuration,
        formatTimeCardTimestamp, timeCardInstantToLocalInput, timeCardLocalInputCandidates,
        crypto: { randomUUID: () => '60000000-0000-4000-8000-000000000003' },
        React: { createElement: () => { throw new Error('JSX rendering is outside this fixture'); } } };
    const evaluate = new Function(...Object.keys(bindings), executable)(...Object.values(bindings)) as
        (props: { card: TimeCard; onCancel: () => void; onSaved: (ack: TimeCard, canClose: () => boolean) => Promise<void> }) => PanelBindings;
    const render = () => { index = 0; return evaluate({ card: selected, onCancel, onSaved }); };
    const initial = render();
    const submit = async () => {
        const preventDefault = vi.fn(); await render().submit({ preventDefault });
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(render().isSaving).toBe(false);
        // An unexpected target/effect cannot disappear into submit's catch.
        expect(fetchWithSession.mock.calls).toHaveLength(writes.length);
        if (writes.length) {
            expect(writes[0].path).toBe(`/time-cards/${selected.id}/correction`);
            expect(writes[0].payload.expectedUpdatedAt).toBe(selected.updatedAt);
            expect(new Headers(writes[0].init.headers).get('content-type')).toBe('application/json');
        }
    };
    const validate = () => {
        expect(writes).toHaveLength(1);
        return validateTimeCardCorrection(writes[0].payload, {
            clockInAt: new Date(selected.clockInAt), clockOutAt: selected.clockOutAt ? new Date(selected.clockOutAt) : null,
            updatedAt: new Date(selected.updatedAt), breakMinutes: selected.breakMinutes,
            breaks: (selected.breaks ?? []).map(interval => ({ startAt: new Date(interval.startAt), endAt: new Date(interval.endAt) })),
        }, now);
    };
    initial.setReason('Reviewing this operational time record');
    return { render, initial, submit, validate, writes, onSaved, fetchWithSession, unmount: () => cleanup?.() };
}

function exactPunches(payload: TimeCardCorrectionRequest, selected: TimeCard) {
    expect(payload.clockInAt).toBe(selected.clockInAt);
    expect(payload.clockOutAt).toBe(selected.clockOutAt);
}

describe('actual correction panel precise untouched values and explicit edits', () => {
    it('preserves untouched seconds and milliseconds punches through actual initialization and submit', async () => {
        const selected = card({ clockInAt: '2026-10-04T09:00:59.750Z', clockOutAt: '2026-10-04T10:00:01.125Z',
            grossMinutes: 59, workedMinutes: 59 });
        const f = fixture(selected);
        expect(f.initial.clockInAt).toBe('2026-10-04T09:00');
        await f.submit(); expect(f.writes).toHaveLength(1); expect(f.onSaved).toHaveBeenCalledOnce();
        const result = f.validate();
        expect(Math.floor((result.clockOutAt!.getTime() - result.clockInAt.getTime()) / 60000)).toBe(59);
        exactPunches(f.writes[0].payload, selected);
    });

    it('preserves eligible whole-minute-duration breaks with untouched nonzero-second endpoints', async () => {
        const selected = card({ breakMinutes: 5, workedMinutes: 55, breaks: [{
            id: '60000000-0000-4000-8000-000000000004',
            startAt: '2026-10-04T09:20:59.750Z', endAt: '2026-10-04T09:25:59.750Z' }] });
        const f = fixture(selected); await f.submit(); expect(f.onSaved).toHaveBeenCalledOnce();
        const result = f.validate(); expect(result.breakMinutes).toBe(5);
        expect(f.writes[0].payload.breakIntervals).toEqual(selected.breaks!.map(({ startAt, endAt }) => ({ startAt, endAt })));
    });

    it('preserves a known original repeated-DST instant without artificial occurrence reselection', async () => {
        const selected = card({ clockInAt: '2026-11-01T09:30:00.000Z', clockOutAt: '2026-11-01T10:30:00.000Z',
            displayTimeZone: 'America/Los_Angeles' });
        const f = fixture(selected, new Date('2026-11-01T12:00:00.000Z'));
        expect(f.initial.clockInAt).toBe('2026-11-01T01:30');
        expect(timeCardLocalInputCandidates(f.initial.clockInAt, selected.displayTimeZone)).toHaveLength(2);
        await f.submit(); expect(f.render().error).toBeNull(); expect(f.writes).toHaveLength(1);
        exactPunches(f.writes[0].payload, selected); expect(f.validate().clockInAt.toISOString()).toBe(selected.clockInAt);
    });

    it('keeps minute-aligned unchanged punch values valid under the actual owner', async () => {
        const selected = card(), f = fixture(selected); await f.submit();
        expect(f.writes).toHaveLength(1); exactPunches(f.writes[0].payload, selected);
        expect(f.validate()).toMatchObject({ breakMinutes: 0, status: 'CLOSED' });
        expect(f.onSaved).toHaveBeenCalledOnce(); expect(f.render().error).toBeNull();
    });

    it('applies an explicitly edited unambiguous local punch and validates its owner window', async () => {
        const f = fixture(card()); f.initial.updateDateTime('clock-in', '2026-10-04T09:10', f.initial.setClockInAt);
        await f.submit(); expect(f.writes[0].payload.clockInAt).toBe('2026-10-04T09:10:00.000Z');
        expect(f.validate().clockInAt.toISOString()).toBe('2026-10-04T09:10:00.000Z');
    });

    it('requires occurrence selection for an explicitly edited repeated-DST punch', async () => {
        const f = fixture(card({ clockInAt: '2026-11-01T08:00:00.000Z', clockOutAt: '2026-11-01T10:30:00.000Z',
            displayTimeZone: 'America/Los_Angeles' }), new Date('2026-11-01T12:00:00.000Z'));
        f.initial.updateDateTime('clock-in', '2026-11-01T01:30', f.initial.setClockInAt);
        await f.submit(); expect(f.writes).toEqual([]); expect(f.onSaved).not.toHaveBeenCalled();
        expect(f.render().error).toContain('Select the correct occurrence');
    });

    it('applies the explicitly selected repeated-DST occurrence', async () => {
        const f = fixture(card({ clockInAt: '2026-11-01T08:00:00.000Z', clockOutAt: '2026-11-01T10:30:00.000Z',
            displayTimeZone: 'America/Los_Angeles' }), new Date('2026-11-01T12:00:00.000Z'));
        f.initial.updateDateTime('clock-in', '2026-11-01T01:30', f.initial.setClockInAt);
        f.initial.setAmbiguitySelections({ 'clock-in': '2026-11-01T09:30:00.000Z' });
        await f.submit(); expect(f.writes[0].payload.clockInAt).toBe('2026-11-01T09:30:00.000Z');
        expect(f.validate().clockInAt.toISOString()).toBe('2026-11-01T09:30:00.000Z');
    });

    it('refuses an explicitly edited skipped-DST local time before request handoff', async () => {
        const f = fixture(card({ clockInAt: '2026-03-08T09:00:00.000Z', clockOutAt: '2026-03-08T12:00:00.000Z',
            displayTimeZone: 'America/Los_Angeles' }), new Date('2026-03-08T20:00:00.000Z'));
        f.initial.updateDateTime('clock-in', '2026-03-08T02:30', f.initial.setClockInAt);
        await f.submit(); expect(f.writes).toEqual([]); expect(f.onSaved).not.toHaveBeenCalled();
        expect(f.render().error).toContain('does not exist');
    });

    it('preserves a legacy aggregate break on a timestamp-only correction', async () => {
        const f = fixture(card({ breakMinutes: 7, workedMinutes: 53 }));
        f.initial.updateDateTime('clock-out', '2026-10-04T10:10', f.initial.setClockOutAt);
        await f.submit(); expect(f.writes[0].payload).not.toHaveProperty('breakIntervals');
        expect(f.validate()).toMatchObject({ breakMinutes: 7, breakIntervals: null });
    });

    it('preserves the opposite precise punch when one punch is explicitly edited', async () => {
        const selected = card({ clockInAt: '2026-10-04T09:00:59.750Z', clockOutAt: '2026-10-04T10:00:01.125Z' });
        const f = fixture(selected);
        f.initial.updateDateTime('clock-in', '2026-10-04T09:10', f.initial.setClockInAt);
        await f.submit();
        expect(f.writes[0].payload.clockInAt).toBe('2026-10-04T09:10:00.000Z');
        expect(f.writes[0].payload.clockOutAt).toBe(selected.clockOutAt);
        expect(f.validate().clockOutAt!.toISOString()).toBe(selected.clockOutAt);
    });

    it('preserves opposite and unrelated precise break endpoints and honestly refuses incoherent duration', async () => {
        const selected = card({ breakMinutes: 10, breaks: [
            { id: 'break-a', startAt: '2026-10-04T09:20:59.750Z', endAt: '2026-10-04T09:25:59.750Z' },
            { id: 'break-b', startAt: '2026-10-04T09:40:30.000Z', endAt: '2026-10-04T09:45:30.000Z' },
        ] });
        const f = fixture(selected); f.initial.updateBreak('break-a', 'startAt', '2026-10-04T09:21');
        await f.submit();
        expect(f.writes[0].payload.breakIntervals).toEqual([
            { startAt: '2026-10-04T09:21:00.000Z', endAt: selected.breaks![0].endAt },
            { startAt: selected.breaks![1].startAt, endAt: selected.breaks![1].endAt },
        ]);
        // The controlled 200 only exposes the actual submitted request. It is
        // not owner admission: the real validator must still reject this edit.
        expect(() => f.validate()).toThrow('whole-minute boundaries');
    });

    it('admits coherent two-endpoint edits without rounding a different interval', async () => {
        const selected = card({ breakMinutes: 10, breaks: [
            { id: 'break-a', startAt: '2026-10-04T09:20:59.750Z', endAt: '2026-10-04T09:25:59.750Z' },
            { id: 'break-b', startAt: '2026-10-04T09:40:30.000Z', endAt: '2026-10-04T09:45:30.000Z' },
        ] });
        const f = fixture(selected); f.initial.updateBreak('break-a', 'startAt', '2026-10-04T09:21');
        f.render().updateBreak('break-a', 'endAt', '2026-10-04T09:26'); await f.submit();
        expect(f.writes[0].payload.breakIntervals).toEqual([
            { startAt: '2026-10-04T09:21:00.000Z', endAt: '2026-10-04T09:26:00.000Z' },
            { startAt: selected.breaks![1].startAt, endAt: selected.breaks![1].endAt },
        ]);
        expect(f.validate().breakMinutes).toBe(10);
    });

    it('blur of an untouched known repeated time needs no artificial required selector', async () => {
        const selected = card({ clockInAt: '2026-11-01T09:15:59.750Z', clockOutAt: '2026-11-01T09:45:59.750Z',
            displayTimeZone: 'America/Los_Angeles', breakMinutes: 5, breaks: [
                { id: 'break-a', startAt: '2026-11-01T09:20:30.000Z', endAt: '2026-11-01T09:25:30.000Z' },
            ] });
        const f = fixture(selected, new Date('2026-11-01T12:00:00.000Z'));
        for (const [key, value] of [['clock-in', f.initial.clockInAt], ['clock-out', f.initial.clockOutAt],
            ['break-break-a-startAt', f.initial.breaks[0].startAt], ['break-break-a-endAt', f.initial.breaks[0].endAt]]) {
            f.render().inspectDateTime(key, value); expect(f.render().renderAmbiguity(key)).toBeNull();
        }
        await f.submit(); expect(f.render().error).toBeNull(); exactPunches(f.writes[0].payload, selected);
        expect(f.validate().breakMinutes).toBe(5);
    });

    it('respecifying the same repeated wall time is an explicit edit requiring a fresh selection', async () => {
        const f = fixture(card({ clockInAt: '2026-11-01T09:30:00.000Z', clockOutAt: '2026-11-01T10:30:00.000Z',
            displayTimeZone: 'America/Los_Angeles' }), new Date('2026-11-01T12:00:00.000Z'));
        f.initial.updateDateTime('clock-in', f.initial.clockInAt, f.initial.setClockInAt);
        await f.submit(); expect(f.writes).toEqual([]); expect(f.onSaved).not.toHaveBeenCalled();
        expect(f.render().error).toContain('Select the correct occurrence');
    });

    it('adds a new interval while preserving the existing precise interval', async () => {
        const selected = card({ breakMinutes: 5, breaks: [
            { id: 'break-a', startAt: '2026-10-04T09:20:59.750Z', endAt: '2026-10-04T09:25:59.750Z' },
        ] });
        const f = fixture(selected); f.initial.addBreak();
        const key = f.render().breaks[1].key;
        f.render().updateBreak(key, 'startAt', '2026-10-04T09:40');
        f.render().updateBreak(key, 'endAt', '2026-10-04T09:45'); await f.submit();
        expect(f.writes[0].payload.breakIntervals).toEqual([
            { startAt: selected.breaks![0].startAt, endAt: selected.breaks![0].endAt },
            { startAt: '2026-10-04T09:40:00.000Z', endAt: '2026-10-04T09:45:00.000Z' },
        ]); expect(f.validate().breakMinutes).toBe(10);
    });

    it('removes an interval without rounding the surviving evidence', async () => {
        const selected = card({ breakMinutes: 10, breaks: [
            { id: 'break-a', startAt: '2026-10-04T09:20:59.750Z', endAt: '2026-10-04T09:25:59.750Z' },
            { id: 'break-b', startAt: '2026-10-04T09:40:30.000Z', endAt: '2026-10-04T09:45:30.000Z' },
        ] });
        const f = fixture(selected); f.initial.removeBreak('break-a'); await f.submit();
        expect(f.writes[0].payload.breakIntervals).toEqual([
            { startAt: selected.breaks![1].startAt, endAt: selected.breaks![1].endAt },
        ]); expect(f.validate().breakMinutes).toBe(5);
    });

    it('explicitly clears a legacy aggregate through the actual clear-action setter', async () => {
        const f = fixture(card({ breakMinutes: 7 })); f.initial.setBreaksTouched(true);
        await f.submit(); expect(f.writes[0].payload.breakIntervals).toEqual([]);
        expect(f.validate()).toMatchObject({ breakMinutes: 0, breakIntervals: [] });
    });

    it('retains an untouched open null end and allows explicitly clearing a closed end', async () => {
        const open = card({ clockOutAt: null, status: 'OPEN', clockInAt: '2026-10-04T09:00:59.750Z' });
        const f = fixture(open); await f.submit(); exactPunches(f.writes[0].payload, open);
        expect(f.validate()).toMatchObject({ clockOutAt: null, status: 'OPEN' });
        const closed = fixture(card()); closed.initial.updateDateTime('clock-out', '', closed.initial.setClockOutAt);
        await closed.submit(); expect(closed.writes[0].payload.clockOutAt).toBeNull();
        expect(closed.validate()).toMatchObject({ clockOutAt: null, status: 'OPEN' });
    });

    it.each([409, 422])('retains a refused owner error and does not publish saved completion for HTTP %i', async responseStatus => {
        const selected = card({ clockInAt: '2026-10-04T09:00:59.750Z' });
        const f = fixture(selected, undefined, responseStatus); await f.submit();
        expect(f.writes).toHaveLength(1); exactPunches(f.writes[0].payload, selected);
        expect(f.render().error).toBe('This time card belongs to a locked payroll period.');
        expect(f.onSaved).not.toHaveBeenCalled();
        expect(f.render().clockInAt).toBe(f.initial.clockInAt);
    });
});


// These cases execute the same extracted panel handlers and the real response
// validator. The hook ledger models synchronous refs/state and explicit cleanup,
// not React scheduling, a mounted DOM, transport delivery or server authority.
describe('actual correction acknowledgement and newer draft custody', () => {
    it('preserves pending reason and punch edits and uses the acknowledged CAS for an explicit second save', async () => {
        const gate = deferred<void>(), entered = deferred<void>();
        const f = fixture(card(), undefined, 200, { hold: gate.promise, entered: () => entered.resolve() });
        const pending = f.render().submit({ preventDefault: vi.fn() });
        try {
            await entered.promise;
            f.render().updateReason('Newer correction reason remains owned');
            f.render().updateDateTime('clock-out', '2026-10-04T10:30', f.render().setClockOutAt);
            const draft = f.render(); expect(draft.reason).toBe('Newer correction reason remains owned');
            expect(draft.clockOutAt).toBe('2026-10-04T10:30');
            gate.resolve(); await pending;
            expect(f.writes).toHaveLength(1); expect(f.onSaved).toHaveBeenCalledOnce();
            const [firstAck, canClose] = f.onSaved.mock.calls[0];
            expect(firstAck.updatedAt).toBe('2026-10-04T10:01:01.000Z'); expect(canClose()).toBe(false);
            expect(f.render().reason).toBe(draft.reason); expect(f.render().clockOutAt).toBe(draft.clockOutAt);
            expect(f.render().isSaving).toBe(false); expect(f.render().requiresRefresh).toBe(false);
            await f.render().submit({ preventDefault: vi.fn() });
            expect(f.writes).toHaveLength(2);
            expect(f.writes[1].payload).toMatchObject({ expectedUpdatedAt: firstAck.updatedAt,
                reason: draft.reason, clockOutAt: '2026-10-04T10:30:00.000Z' });
            expect(f.onSaved.mock.calls[1][1]()).toBe(true);
        } finally { gate.resolve(); await pending; }
    });

    it.each(['reason', 'punch', 'add-break', 'update-break', 'remove-break', 'clear-legacy', 'ambiguity'] as const)(
        'a pending %s edit invalidates clean completion even when its displayed value can repeat', async path => {
            const gate = deferred<void>(), entered = deferred<void>();
            const selected = card({ breakMinutes: 5, breaks: [{ id: '60000000-0000-4000-8000-000000000004',
                startAt: '2026-10-04T09:20:00.000Z', endAt: '2026-10-04T09:25:00.000Z' }] });
            const f = fixture(selected, undefined, 200, { hold: gate.promise, entered: () => entered.resolve() });
            const pending = f.render().submit({ preventDefault: vi.fn() });
            try {
                await entered.promise; const p = f.render();
                if (path === 'reason') p.updateReason(p.reason);
                if (path === 'punch') p.updateDateTime('clock-in', p.clockInAt, p.setClockInAt);
                if (path === 'add-break') p.addBreak();
                if (path === 'update-break') p.updateBreak(p.breaks[0].key, 'startAt', p.breaks[0].startAt);
                if (path === 'remove-break') p.removeBreak(p.breaks[0].key);
                if (path === 'clear-legacy') p.clearLegacyBreak();
                if (path === 'ambiguity') p.updateAmbiguitySelection('clock-in', '2026-10-04T09:00:00.000Z');
                gate.resolve(); await pending;
                expect(f.onSaved).toHaveBeenCalledOnce(); expect(f.onSaved.mock.calls[0][1]()).toBe(false);
                expect(f.writes).toHaveLength(1); expect(f.render().error).toBeNull();
            } finally { gate.resolve(); await pending; }
        });

    it.each(['partial', 'wrong-card', 'wrong-user', 'bad-version', 'invalid-calendar-version', 'wrong-punch', 'wrong-break', 'invalid-json'] as const)(
        'retains the draft and refuses a guessed next CAS after a %s success response', async kind => {
            const f = fixture(card(), undefined, 200, { invalidJson: kind === 'invalid-json', respond: ack => {
                if (kind === 'partial') return { id: ack.id };
                if (kind === 'wrong-card') return { ...ack, id: '60000000-0000-4000-8000-000000000099' };
                if (kind === 'wrong-user') return { ...ack, userId: '60000000-0000-4000-8000-000000000099' };
                if (kind === 'bad-version') return { ...ack, updatedAt: 'not-a-version' };
                if (kind === 'invalid-calendar-version') return { ...ack, updatedAt: '2026-02-30T10:00:00.000Z' };
                if (kind === 'wrong-punch') return { ...ack, clockOutAt: '2026-10-04T10:30:00.000Z' };
                if (kind === 'wrong-break') return { ...ack, breaks: [{ id: '60000000-0000-4000-8000-000000000005',
                    startAt: '2026-10-04T09:21:00.000Z', endAt: '2026-10-04T09:26:00.000Z' }] };
                return ack;
            } });
            // Explicit empty intervals bind the response's entire break list.
            f.initial.clearLegacyBreak(); const before = f.render(); await f.submit();
            expect(f.writes).toHaveLength(1); expect(f.onSaved).not.toHaveBeenCalled();
            expect(f.render().requiresRefresh).toBe(true); expect(f.render().error).toContain('Cancel and refresh');
            expect(f.render().reason).toBe(before.reason); expect(f.render().clockOutAt).toBe(before.clockOutAt);
            await f.render().submit({ preventDefault: vi.fn() });
            expect(f.writes).toHaveLength(1); expect(f.render().isSaving).toBe(false);
        });

    it('refuses synchronous duplicate handoffs and an unmounted late acknowledgement without publishing or resetting state', async () => {
        const gate = deferred<void>(), entered = deferred<void>();
        const f = fixture(card(), undefined, 200, { hold: gate.promise, entered: () => entered.resolve() });
        const pending = f.render().submit({ preventDefault: vi.fn() });
        try {
            await entered.promise; await f.render().submit({ preventDefault: vi.fn() });
            expect(f.writes).toHaveLength(1); expect(f.render().isSaving).toBe(true);
            f.unmount(); gate.resolve(); await pending;
            expect(f.onSaved).not.toHaveBeenCalled(); expect(f.render().isSaving).toBe(true);
            expect(f.render().error).toBeNull(); expect(f.writes).toHaveLength(1);
        } finally { gate.resolve(); await pending; }
    });
});


describe('actual correction uncertain outcome and readback lifetime', () => {
    it('does not retry or adopt a guessed base after an issued correction returns502', async () => {
        const f = fixture(card(), undefined, 502); const before = f.render();
        await f.submit(); expect(f.writes).toHaveLength(1); expect(f.onSaved).not.toHaveBeenCalled();
        expect(f.render().requiresRefresh).toBe(true); expect(f.render().error).toContain('Cancel and refresh');
        expect(f.render().reason).toBe(before.reason); expect(f.render().clockOutAt).toBe(before.clockOutAt);
        await f.render().submit({ preventDefault: vi.fn() }); expect(f.writes).toHaveLength(1);
    });

    it('retains inputs accepted during acknowledged parent readback and permits a second explicit save with its verified CAS', async () => {
        const gate = deferred<void>(), entered = deferred<void>(), f = fixture(card()); let closeAllowed: boolean | undefined;
        f.onSaved.mockImplementationOnce(async (_ack, canClose) => {
            entered.resolve(); await gate.promise; closeAllowed = canClose();
        });
        const pending = f.render().submit({ preventDefault: vi.fn() });
        try {
            await entered.promise; expect(f.render().isSaving).toBe(true);
            f.render().updateReason('Draft accepted while authoritative history is loading');
            f.render().updateDateTime('clock-out', '2026-10-04T10:30', f.render().setClockOutAt);
            gate.resolve(); await pending;
            expect(closeAllowed).toBe(false); expect(f.render().isSaving).toBe(false);
            expect(f.render().reason).toBe('Draft accepted while authoritative history is loading');
            expect(f.render().clockOutAt).toBe('2026-10-04T10:30');
            await f.render().submit({ preventDefault: vi.fn() }); expect(f.writes).toHaveLength(2);
            expect(f.writes[1].payload).toMatchObject({ expectedUpdatedAt: f.onSaved.mock.calls[0][0].updatedAt,
                reason: 'Draft accepted while authoritative history is loading', clockOutAt: '2026-10-04T10:30:00.000Z' });
        } finally { gate.resolve(); await pending; }
    });
});
