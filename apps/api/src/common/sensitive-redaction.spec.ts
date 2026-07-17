import { describe, expect, it } from 'vitest';
import { redactSensitiveText, redactUrlForLog } from './sensitive-redaction';

describe('sensitive redaction', () => {
    it('removes representative bearer, field, URL credential, and query secrets', () => {
        const redacted = redactSensitiveText(
            'Authorization: Bearer access-secret DATABASE_URL=postgresql://user:db-secret@db/app?token=query-secret password=form-secret',
        );

        expect(redacted).not.toContain('access-secret');
        expect(redacted).not.toContain('db-secret');
        expect(redacted).not.toContain('query-secret');
        expect(redacted).not.toContain('form-secret');
        expect(redacted).toContain('[REDACTED]');
    });

    it('drops every query, fragment, and embedded credential from logged URLs', () => {
        expect(redactUrlForLog('https://user:password@example.com/private?next=/dashboard&token=secret#fragment'))
            .toBe('https://example.com/private');
        expect(redactUrlForLog('/callback?next=/dashboard&code=secret#fragment'))
            .toBe('/callback');
    });
});
