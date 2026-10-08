import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, changeEvent, clientComponentHarness, deferred, input, text } from './client-component-harness';

const mocks = vi.hoisted(() => ({ hooks: null as any, fetch: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => mocks.hooks.useState(...args), useEffect: (...args: any[]) => mocks.hooks.useEffect(...args),
  useCallback: (...args: any[]) => mocks.hooks.useCallback(...args), useMemo: (...args: any[]) => mocks.hooks.useMemo(...args),
}));
vi.mock('@/lib/client-api', () => ({ fetchWithSession: mocks.fetch }));
import { MfaEnrollmentPanel } from '../../app/dashboard/settings/MfaEnrollmentPanel';

import {
  normalizeMfaEnrollmentState,
  normalizeMfaSetupChallenge,
  readRecoveryCodes,
} from '../../app/dashboard/settings/mfa-enrollment-contract';

describe('MFA enrollment contract normalizers', () => {
  it('keeps the unavailable state customer-facing and actionable', () => {
    const panelSource = readFileSync(fileURLToPath(new URL(
      '../../app/dashboard/settings/MfaEnrollmentPanel.tsx',
      import.meta.url,
    )), 'utf8');

    expect(panelSource).toContain('MFA enrollment unavailable');
    expect(panelSource).toContain('MFA enrollment is temporarily unavailable');
    expect(panelSource).toContain('contact your workspace administrator if the issue continues');
    expect(panelSource).not.toContain('MFA enrollment API is not available yet');
    expect(panelSource).not.toContain('Implement GET, POST, PUT, and DELETE');
  });

  it('normalizes enrollment status payload variants', () => {
    expect(normalizeMfaEnrollmentState({
      data: {
        mfaEnabled: 'true',
        enabledAt: '2026-07-09T12:00:00.000Z',
        backupCodeCount: '3',
      },
    })).toEqual({
      enabled: true,
      verifiedAt: '2026-07-09T12:00:00.000Z',
      recoveryCodesRemaining: 3,
      setup: null,
    });
  });

  it('normalizes setup challenge payload variants', () => {
    expect(normalizeMfaSetupChallenge({
      setup: {
        id: 'setup-1',
        secret: 'JBSWY3DPEHPK3PXP',
        qrCodeUrl: 'data:image/svg+xml,mock',
        otpauthUri: 'otpauth://totp/LunchLineup:e2e.admin',
        label: 'e2e.admin',
      },
    })).toMatchObject({
      enrollmentId: 'setup-1',
      manualEntryKey: 'JBSWY3DPEHPK3PXP',
      qrCodeDataUrl: 'data:image/svg+xml,mock',
      otpauthUrl: 'otpauth://totp/LunchLineup:e2e.admin',
      accountLabel: 'e2e.admin',
    });
  });

  it('reads recovery codes from backend response aliases', () => {
    expect(readRecoveryCodes({
      data: {
        backupCodes: ['LL-4F8K-92HD', '', 123, 'LL-73QW-1PZM'],
      },
    })).toEqual(['LL-4F8K-92HD', 'LL-73QW-1PZM']);
  });
});

let h: ReturnType<typeof clientComponentHarness>;
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const setupPayload = { secret: 'BASE32SECRET', otpauthUrl: 'otpauth://totp/LunchLineup:worker', expiresInSeconds: 600 };
async function mount(enabled = false, ...responsePayload: [unknown?]) {
  const payload = responsePayload.length > 0 ? responsePayload[0] : { enabled, recoveryCodesRemaining: enabled ? 5 : 0 };
  mocks.fetch.mockResolvedValueOnce(json(payload));
  h = clientComponentHarness(() => MfaEnrollmentPanel({ tenantMfaRequired: false })); mocks.hooks = h.hooks;
  h.render(); h.flushEffects();
  await h.until(tree => button(tree, 'Refresh').props.disabled === false);
}
async function start() {
  mocks.fetch.mockResolvedValueOnce(json(setupPayload));
  await button(h.render(), 'Start MFA setup').props.onClick();
  await h.until(tree => button(tree, 'Refresh').props.disabled === false);
}
beforeEach(() => { mocks.fetch.mockReset(); });
afterEach(() => { h?.unmount(); });

