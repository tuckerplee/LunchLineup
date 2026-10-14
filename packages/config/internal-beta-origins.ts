/**
 * Exact origins on which the internal-beta scheduling entitlement may be
 * enabled. Shared by apps/api and apps/api-v2 so the bindings cannot drift.
 * Production origins (lunchlineup.com, www.lunchlineup.com) must never appear here.
 */
export const INTERNAL_BETA_ORIGINS: readonly string[] = Object.freeze([
  'https://beta.lunchlineup.com',
  'https://dev.lunchlineup.com',
]);

/** True only for an exact allowlisted origin: https, no path/query/hash/userinfo. */
export function isInternalBetaOrigin(value: string | undefined | null): boolean {
  try {
    const url = new URL(value ?? '');
    return INTERNAL_BETA_ORIGINS.includes(url.origin)
      && url.pathname === '/'
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function isInternalBetaHostname(hostname: string): boolean {
  return INTERNAL_BETA_ORIGINS.some((origin) => new URL(origin).hostname === hostname);
}
