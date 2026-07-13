import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readOneTimeRecoveryCodes, recoveryCodesAsText } from '../../app/mfa/recovery-codes';

const pageSource = readFileSync(resolve(__dirname, '../../app/mfa/page.tsx'), 'utf8');

describe('MFA verification page', () => {
  it('submits MFA verification with the double-submit CSRF header', () => {
    expect(pageSource).toContain('csrf_token=');
    expect(pageSource).toContain("'x-csrf-token': csrfToken");
    expect(pageSource).toContain("credentials: 'include'");
    expect(pageSource).toContain('/auth/mfa/verify');
  });

  it('normalizes one-time recovery codes without persisting them', () => {
    const codes = readOneTimeRecoveryCodes({ data: { backupCodes: ['LL-4F8K-92HD', '', 123, 'LL-73QW-1PZM'] } });

    expect(codes).toEqual(['LL-4F8K-92HD', 'LL-73QW-1PZM']);
    expect(recoveryCodesAsText(codes)).toBe('LL-4F8K-92HD\nLL-73QW-1PZM');
    expect(pageSource).not.toContain('localStorage');
    expect(pageSource).not.toContain('sessionStorage');
  });

  it('requires acknowledgment after enrollment before redirecting', () => {
    expect(pageSource).toContain("setMode('recovery-codes')");
    expect(pageSource).toContain('disabled={!recoveryCodesAcknowledged}');
    expect(pageSource).toContain('I saved these recovery codes in a secure place.');
    expect(pageSource).toContain('navigator.clipboard.writeText');
    expect(pageSource).toContain('window.print()');
    expect(pageSource).toContain('setRecoveryCodes([])');
  });

  it('announces dynamic errors and offers privileged users support-backed factor recovery', () => {
    expect(pageSource).toContain('role="alert"');
    expect(pageSource).toContain('aria-live="assertive"');
    expect(pageSource).toContain('aria-atomic="true"');
    expect(pageSource).toContain('legalContacts.support');
    expect(pageSource).toContain('Lost every MFA factor?');
    expect(pageSource).toContain('Contact LunchLineup support');
  });});
