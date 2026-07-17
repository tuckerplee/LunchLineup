import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const timeCardsRoot = resolve(process.cwd(), 'app/dashboard/time-cards');

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
});
