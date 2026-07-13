import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const timeCardsRoot = resolve(process.cwd(), 'app/dashboard/time-cards');

describe('time-card workspace permission contract', () => {
  it('loads optional catalogs only when their API permissions are present', () => {
    const pageSource = readFileSync(resolve(timeCardsRoot, 'page.tsx'), 'utf8');
    const workspaceSource = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');

    expect(pageSource).toContain("canManageTeam={canPermission(user, 'users:read') && canPermission(user, 'shifts:read')}");
    expect(pageSource).toContain("canReadLocations={canPermission(user, 'locations:read')}");
    expect(workspaceSource).toContain("canReadLocations ? fetchWithSession('/locations') : Promise.resolve(null)");
    expect(workspaceSource).toContain('{canReadLocations ? <label');
  });

  it('preserves clock-out recovery when entitled history and new clock-ins are unavailable', () => {
    const workspaceSource = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');

    expect(workspaceSource).toContain("if (!activeRes.ok) throw new Error('Unable to load active time card.');");
    expect(workspaceSource).toContain('setCanStartNewTimeCard(cardsRes.ok);');
    expect(workspaceSource).toContain('You can still clock out an open card.');
    expect(workspaceSource).toContain('disabled={isSaving || !hasCurrentCards || !canStartNewTimeCard}');
    expect(workspaceSource).toContain('disabled={isSaving || !hasCurrentCards}');
  });
});
