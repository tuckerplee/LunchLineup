import { describe, expect, it } from 'vitest';
import { ProfileOperationOwner, profileMatchesDraft } from '../../app/dashboard/staff/profile-save-state';

describe('profile save ownership and readback', () => {
    it('rejects old success, error and completion after a newer save or editor switch', async () => {
        const owner = new ProfileOperationOwner();
        const first = owner.begin();
        const second = owner.begin();
        const updates: string[] = [];
        for (const phase of ['success', 'error', 'finally']) {
            await Promise.resolve();
            if (owner.owns(first)) updates.push(phase);
        }
        expect(updates).toEqual([]);
        expect(owner.owns(second)).toBe(true);
        owner.invalidate();
        expect(owner.owns(second)).toBe(false);
    });
    it('compares authoritative content independently of row ordering and rejects wrong dates/skills', () => {
        const draft = { skills: ['cashier', 'stock'], availability: [], availabilityExceptions: [
            { locationId: null, date: '2026-09-10', kind: 'UNAVAILABLE' as const, allDay: true, startTimeMinutes: 0, endTimeMinutes: 1440 },
        ] };
        const saved = { ...draft, skills: ['stock', 'cashier'], user: { id: 'employee', name: 'Employee' }, availabilityConfigured: false };
        expect(profileMatchesDraft(saved, draft)).toBe(true);
        expect(profileMatchesDraft({ ...saved, skills: ['cashier'] }, draft)).toBe(false);
        expect(profileMatchesDraft({ ...saved, availabilityExceptions: [{ ...draft.availabilityExceptions[0], date: '2026-09-11' }] }, draft)).toBe(false);
    });
});