describe('actual MFA settings panel action handlers', () => {
  it.each([{}, null, undefined, [], { enabled: 'false', recoveryCodesRemaining: 0 }, { enabled: false, recoveryCodesRemaining: -1 }].map(payload => [payload]))(
    'keeps malformed read %j unknown instead of reporting not enrolled', async payload => {
      await mount(false, payload);
      expect(text(h.render())).toContain('Status unavailable');
      expect(text(h.render())).not.toContain('Not enrolled');
      expect(button(h.render(), 'Start MFA setup').props.disabled).toBe(true);
      expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/auth/mfa/enrollment', {});
    });

  it.each([{}, null, { success: false }, { secret: 'BASE32SECRET', otpauthUrl: 'https://wrong.invalid', expiresInSeconds: 600 }])(
    'does not show successful setup or an empty challenge for malformed start %j', async payload => {
      await mount(); mocks.fetch.mockResolvedValueOnce(json(payload));
      button(h.render(), 'Start MFA setup').props.onClick();
      await h.until(tree => button(tree, 'Refresh').props.disabled === false);
      expect(text(h.render())).toContain('invalid MFA response');
      expect(text(h.render())).not.toContain('MFA setup started.');
      expect(text(h.render())).not.toContain('Manual setup key');
      expect(button(h.render(), 'Start MFA setup').props.disabled).toBe(false);
    });

  it.each([{}, null, { success: false, mfaVerified: true, backupCodes: ['SAFE-CODE'] },
    { success: true, mfaVerified: false, backupCodes: ['SAFE-CODE'] }, { success: true, mfaVerified: true, backupCodes: [] }])(
    'keeps setup and code input on malformed confirmation %j without claiming enabled', async payload => {
      await mount(); await start(); input(h.render(), 'Authenticator code').props.onChange(changeEvent('123456'));
      mocks.fetch.mockResolvedValueOnce(json(payload)); button(h.render(), 'Verify and enable').props.onClick();
      await h.until(tree => button(tree, 'Refresh').props.disabled === false);
      expect(text(h.render())).not.toContain('MFA is enabled.');
      expect(text(h.render())).toContain('Not enrolled');
      expect(input(h.render(), 'Authenticator code').props.value).toBe('123456');
      expect(input(h.render(), 'Manual setup key').props.value).toBe('BASE32SECRET');
    });

  it.each([{}, null, { success: false, mfaEnabled: false }, { success: true, mfaEnabled: true }])(
    'preserves enabled status and proof input on malformed disable %j', async payload => {
      await mount(true); input(h.render(), 'Authenticator or backup code').props.onChange(changeEvent('BACKUP-CODE'));
      mocks.fetch.mockResolvedValueOnce(json(payload)); button(h.render(), 'Disable MFA').props.onClick();
      await h.until(tree => button(tree, 'Refresh').props.disabled === false);
      expect(text(h.render())).toContain('Enabled');
      expect(text(h.render())).not.toContain('MFA is disabled.');
      expect(input(h.render(), 'Authenticator or backup code').props.value).toBe('BACKUP-CODE');
    });

  it('uses the actual flat owner setup and confirmation profiles and waits before displaying completion', async () => {
    await mount(); await start(); input(h.render(), 'Authenticator code').props.onChange(changeEvent(' 123 456 '));
    const response = deferred<Response>(); mocks.fetch.mockReturnValueOnce(response.promise);
    button(h.render(), 'Verify and enable').props.onClick();
    try {
        expect(text(h.render())).not.toContain('MFA is enabled.');
        expect(button(h.render(), 'Verify and enable').props.disabled).toBe(true);
        response.resolve(json({ success: true, mfaVerified: true, backupCodes: ['ONE-TIME-CODE'] }));
        await h.until(tree => button(tree, 'Refresh').props.disabled === false);
        expect(text(h.render())).toContain('MFA is enabled.'); expect(text(h.render())).toContain('ONE-TIME-CODE');
        expect(text(h.render())).toContain('1 recovery code remaining');
        expect(mocks.fetch.mock.calls.map(call => [call[0], call[1]?.method ?? 'GET'])).toEqual([
          ['/auth/mfa/enrollment', 'GET'], ['/auth/mfa/enrollment', 'POST'], ['/auth/mfa/enrollment', 'PUT'],
        ]);
        expect(mocks.fetch.mock.calls[1][1].body).toBeUndefined();
        expect(JSON.parse(mocks.fetch.mock.calls[2][1].body)).toEqual({ code: '123456' });
    } finally { response.resolve(json({ success: false })); await h.until(tree => button(tree, 'Refresh').props.disabled === false); }
  });

  it('only reports disabled for the actual owner confirmation', async () => {
    await mount(true); input(h.render(), 'Authenticator or backup code').props.onChange(changeEvent('123456'));
    mocks.fetch.mockResolvedValueOnce(json({ success: true, mfaEnabled: false })); button(h.render(), 'Disable MFA').props.onClick();
    await h.until(tree => button(tree, 'Refresh').props.disabled === false);
    expect(text(h.render())).toContain('MFA is disabled.'); expect(text(h.render())).toContain('Not enrolled');
    expect(mocks.fetch.mock.calls[1]).toEqual(['/auth/mfa/enrollment', expect.objectContaining({ method: 'DELETE', body: '{"code":"123456"}' })]);
  });

  it('uses validated flat fields even when unrelated envelope aliases are present', async () => {
    await mount(true, { enabled: true, recoveryCodesRemaining: 5, data: { enabled: false, recoveryCodesRemaining: 0 } });
    expect(text(h.render())).toContain('Enabled');
    expect(text(h.render())).toContain('5 recovery codes remaining');
    h.unmount();
    await mount();
    mocks.fetch.mockResolvedValueOnce(json({ ...setupPayload, setup: {} }));
    button(h.render(), 'Start MFA setup').props.onClick();
    await h.until(tree => button(tree, 'Refresh').props.disabled === false);
    expect(input(h.render(), 'Manual setup key').props.value).toBe('BASE32SECRET');
  });

  it('does not replay confirmation or discard the proof input when the reply is lost', async () => {
    await mount(); await start(); input(h.render(), 'Authenticator code').props.onChange(changeEvent('123456'));
    mocks.fetch.mockRejectedValueOnce(new Error('Unable to reach the service. Please try again.'));
    button(h.render(), 'Verify and enable').props.onClick();
    await h.until(tree => button(tree, 'Refresh').props.disabled === false);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(text(h.render())).not.toContain('MFA is enabled.');
    expect(input(h.render(), 'Authenticator code').props.value).toBe('123456');
    expect(text(h.render())).toContain('Unable to reach the service.');
  });
});
