/** Shared cookie policy for both API generations and every cookie writer. */
export function resolveCookieSecure(value: string | undefined, nodeEnvironment: string | undefined): boolean {
    if (value === undefined) return nodeEnvironment === 'production';
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        if (nodeEnvironment === 'production') {
            throw new Error('COOKIE_SECURE cannot be false in production.');
        }
        return false;
    }
    throw new Error('COOKIE_SECURE must be a boolean value.');
}
