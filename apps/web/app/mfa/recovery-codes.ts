function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function readOneTimeRecoveryCodes(payload: unknown): string[] {
    const root = asRecord(payload);
    const source = asRecord(root?.data) ?? asRecord(root?.result) ?? root;
    if (!source) return [];

    for (const key of ['recoveryCodes', 'backupCodes', 'codes']) {
        const value = source[key];
        if (Array.isArray(value)) {
            return value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
        }
    }
    return [];
}

export function recoveryCodesAsText(codes: string[]): string {
    return codes.join('\n');
}
