import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';

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

function completionBindings(card = { id: 'card-a', updatedAt: 'version-1' }) {
    return {
        correctingCard: card,
        correctionGeneration: { current: 7 },
        renderedCorrectionGeneration: 7,
        selectedUserId: 'person-a',
        view: 'team',
        setError: vi.fn(),
        setNotice: vi.fn(),
        setCorrectingCard: vi.fn(),
        loadCards: vi.fn(async () => undefined),
    };
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
        expect(panelSource).toContain('expectedUpdatedAt: card.updatedAt');
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
        const saved = correctionCallback<() => Promise<void>>('TimeCardCorrectionPanel', 'onSaved', bindings);
        const correct = correctionCallback<(card: typeof bindings.correctingCard) => void>('TimeCardHistory', 'onCorrect', bindings);
        correct({ ...bindings.correctingCard });
        expect(bindings.correctionGeneration.current).toBe(7);
        expect(bindings.setCorrectingCard).not.toHaveBeenCalled();
        await saved();
        expect(bindings.setNotice).toHaveBeenCalledWith('Time card corrected.');
        expect(bindings.setCorrectingCard).toHaveBeenCalledWith(null);
        expect(bindings.loadCards).toHaveBeenCalledExactlyOnceWith('person-a', 'team');
    });

    it.each([{ id: 'card-b', updatedAt: 'version-1' }, { id: 'card-a', updatedAt: 'version-2' }])(
        'does not let an old completion clear or reload a different card/version: %j', async (nextCard) => {
            const bindings = completionBindings();
            const saved = correctionCallback<() => Promise<void>>('TimeCardCorrectionPanel', 'onSaved', bindings);
            correctionCallback<(card: typeof nextCard) => void>('TimeCardHistory', 'onCorrect', bindings)(nextCard);
            expect(bindings.correctionGeneration.current).toBe(8);
            expect(bindings.setCorrectingCard).toHaveBeenCalledExactlyOnceWith(nextCard);
            bindings.setNotice.mockClear();
            await saved();
            expect(bindings.setCorrectingCard).toHaveBeenCalledTimes(1);
            expect(bindings.setNotice).not.toHaveBeenCalled();
            expect(bindings.loadCards).not.toHaveBeenCalled();
        },
    );

    it('keeps a cancelled correction from publishing its late successful completion', async () => {
        const bindings = completionBindings();
        const saved = correctionCallback<() => Promise<void>>('TimeCardCorrectionPanel', 'onSaved', bindings);
        correctionCallback<() => void>('TimeCardCorrectionPanel', 'onCancel', bindings)();
        expect(bindings.correctionGeneration.current).toBe(8);
        expect(bindings.setCorrectingCard).toHaveBeenCalledExactlyOnceWith(null);
        await saved();
        expect(bindings.setCorrectingCard).toHaveBeenCalledTimes(1);
        expect(bindings.setNotice).not.toHaveBeenCalled();
        expect(bindings.loadCards).not.toHaveBeenCalled();
    });
});
