const COMMON_IANA_TIME_ZONES = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
    'America/Puerto_Rico',
    'UTC',
] as const;

let cachedIanaTimeZoneOptions: string[] | null = null;

export type LocationFormValues = {
    name: string;
    address: string;
    timezone: string;
};

type PersistedLocationFormValues = {
    name: string;
    address?: string | null;
    timezone?: string | null;
};

export type LocationCreatePayload = {
    name: string;
    address?: string;
    timezone: string;
};

export type LocationUpdatePayload = {
    name: string;
    address: string | null;
    timezone: string;
};

export function normalizeValidIanaTimeZone(value: unknown): string | null {
    const timezone = typeof value === 'string' ? value.trim() : '';
    if (!timezone) return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
        return timezone;
    } catch {
        return null;
    }
}

export function resolveBrowserIanaTimeZone(
    resolveTimeZone: () => unknown = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
    try {
        return normalizeValidIanaTimeZone(resolveTimeZone()) ?? '';
    } catch {
        return '';
    }
}

export function getIanaTimeZoneOptions(additional: readonly unknown[] = []): string[] {
    if (cachedIanaTimeZoneOptions === null) {
        let supported: string[] = [];
        try {
            supported = typeof Intl.supportedValuesOf === 'function'
                ? Intl.supportedValuesOf('timeZone')
                : [];
        } catch {
            supported = [];
        }

        cachedIanaTimeZoneOptions = [...new Set([...COMMON_IANA_TIME_ZONES, ...supported])];
    }

    const options = [...cachedIanaTimeZoneOptions];
    const seen = new Set(options);
    for (const candidate of additional) {
        const timezone = normalizeValidIanaTimeZone(candidate);
        if (timezone && !seen.has(timezone)) {
            seen.add(timezone);
            options.push(timezone);
        }
    }
    return options;
}

export function persistedLocationFormValues(location: PersistedLocationFormValues): LocationFormValues {
    return {
        name: location.name,
        address: location.address ?? '',
        timezone: normalizeValidIanaTimeZone(location.timezone) ?? '',
    };
}

export function buildLocationCreatePayload(values: LocationFormValues): LocationCreatePayload {
    const name = requiredName(values.name);
    const address = values.address.trim();
    const timezone = requiredTimeZone(values.timezone);
    return {
        name,
        ...(address ? { address } : {}),
        timezone,
    };
}

export function buildLocationUpdatePayload(values: LocationFormValues): LocationUpdatePayload {
    return {
        name: requiredName(values.name),
        address: values.address.trim() || null,
        timezone: requiredTimeZone(values.timezone),
    };
}

function requiredName(value: string): string {
    const name = value.trim();
    if (!name) throw new Error('Location name is required.');
    return name;
}

function requiredTimeZone(value: string): string {
    if (!value.trim()) throw new Error('Location timezone is required.');
    const timezone = normalizeValidIanaTimeZone(value);
    if (!timezone) throw new Error('Select a valid IANA timezone.');
    return timezone;
}
