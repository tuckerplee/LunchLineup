import type { TimeCardCorrectionRequest, TimeCardRecord } from '@lunchlineup/api-contract';
import type { TimeCard } from './time-card-types';

const uuid = (value: unknown): value is string => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const instant = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
    if (!match) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime())
        && date.toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
};
const record = (value: unknown): value is Record<string, unknown> => value !== null
    && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, min: number, max: number): value is string => typeof value === 'string'
    && value.length >= min && value.length <= max;
const minutes = (value: unknown): value is number => typeof value === 'number'
    && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;

// This validates the complete correction response consumed by this UI. It does
// not authorize a mutation or infer a version from the local clock or request.
export function correctionAcknowledgement(value: unknown, target: TimeCard,
    issued: TimeCardCorrectionRequest): TimeCardRecord {
    if (!record(value) || !uuid(value.id) || !uuid(value.userId)
        || !(value.locationId === null || uuid(value.locationId))
        || !(value.shiftId === null || uuid(value.shiftId))
        || !instant(value.clockInAt) || !(value.clockOutAt === null || instant(value.clockOutAt))
        || !minutes(value.breakMinutes) || !minutes(value.grossMinutes) || !minutes(value.workedMinutes)
        || !['OPEN', 'CLOSED', 'VOID'].includes(String(value.status))
        || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1
        || !(value.notes === null || text(value.notes, 0, 1000))
        || !instant(value.createdAt) || !instant(value.updatedAt) || !text(value.displayTimeZone, 1, 100)
        || !Array.isArray(value.breaks) || value.breaks.length > 24
        || !value.breaks.every(interval => record(interval) && uuid(interval.id)
            && instant(interval.startAt) && instant(interval.endAt))
        || !record(value.user) || !uuid(value.user.id) || !text(value.user.name, 1, 200)
        || !(value.user.username === null || text(value.user.username, 1, 128)) || !text(value.user.role, 1, 64)
        || !(value.location === null || (record(value.location) && uuid(value.location.id)
            && text(value.location.name, 1, 200) && text(value.location.timezone, 1, 100)))) {
        throw new Error('The correction response could not be verified. Cancel and refresh before saving again.');
    }
    const acknowledged = value as unknown as TimeCardRecord;
    const sameInstant = (a: string | null, b: string | null | undefined) => a === null ? b === null
        : typeof b === 'string' && new Date(a).getTime() === new Date(b).getTime();
    if (acknowledged.id !== target.id || acknowledged.userId !== target.userId
        || acknowledged.user.id !== target.userId
        || acknowledged.locationId !== (target.locationId ?? null)
        || (acknowledged.location !== null && acknowledged.location.id !== acknowledged.locationId)
        || acknowledged.displayTimeZone !== target.displayTimeZone
        || !sameInstant(acknowledged.clockInAt, issued.clockInAt)
        || !sameInstant(acknowledged.clockOutAt, issued.clockOutAt)
        || acknowledged.status !== (issued.clockOutAt === null ? 'OPEN' : 'CLOSED')
        || (issued.breakIntervals !== undefined && (acknowledged.breaks.length !== issued.breakIntervals.length
            || acknowledged.breaks.some((interval, index) => !sameInstant(interval.startAt, issued.breakIntervals![index].startAt)
                || !sameInstant(interval.endAt, issued.breakIntervals![index].endAt))))) {
        throw new Error('The correction response did not match the submitted card. Cancel and refresh before saving again.');
    }
    return acknowledged;
}
