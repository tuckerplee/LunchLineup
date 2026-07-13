import { describe, expect, it } from 'vitest';

import {
  normalizeMfaEnrollmentState,
  normalizeMfaSetupChallenge,
  readRecoveryCodes,
} from '../../app/dashboard/settings/mfa-enrollment-contract';

describe('MFA enrollment contract normalizers', () => {
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
