const SECRET_FIELD_RE = /\b([A-Z0-9_.-]*(?:AUTHORIZATION|COOKIE|DATABASE_URL|PASSWORD|PASSWD|SECRET|SIGNATURE|TOKEN|API[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_.-]*\s*[:=]\s*)(["']?)[^"',\s;]+/gi;
const SECRET_QUERY_RE = /([?&][^=&#\s]*(?:code|key|password|secret|signature|state|token)[^=&#\s]*=)[^&#\s]+/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const URL_CREDENTIAL_RE = /\b((?:amqps?|postgres(?:ql)?|mysql|redis|https?):\/\/[^:\s/@]+:)[^@\s]+@/gi;

const SENSITIVE_QUERY_KEYS = /(?:code|key|password|secret|signature|state|token)/i;

export function redactSensitiveText(value: unknown): string {
    return String(value ?? '')
        .replace(URL_CREDENTIAL_RE, '$1[REDACTED]@')
        .replace(BEARER_RE, '$1[REDACTED]')
        .replace(SECRET_QUERY_RE, '$1[REDACTED]')
        .replace(SECRET_FIELD_RE, '$1$2[REDACTED]');
}

export function redactUrlForLog(value: string): string {
    try {
        const parsed = new URL(value);
        if (parsed.username) parsed.username = 'redacted';
        if (parsed.password) parsed.password = 'redacted';

        for (const key of Array.from(parsed.searchParams.keys())) {
            if (SENSITIVE_QUERY_KEYS.test(key)) {
                parsed.searchParams.set(key, '[REDACTED]');
            }
        }

        return parsed.toString();
    } catch {
        return redactSensitiveText(value);
    }
}
