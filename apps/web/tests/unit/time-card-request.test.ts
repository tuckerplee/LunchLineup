import { describe, expect, it } from 'vitest';
import {
    ClockInRequestKey,
    isClockInTargetExplicit,
    isTimeCardForEmployee,
    selectedTimeCardUserId,
    timeCardMutationLabel,
} from '../../app/dashboard/time-cards/time-card-request';

describe('time-card employee request scope', () => {
    it('only permits an active card owned by the selected employee', () => {
        expect(isTimeCardForEmployee({ userId: 'employee-a' }, 'employee-a')).toBe(true);
        expect(isTimeCardForEmployee({ userId: 'employee-a' }, 'employee-b')).toBe(false);
        expect(isTimeCardForEmployee(null, 'employee-a')).toBe(false);
    });

    it('keeps one clock-in key through retries and rotates after reset', () => {
        let sequence = 0;
        const keys = new ClockInRequestKey(() => 'request-' + (++sequence));

        expect(keys.current()).toBe('request-1');
        expect(keys.current()).toBe('request-1');
        keys.reset();
        expect(keys.current()).toBe('request-2');
    });

    it('fails closed until Team Time has an explicit person and location', () => {
        const target = {
            view: 'team' as const,
            currentUserId: 'current-user',
            selectedTeamUserId: '',
            selectedLocationId: '',
            canReadLocations: true,
        };

        expect(isClockInTargetExplicit(target)).toBe(false);
        expect(isClockInTargetExplicit({ ...target, selectedTeamUserId: 'jordan' })).toBe(false);
        expect(isClockInTargetExplicit({ ...target, selectedTeamUserId: 'jordan', selectedLocationId: 'downtown' })).toBe(true);
    });

    it('keeps My Time bound to the signed-in user and requires an available location to be chosen', () => {
        const target = {
            view: 'mine' as const,
            currentUserId: 'signed-in-user',
            selectedTeamUserId: 'someone-else',
            selectedLocationId: '',
            canReadLocations: true,
        };

        expect(selectedTimeCardUserId(target)).toBe('signed-in-user');
        expect(isClockInTargetExplicit(target)).toBe(false);
        expect(isClockInTargetExplicit({ ...target, selectedLocationId: 'downtown' })).toBe(true);
        expect(isClockInTargetExplicit({ ...target, canReadLocations: false })).toBe(true);
    });

    it('names both the person and location in mutation controls', () => {
        expect(timeCardMutationLabel('clock-in', 'Jordan', 'Downtown')).toBe('Clock in Jordan at Downtown');
        expect(timeCardMutationLabel('clock-out', 'Jordan', 'Downtown')).toBe('Clock out Jordan from Downtown');
    });
});
