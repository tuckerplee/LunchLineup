export type SettingsSection = 'general' | 'team' | 'security';
export type SettingsSaveResult =
    | { kind: 'confirmed'; recovered: boolean }
    | { kind: 'rejected'; message: string }
    | { kind: 'uncertain'; message: string };

export function savedSettingsMatch(section: SettingsSection, submitted: Record<string, unknown>, saved: unknown): boolean {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;
    const values = (saved as Record<string, unknown>)[section];
    if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
    const record = values as Record<string, unknown>;
    return Object.keys(submitted).length > 0 && Object.entries(submitted).every(([key, value]) =>
        Object.hasOwn(record, key) && Object.is(record[key], value));
}

export async function reconcileSettingsSave(
    section: SettingsSection,
    submitted: Record<string, unknown>,
    read: () => Promise<unknown>,
): Promise<SettingsSaveResult> {
    try {
        if (savedSettingsMatch(section, submitted, await read())) return { kind: 'confirmed', recovered: true };
        return { kind: 'uncertain', message: 'The saved settings differ from your submitted changes. The save outcome is still unknown; your draft is retained. Check saved settings again before retrying.' };
    } catch {
        return { kind: 'uncertain', message: 'Unable to confirm whether the settings saved. Your draft is retained. Check saved settings before retrying.' };
    }
}

export async function saveSettingsWithReadback(
    section: SettingsSection,
    submitted: Record<string, unknown>,
    write: () => Promise<unknown>,
    read: () => Promise<unknown>,
): Promise<SettingsSaveResult> {
    try {
        if (savedSettingsMatch(section, submitted, await write())) return { kind: 'confirmed', recovered: false };
    } catch (error) {
        const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
        if (typeof status === 'number' && status >= 400 && status < 500 && ![408, 425].includes(status)) {
            return { kind: 'rejected', message: error instanceof Error ? error.message : `Request rejected (${status}).` };
        }
    }
    // A transport error or unreadable success body is not proof of rejection.
    // Only an independent read may confirm the currently saved values.
    return reconcileSettingsSave(section, submitted, read);
}
