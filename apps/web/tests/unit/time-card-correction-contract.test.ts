import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import type { TimeCard } from '../../app/dashboard/time-cards/time-card-types';

const timeCardsRoot = resolve(process.cwd(), 'app/dashboard/time-cards');

// Evaluate only the actual UI callback with in-memory closure bindings. This does
// not mount React or qualify effect/unmount/transport timing.
function correctionCallback<T>(tag: string, property: string, bindings: Record<string, unknown>): T {
    const source = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');
    const file = ts.createSourceFile('TimeCardsWorkspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const expressions: ts.Expression[] = [];
    function visit(node: ts.Node) {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === tag) {
            for (const attribute of node.attributes.properties) {
                if (ts.isJsxAttribute(attribute) && attribute.name.getText(file) === property
                    && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
                    expressions.push(attribute.initializer.expression);
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(file);
    expect(expressions).toHaveLength(1);
    const javascript = ts.transpileModule(`const callback = ${expressions[0].getText(file)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function(...Object.keys(bindings), `${javascript}
return callback;`)(...Object.values(bindings)) as T;
}

type Saved = (acknowledged: TimeCard, canClose: () => boolean) => Promise<void>;
function completionBindings(card: TimeCard = { id: 'card-a', userId: 'person-a', updatedAt: 'version-1',
    clockInAt: '2026-10-04T09:00:00.000Z', clockOutAt: '2026-10-04T10:00:00.000Z',
    breakMinutes: 0, grossMinutes: 60, workedMinutes: 60, status: 'CLOSED', displayTimeZone: 'UTC' }) {
    const state = { notice: null as string | null, cards: [card], activeCard: null as TimeCard | null,
        correctingCard: card as TimeCard | null };
    const queue: Array<() => void> = [];
    function setter<K extends keyof typeof state>(key: K) {
        return vi.fn((next: (typeof state)[K] | ((current: (typeof state)[K]) => (typeof state)[K])) => {
            queue.push(() => { state[key] = typeof next === 'function'
                ? (next as (current: (typeof state)[K]) => (typeof state)[K])(state[key]) : next; });
        });
    }
    return { correctingCard: card, state, flush: () => { while (queue.length) queue.shift()!(); },
        correctionGeneration: { current: 7 }, renderedCorrectionGeneration: 7,
        selectedUserId: card.userId, view: 'team', setError: vi.fn(),
        setNotice: setter('notice'), setCards: setter('cards'), setActiveCard: setter('activeCard'),
        setCorrectingCard: setter('correctingCard'), loadCards: vi.fn(async (): Promise<TimeCard[] | undefined> => state.cards) };
}

describe('time-card correction UI contract', () => {
    it('exposes corrections only to team managers with time-card write access', () => {
        const workspaceSource = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');
        const historySource = readFileSync(resolve(timeCardsRoot, 'TimeCardHistory.tsx'), 'utf8');

        expect(historySource).toContain('const canCorrect = canManageTeam && canWriteTimeCards;');
        expect(workspaceSource).toContain('setCorrectingCard(card);');
        expect(workspaceSource).toContain('<TimeCardCorrectionPanel');
    });

    it('submits optimistic, reasoned punch and break corrections to the dedicated endpoint', () => {
        const panelSource = readFileSync(resolve(timeCardsRoot, 'TimeCardCorrectionPanel.tsx'), 'utf8');

        expect(panelSource).toContain("'/time-cards/' + card.id + '/correction'");
        expect(panelSource).toContain("jsonWriteInit('PATCH', payload)");
        expect(panelSource).toContain('expectedUpdatedAt: acknowledgedCard.current.updatedAt');
        expect(panelSource).toContain('breakIntervals: breaks.map');
        expect(panelSource).toContain('Correction reason');
        expect(panelSource).toContain('minLength={5}');
    });

    it('requires explicit disambiguation for repeated location-local DST times', () => {
        const panelSource = readFileSync(resolve(timeCardsRoot, 'TimeCardCorrectionPanel.tsx'), 'utf8');

        expect(panelSource).toContain('Repeated time occurrence');
        expect(panelSource).toContain('occurs twice because of daylight saving time');
        expect(panelSource).toContain('card.displayTimeZone');
    });

    it('preserves a pending completion when Correct repeats the same card/version', async () => {
        const bindings = completionBindings();
        const saved = correctionCallback<Saved>('TimeCardCorrectionPanel', 'onSaved', bindings);
        const correct = correctionCallback<(card: typeof bindings.correctingCard) => void>('TimeCardHistory', 'onCorrect', bindings);
        correct({ ...bindings.correctingCard });
        expect(bindings.correctionGeneration.current).toBe(7);
        expect(bindings.setCorrectingCard).not.toHaveBeenCalled();
        const acknowledged = { ...bindings.correctingCard, updatedAt: 'version-2' };
        await saved(acknowledged, () => true); bindings.flush();
        expect(bindings.state.notice).toBe('Time card corrected.');
        expect(bindings.state.correctingCard).toBeNull();
        expect(bindings.loadCards).toHaveBeenCalledExactlyOnceWith('person-a', 'team', 7);
        expect(bindings.setCorrectingCard).toHaveBeenCalledOnce();
    });

    it.each([{ id: 'card-b', updatedAt: 'version-1' }, { id: 'card-a', updatedAt: 'version-2' }])(
        'does not let an old completion clear or reload a different card/version: %j', async (nextCard) => {
            const bindings = completionBindings();
            const saved = correctionCallback<Saved>('TimeCardCorrectionPanel', 'onSaved', bindings);
            const replacement = { ...bindings.correctingCard, ...nextCard };
            correctionCallback<(card: TimeCard) => void>('TimeCardHistory', 'onCorrect', bindings)(replacement);
            expect(bindings.correctionGeneration.current).toBe(8);
            expect(bindings.setCorrectingCard).toHaveBeenCalledExactlyOnceWith(replacement);
            bindings.setNotice.mockClear();
            await saved({ ...bindings.correctingCard, updatedAt: 'old-ack' }, () => true); bindings.flush();
            expect(bindings.state.correctingCard).toEqual(replacement);
            expect(bindings.setCorrectingCard).toHaveBeenCalledTimes(1);
            expect(bindings.setNotice).not.toHaveBeenCalled();
            expect(bindings.loadCards).not.toHaveBeenCalled();
        },
    );

    it('keeps a cancelled correction from publishing its late successful completion', async () => {
        const bindings = completionBindings();
        const saved = correctionCallback<Saved>('TimeCardCorrectionPanel', 'onSaved', bindings);
        correctionCallback<() => void>('TimeCardCorrectionPanel', 'onCancel', bindings)();
        expect(bindings.correctionGeneration.current).toBe(8);
        expect(bindings.setCorrectingCard).toHaveBeenCalledExactlyOnceWith(null);
        await saved({ ...bindings.correctingCard, updatedAt: 'old-ack' }, () => true); bindings.flush();
        expect(bindings.state.correctingCard).toBeNull();
        expect(bindings.setCorrectingCard).toHaveBeenCalledTimes(1);
        expect(bindings.setNotice).not.toHaveBeenCalled();
        expect(bindings.loadCards).not.toHaveBeenCalled();
    });
});


// The actual JSX callback enqueues its own functional setters. Flushing later
// models their deferred evaluation; it does not claim mounted React timing.
describe('correction acknowledgement queued publication custody', () => {
    it('preserves a newer draft accepted before queued editor cleanup commits after acknowledged readback', async () => {
        const bindings = completionBindings(), revision = { current: 4 };
        const saved = correctionCallback<Saved>('TimeCardCorrectionPanel', 'onSaved', bindings);
        const acknowledged = { ...bindings.correctingCard, updatedAt: 'version-2' };
        await saved(acknowledged, () => revision.current === 4);
        expect(bindings.state.correctingCard).toBe(bindings.correctingCard);
        revision.current += 1; bindings.flush();
        expect(bindings.state.correctingCard).toBe(bindings.correctingCard);
        expect(bindings.state.notice).toBe('Time card corrected.');
        expect(bindings.loadCards).toHaveBeenCalledExactlyOnceWith('person-a', 'team', 7);
    });

    it('refuses all queued publication after a newer owner generation replaces the editor', async () => {
        const bindings = completionBindings();
        const saved = correctionCallback<Saved>('TimeCardCorrectionPanel', 'onSaved', bindings);
        await saved({ ...bindings.correctingCard, updatedAt: 'version-2' }, () => true);
        const replacement = { ...bindings.correctingCard, id: 'card-b' };
        correctionCallback<(card: TimeCard) => void>('TimeCardHistory', 'onCorrect', bindings)(replacement);
        bindings.flush();
        expect(bindings.state.cards).toEqual([bindings.correctingCard]); expect(bindings.state.correctingCard).toEqual(replacement);
        expect(bindings.state.notice).toBeNull(); expect(bindings.loadCards).toHaveBeenCalledExactlyOnceWith('person-a', 'team', 7);
    });

    it('keeps the editor open when acknowledged history readback is unavailable', async () => {
        const bindings = completionBindings(); bindings.loadCards.mockResolvedValueOnce(undefined);
        await correctionCallback<Saved>('TimeCardCorrectionPanel', 'onSaved', bindings)(
            { ...bindings.correctingCard, updatedAt: 'version-2' }, () => true);
        bindings.flush();
        expect(bindings.state.correctingCard).toBe(bindings.correctingCard);
        expect(bindings.state.notice).toBe('Time card corrected.'); expect(bindings.setCorrectingCard).not.toHaveBeenCalled();
        expect(bindings.loadCards).toHaveBeenCalledExactlyOnceWith('person-a', 'team', 7);
    });

});
