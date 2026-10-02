import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { OnboardingSignupService } from './onboarding-signup.service';
import type { TenantPrismaService } from '../database/tenant-prisma.service';
import type { RbacService } from './rbac.service';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function claimedFixture(currentEmail: string | null, verified: boolean) {
    const email = 'former@example.com';
    const organization = 'Acme Dining';
    const token = 'owned-test-challenge';
    const code = '123456';
    const attempt = {
        id: 'attempt-1', tenantId: 'tenant-1', userId: 'user-1',
        identityOrganizationHash: hash(hash(email) + ':' + hash('acme dining')),
        challengeHash: hash(token), otpHash: hash(token + ':' + code),
        otpExpiresAt: new Date(Date.now() + 60_000), otpFailedAttempts: 0,
        verifiedAt: verified ? new Date() : null,
        recoveryExpiresAt: verified ? new Date(Date.now() + 60_000) : null,
    };
    const user = { id: 'user-1', tenantId: 'tenant-1', email: currentEmail, username: null, role: 'ADMIN', mfaEnabled: false };
    const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        onboardingSignupAttempt: {
            findUnique: vi.fn().mockResolvedValue(attempt),
            update: vi.fn().mockImplementation(async ({ data }) => Object.assign(attempt, data)),
        },
        tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', slug: 'acme', status: 'TRIAL', deletedAt: null }) },
        user: { findFirst: vi.fn().mockResolvedValue(user) },
    };
    const db = { withPlatformAdmin: vi.fn(async (operation) => operation(tx)) };
    const service = new OnboardingSignupService(db as unknown as TenantPrismaService, {} as RbacService);
    const claim = () => service.claimVerifiedOwner(email, organization, token, code, {}, { termsVersion: 'test-terms', privacyVersion: 'test-privacy' });
    return { claim, tx };
}

describe('bound onboarding email identity', () => {
    it.each([true, false])('rejects a replaced current email with verified recovery=%s', async (verified) => {
        const { claim } = claimedFixture('replacement@example.com', verified);
        await expect(claim()).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a removed current email', async () => {
        await expect(claimedFixture(null, true).claim()).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([true, false])('preserves the same claimed owner with verified recovery=%s', async (verified) => {
        const { claim, tx } = claimedFixture('former@example.com', verified);
        await expect(claim()).resolves.toMatchObject({
            user: { id: 'user-1', tenantId: 'tenant-1', email: 'former@example.com' }, workspaceSlug: 'acme',
        });
        expect(tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'user-1', tenantId: 'tenant-1', deletedAt: null },
        }));
    });
});
