import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
    MAX_STAFF_AVAILABILITY_WINDOWS,
    MAX_STAFF_SKILLS,
    normalizeStaffSchedulingProfile,
} from './staff-scheduling-profile';

describe('staff scheduling profile validation', () => {
    it('normalizes and deduplicates skills while preserving overnight and location-scoped windows', () => {
        expect(normalizeStaffSchedulingProfile({
            skills: ['  Grill  Cook ', 'grill cook', 'EXPO'],
            availability: [{
                locationId: ' loc-1 ',
                dayOfWeek: 1,
                startTimeMinutes: 1320,
                endTimeMinutes: 120,
            }],
        })).toEqual({
            skills: ['expo', 'grill cook'],
            availability: [{
                locationId: 'loc-1',
                dayOfWeek: 1,
                startTimeMinutes: 1320,
                endTimeMinutes: 120,
            }],
        });
    });

    it('accepts an explicit empty availability profile', () => {
        expect(normalizeStaffSchedulingProfile({ skills: [], availability: [] })).toEqual({
            skills: [],
            availability: [],
        });
    });

    it.each([
        [{ skills: Array(MAX_STAFF_SKILLS + 1).fill('line'), availability: [] }, `skills cannot exceed ${MAX_STAFF_SKILLS}`],
        [{ skills: [], availability: Array(MAX_STAFF_AVAILABILITY_WINDOWS + 1).fill({ dayOfWeek: 1, startTimeMinutes: 60, endTimeMinutes: 120 }) }, `availability cannot exceed ${MAX_STAFF_AVAILABILITY_WINDOWS}`],
        [{ skills: [''], availability: [] }, 'Each skill must contain 1 to 64 characters'],
        [{ skills: [], availability: [{ dayOfWeek: 7, startTimeMinutes: 60, endTimeMinutes: 120 }] }, 'Invalid availability dayOfWeek'],
        [{ skills: [], availability: [{ dayOfWeek: 1, startTimeMinutes: 60, endTimeMinutes: 60 }] }, 'Invalid availability window'],
        [{ skills: [], availability: [
            { dayOfWeek: 1, startTimeMinutes: 60, endTimeMinutes: 120 },
            { dayOfWeek: 1, startTimeMinutes: 60, endTimeMinutes: 120 },
        ] }, 'availability contains duplicate windows'],
    ])('rejects invalid input %#', (value, message) => {
        expect(() => normalizeStaffSchedulingProfile(value)).toThrow(message);
        expect(() => normalizeStaffSchedulingProfile(value)).toThrow(BadRequestException);
    });
});
