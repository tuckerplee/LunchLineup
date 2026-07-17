import {
    dateValueInTimeZone,
    localDateTimeToIso,
    safeTimeZone,
    timeValueInTimeZone,
} from '../../../lib/location-timezone';

export function formatTimeCardDuration(minutes: number): string {
    const safe = Math.max(0, Math.floor(minutes || 0));
    const hours = Math.floor(safe / 60);
    const mins = safe % 60;
    if (hours === 0) return `${mins}m`;
    return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

export function formatTimeCardTimestamp(value: string | Date | null | undefined, timeZoneValue: unknown): string {
    if (!value) return 'Open';
    const timeZone = safeTimeZone(timeZoneValue);
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
    }).format(value instanceof Date ? value : new Date(value));
}

export function timeCardInstantToLocalInput(value: string | Date, timeZoneValue: unknown): string {
    const timeZone = safeTimeZone(timeZoneValue);
    return `${dateValueInTimeZone(value, timeZone)}T${timeValueInTimeZone(value, timeZone)}`;
}

export function timeCardLocalInputCandidates(value: string, timeZoneValue: unknown): string[] {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
    if (!match) throw new Error('Date and time are required.');
    const timeZone = safeTimeZone(timeZoneValue);
    const baseline = new Date(localDateTimeToIso(match[1], match[2], timeZone));
    const candidates = new Set<string>();
    for (let deltaMinutes = -180; deltaMinutes <= 180; deltaMinutes += 30) {
        const candidate = new Date(baseline.getTime() + deltaMinutes * 60_000);
        if (timeCardInstantToLocalInput(candidate, timeZone) === value) {
            candidates.add(candidate.toISOString());
        }
    }
    return [...candidates].sort();
}
