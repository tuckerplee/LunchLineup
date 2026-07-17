const SECRET_FIELD_RE = /\b([A-Z0-9_.-]*(?:AUTHORIZATION|COOKIE|DATABASE_URL|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN|API[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_.-]*\s*[:=]\s*)(["']?)[^"',\s;]+/gi;
const SECRET_QUERY_RE = /([?&][^=&#\s]*(?:code|key|password|secret|signature|state|token)[^=&#\s]*=)[^&#\s]+/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const URL_CREDENTIAL_RE = /\b((?:amqps?|postgres(?:ql)?|mysql|redis|https?):\/\/[^:\s/@]+:)[^@\s]+@/gi;

export function redactSensitiveText(value: unknown): string {
    return String(value ?? '')
        .replace(URL_CREDENTIAL_RE, '$1[REDACTED]@')
        .replace(BEARER_RE, '$1[REDACTED]')
        .replace(SECRET_QUERY_RE, '$1[REDACTED]')
        .replace(SECRET_FIELD_RE, '$1$2[REDACTED]');
}

export function redactUrlForLog(value: string): string {
    try {
        const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
        const parsed = new URL(value, 'http://redaction.invalid');
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return absolute ? parsed.toString() : parsed.pathname || '/';
    } catch {
        return redactSensitiveText(value.split(/[?#]/, 1)[0]);
    }
}
