const SENSITIVE_QUERY_KEY = /(?:code|csrf|key|password|secret|session|signature|token)/i;
const UNSAFE_VALUE = /(?:\b(?:bearer|basic)\s+|https?:\/\/|file:\/\/|\\\\|\r|\n|\0|localhost|127\.0\.0\.1|\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\.internal\b)/i;

export function safeSameOriginReturnPath(pathname: string, search = ''): string {
  if (
    !pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('\\')
    || /[\r\n\0]/.test(pathname)
  ) {
    return '/dashboard';
  }

  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const [key, value] of Array.from(params.entries())) {
    if (SENSITIVE_QUERY_KEY.test(key) || UNSAFE_VALUE.test(value)) {
      params.delete(key);
    }
  }
  params.delete('__auth_debug');

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function safeInternalNavigationPath(
  value: string | null | undefined,
  fallback = '/dashboard',
): string {
  const safeFallback = safeSameOriginReturnPath(fallback);
  if (!value || value.includes('\\') || /[\r\n\0]/.test(value)) return safeFallback;

  try {
    const base = new URL('https://app.invalid');
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return safeFallback;
    return safeSameOriginReturnPath(parsed.pathname, parsed.search);
  } catch {
    return safeFallback;
  }
}

export function parseApprovedAppOrigin(value: string | undefined, requireHttps: boolean): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || (requireHttps && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}
