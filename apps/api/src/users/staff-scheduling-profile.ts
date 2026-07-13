import { BadRequestException } from '@nestjs/common';

import { assertAvailabilityWindow } from '../schedules/schedule-availability';

export const MAX_STAFF_SKILLS = 50;
export const MAX_STAFF_AVAILABILITY_WINDOWS = 21;
const MAX_SKILL_LENGTH = 64;

export type StaffAvailabilityInput = {
    locationId?: string | null;
    dayOfWeek: number;
    startTimeMinutes: number;
    endTimeMinutes: number;
};

export type StaffSchedulingProfileInput = {
    skills: string[];
    availability: StaffAvailabilityInput[];
};

export type NormalizedStaffSchedulingProfile = {
    skills: string[];
    availability: Array<{
        locationId: string | null;
        dayOfWeek: number;
        startTimeMinutes: number;
        endTimeMinutes: number;
    }>;
};

function normalizeSkill(value: unknown): string {
    if (typeof value !== 'string') {
        throw new BadRequestException('skills must only contain strings');
    }
    const skill = value.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!skill || skill.length > MAX_SKILL_LENGTH) {
        throw new BadRequestException('Each skill must contain 1 to 64 characters');
    }
    return skill;
}

export function normalizeStaffSchedulingProfile(value: unknown): NormalizedStaffSchedulingProfile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException('Scheduling profile must be an object');
    }
    const input = value as Partial<StaffSchedulingProfileInput>;
    if (!Array.isArray(input.skills) || !Array.isArray(input.availability)) {
        throw new BadRequestException('skills and availability must be arrays');
    }
    if (input.skills.length > MAX_STAFF_SKILLS) {
        throw new BadRequestException(`skills cannot exceed ${MAX_STAFF_SKILLS} entries`);
    }
    if (input.availability.length > MAX_STAFF_AVAILABILITY_WINDOWS) {
        throw new BadRequestException(`availability cannot exceed ${MAX_STAFF_AVAILABILITY_WINDOWS} windows`);
    }

    const skills = Array.from(new Set(input.skills.map(normalizeSkill))).sort();
    const availability = input.availability.map((rawWindow, index) => {
        if (!rawWindow || typeof rawWindow !== 'object' || Array.isArray(rawWindow)) {
            throw new BadRequestException(`availability[${index}] must be an object`);
        }
        const window = rawWindow as StaffAvailabilityInput;
        assertAvailabilityWindow(window);
        if (window.locationId !== undefined && window.locationId !== null && typeof window.locationId !== 'string') {
            throw new BadRequestException(`availability[${index}].locationId must be a string or null`);
        }
        const locationId = typeof window.locationId === 'string' ? window.locationId.trim() : null;
        if (window.locationId && !locationId) {
            throw new BadRequestException(`availability[${index}].locationId cannot be empty`);
        }
        return {
            locationId: locationId || null,
            dayOfWeek: Number(window.dayOfWeek),
            startTimeMinutes: Number(window.startTimeMinutes),
            endTimeMinutes: Number(window.endTimeMinutes),
        };
    });

    const windowKeys = availability.map((window) => [
        window.locationId ?? '*',
        window.dayOfWeek,
        window.startTimeMinutes,
        window.endTimeMinutes,
    ].join(':'));
    if (new Set(windowKeys).size !== windowKeys.length) {
        throw new BadRequestException('availability contains duplicate windows');
    }

    availability.sort((left, right) => (
        left.dayOfWeek - right.dayOfWeek
        || left.startTimeMinutes - right.startTimeMinutes
        || left.endTimeMinutes - right.endTimeMinutes
        || (left.locationId ?? '').localeCompare(right.locationId ?? '')
    ));
    return { skills, availability };
}
