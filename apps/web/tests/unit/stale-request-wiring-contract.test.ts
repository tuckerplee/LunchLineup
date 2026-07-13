import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('stale request wiring contract', () => {
    it('invalidates and clears time-card state before an employee replacement loads', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'app/dashboard/time-cards/TimeCardsWorkspace.tsx'),
            'utf8',
        );

        expect(source).toContain('cardsRequestGate.current.invalidate();');
        expect(source).toContain('setActiveCard(null);');
        expect(source).toContain('activeCardForSelectedUser');
        expect(source).toContain('disabled={isSaving || !hasCurrentCards}');
    });

    it('discards stale print loads and gates printing on the loaded scope', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'app/dashboard/scheduling/print/page.tsx'),
            'utf8',
        );

        expect(source).toContain('if (!scheduleRequestGate.current.isLatest(ticket)) return;');
        expect(source).toContain('setLoadedScope(null);');
        expect(source).toContain('isPrintScheduleScopeCurrent(loadedScope, selectedScope)');
        expect(source).toContain('disabled={isLoading || !isCurrentScope || rows.length === 0}');
    });
});
