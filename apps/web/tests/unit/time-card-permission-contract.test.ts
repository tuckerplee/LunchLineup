import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const timeCardsRoot = resolve(process.cwd(), 'app/dashboard/time-cards');

describe('time-card workspace permission contract', () => {
  it('loads optional catalogs only when their API permissions are present', () => {
    const pageSource = readFileSync(resolve(timeCardsRoot, 'page.tsx'), 'utf8');
    const workspaceSource = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');
    const apiSource = readFileSync(resolve(timeCardsRoot, 'time-card-api.ts'), 'utf8');

    expect(pageSource).toContain("canManageTeam={canPermission(user, 'users:read') && canPermission(user, 'shifts:read')}");
    expect(pageSource).toContain("canReadLocations={canPermission(user, 'locations:read')}");
    expect(workspaceSource).toContain('canReadLocations ? fetchLocationPage() : Promise.resolve(null)');
    expect(apiSource).toContain("new URLSearchParams({ limit: String(LOCATION_PAGE_SIZE) })");
    expect(workspaceSource).toContain('{canReadLocations ? <label');
  });

  it('preserves clock-out recovery when entitled history and new clock-ins are unavailable', () => {
    const workspaceSource = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');
    const apiSource = readFileSync(resolve(timeCardsRoot, 'time-card-api.ts'), 'utf8');

    expect(apiSource).toContain("if (!activeResponse.ok) throw new Error('Unable to load active time card.');");
    expect(workspaceSource).toContain('setCanStartNewTimeCard(snapshot.historyResponse.ok);');
    expect(workspaceSource).toContain('You can still clock out an open card.');
    expect(workspaceSource).toContain('const canClockIn = clockInTargetIsExplicit && hasCurrentCards && canStartNewTimeCard;');
    expect(workspaceSource).toContain('const canClockOut = Boolean(activeCardForSelectedUser && hasCurrentCards && teamClockOutTargetIsExplicit);');
    expect(workspaceSource).toContain('disabled={isSaving || !canClockIn}');
    expect(workspaceSource).toContain('disabled={isSaving || !canClockOut}');
  });

  it('separates My Time from explicit Team Time targeting without first-row defaults', () => {
    const workspaceSource = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');

    expect(workspaceSource).toContain("const [view, setView] = useState<TimeCardView>('mine');");
    expect(workspaceSource).toContain("const [selectedTeamUserId, setSelectedTeamUserId] = useState('');");
    expect(workspaceSource).toContain("const [selectedLocationId, setSelectedLocationId] = useState('');");
    expect(workspaceSource).not.toContain('nextStaff[0]');
    expect(workspaceSource).not.toContain('nextLocations[0]');
    expect(workspaceSource).toContain('Team Time selected person');
    expect(workspaceSource).toContain("...(isTeamTime ? { userId: selectedUserId } : {}),");
    expect(workspaceSource).toContain('Boolean(canReadLocations && selectedLocationId && activeLocationId && selectedLocationId === activeLocationId)');
  });

  it('clears person and location drafts before a different target can write', () => {
    const workspaceSource = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');

    expect(workspaceSource).toContain('const resetPersonDraft = useCallback(() => {');
    expect(workspaceSource).toContain("setBreakMinutes('30');");
    expect(workspaceSource).toContain("setNotes('');");
    expect(workspaceSource).toContain('setCorrectingCard(null);');
    expect(workspaceSource).toContain('resetPersonDraft();');
    expect(workspaceSource).toContain('onChange={(event) => selectLocation(event.target.value)}');
  });

  it('does not present operational time cards as payroll-final records', () => {
    const workspaceSource = readFileSync(resolve(timeCardsRoot, 'TimeCardsWorkspace.tsx'), 'utf8');

    expect(workspaceSource).toContain('Operational time records only.');
    expect(workspaceSource).toContain('payroll system remains the source of truth');
  });
});
