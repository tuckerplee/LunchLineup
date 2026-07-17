import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PlanTier, TenantStatus, UserRole } from '@prisma/client';
import * as crypto from 'crypto';
import { assertTenantCanAddActiveUser } from '../billing/user-capacity';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { RbacService } from './rbac.service';

const ONBOARDING_OTP_TTL_MS = 10 * 60 * 1000;
const ONBOARDING_OTP_RATE_LIMIT_MS = 60 * 1000;
const ONBOARDING_RECOVERY_TTL_MS = 30 * 60 * 1000;
const ONBOARDING_OTP_MAX_FAILED_ATTEMPTS = 5;
const PUBLIC_SIGNUP_TRIAL_DAYS = 14;

export type OnboardingChallenge = {
    challengeToken: string;
    code: string;
};

export type ClaimedOnboardingOwner = {
    user: {
        id: string;
        email: string | null;
        username: string | null;
        tenantId: string;
        role: UserRole;
        mfaEnabled: boolean;
    };
    workspaceSlug: string;
    tenantStatus: TenantStatus;
    tenantDeletedAt: Date | null;
};

type ClaimAudit = {
    ipAddress?: string | null;
    userAgent?: string | null;
};

type ClaimLegalVersions = {
    termsVersion: string;
    privacyVersion: string;
};

@Injectable()
export class OnboardingSignupService {
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly rbacService: RbacService,
    ) {}

    async createChallenge(email: string, tenantName: string): Promise<OnboardingChallenge> {
        const challengeToken = crypto.randomBytes(32).toString('base64url');
        const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
        const identityHash = this.hash(email);
        const organizationHash = this.hash(this.normalizeOrganization(tenantName));
        const identityOrganizationHash = this.hash(`${identityHash}:${organizationHash}`);
        const now = new Date();

        await this.tenantDb.withPlatformAdmin(async (tx) => {
            await this.lockIdentityOrganization(tx, identityOrganizationHash);
            const existing = await tx.onboardingSignupAttempt.findUnique({
                where: { identityOrganizationHash },
            });
            if (
                existing
                && now.getTime() - existing.otpSentAt.getTime() < ONBOARDING_OTP_RATE_LIMIT_MS
            ) {
                throw new BadRequestException('Please wait before requesting another code');
            }

            const challenge = {
                identityHash,
                organizationHash,
                challengeHash: this.hash(challengeToken),
                otpHash: this.hash(`${challengeToken}:${code}`),
                otpSentAt: now,
                otpExpiresAt: new Date(now.getTime() + ONBOARDING_OTP_TTL_MS),
                otpFailedAttempts: 0,
                verifiedAt: null,
                recoveryExpiresAt: null,
            };
            if (existing) {
                await tx.onboardingSignupAttempt.update({
                    where: { id: existing.id },
                    data: challenge,
                });
            } else {
                await tx.onboardingSignupAttempt.create({
                    data: {
                        identityOrganizationHash,
                        ...challenge,
                    },
                });
            }
        });

        return { challengeToken, code };
    }

    async claimVerifiedOwner(
        email: string,
        tenantName: string,
        challengeToken: string,
        code: string,
        audit: ClaimAudit,
        legalVersions: ClaimLegalVersions,
    ): Promise<ClaimedOnboardingOwner> {
        const identityHash = this.hash(email);
        const organizationHash = this.hash(this.normalizeOrganization(tenantName));
        const identityOrganizationHash = this.hash(`${identityHash}:${organizationHash}`);
        const challengeHash = this.hash(challengeToken);
        const otpHash = this.hash(`${challengeToken}:${code.trim()}`);
        const outcome = await this.tenantDb.withPlatformAdmin(async (tx) => {
            const candidate = await tx.onboardingSignupAttempt.findUnique({
                where: { challengeHash },
            });
            if (!candidate || candidate.identityOrganizationHash !== identityOrganizationHash) {
                return null;
            }

            await tx.$queryRaw`SELECT "id" FROM "OnboardingSignupAttempt" WHERE "id" = ${candidate.id} FOR UPDATE`;
            const attempt = await tx.onboardingSignupAttempt.findUnique({
                where: { id: candidate.id },
            });
            if (!attempt || attempt.challengeHash !== challengeHash) {
                return null;
            }

            const now = new Date();
            if (attempt.verifiedAt) {
                if (!attempt.recoveryExpiresAt || attempt.recoveryExpiresAt <= now) {
                    return null;
                }
                return this.loadClaimedOwner(tx, attempt.tenantId, attempt.userId);
            }

            if (
                attempt.otpExpiresAt <= now
                || attempt.otpFailedAttempts >= ONBOARDING_OTP_MAX_FAILED_ATTEMPTS
                || !this.hashesMatch(attempt.otpHash, otpHash)
            ) {
                if (
                    attempt.otpExpiresAt > now
                    && attempt.otpFailedAttempts < ONBOARDING_OTP_MAX_FAILED_ATTEMPTS
                ) {
                    await tx.onboardingSignupAttempt.update({
                        where: { id: attempt.id },
                        data: { otpFailedAttempts: { increment: 1 } },
                    });
                }
                return null;
            }

            const recoveryExpiresAt = new Date(now.getTime() + ONBOARDING_RECOVERY_TTL_MS);
            if (attempt.tenantId && attempt.userId) {
                await tx.onboardingSignupAttempt.update({
                    where: { id: attempt.id },
                    data: { verifiedAt: now, recoveryExpiresAt },
                });
                return this.loadClaimedOwner(tx, attempt.tenantId, attempt.userId);
            }

            const tenant = await tx.tenant.create({
                data: {
                    name: tenantName,
                    slug: this.provisionedTenantSlug(tenantName),
                    planTier: PlanTier.STARTER,
                    status: TenantStatus.TRIAL,
                    trialEndsAt: new Date(now.getTime() + PUBLIC_SIGNUP_TRIAL_DAYS * 24 * 60 * 60 * 1000),
                    usageCredits: 0,
                },
            });
            await assertTenantCanAddActiveUser(tx as any, tenant.id);
            const user = await tx.user.create({
                data: {
                    email,
                    name: email.split('@')[0],
                    tenantId: tenant.id,
                    role: UserRole.ADMIN,
                },
            });
            await tx.auditLog.create({
                data: {
                    tenantId: tenant.id,
                    userId: user.id,
                    action: 'PUBLIC_SIGNUP_LEGAL_ASSENT',
                    resource: 'Tenant',
                    resourceId: tenant.id,
                    newValue: {
                        termsVersion: legalVersions.termsVersion,
                        privacyVersion: legalVersions.privacyVersion,
                        assentedAt: now.toISOString(),
                        assentedByEmail: email,
                    },
                    ipAddress: audit.ipAddress?.trim() || null,
                    userAgent: audit.userAgent?.trim() || null,
                },
            });
            await this.rbacService.provisionLegacySystemRole(
                tx,
                user.id,
                tenant.id,
                UserRole.ADMIN,
            );
            await tx.onboardingSignupAttempt.update({
                where: { id: attempt.id },
                data: {
                    verifiedAt: now,
                    recoveryExpiresAt,
                    tenantId: tenant.id,
                    userId: user.id,
                },
            });

            return {
                user,
                workspaceSlug: tenant.slug,
                tenantStatus: tenant.status,
                tenantDeletedAt: tenant.deletedAt,
            };
        }, { isolationLevel: 'Serializable' });

        if (!outcome) {
            throw new UnauthorizedException('Invalid or expired code');
        }
        return outcome;
    }

    private async loadClaimedOwner(
        tx: TenantPrismaTransaction,
        tenantId: string | null,
        userId: string | null,
    ): Promise<ClaimedOnboardingOwner | null> {
        if (!tenantId || !userId) return null;
        const [tenant, user] = await Promise.all([
            tx.tenant.findUnique({
                where: { id: tenantId },
                select: { id: true, slug: true, status: true, deletedAt: true },
            }),
            tx.user.findFirst({
                where: { id: userId, tenantId, deletedAt: null },
                select: {
                    id: true,
                    email: true,
                    username: true,
                    tenantId: true,
                    role: true,
                    mfaEnabled: true,
                },
            }),
        ]);
        if (!tenant || !user) return null;
        return {
            user,
            workspaceSlug: tenant.slug,
            tenantStatus: tenant.status,
            tenantDeletedAt: tenant.deletedAt,
        };
    }

    private async lockIdentityOrganization(
        tx: TenantPrismaTransaction,
        identityOrganizationHash: string,
    ): Promise<void> {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identityOrganizationHash}, 0))`;
    }

    private normalizeOrganization(value: string): string {
        return value.trim().toLowerCase().replace(/\s+/g, ' ');
    }

    private hash(value: string): string {
        return crypto.createHash('sha256').update(value).digest('hex');
    }

    private hashesMatch(expected: string, actual: string): boolean {
        const expectedBuffer = Buffer.from(expected, 'hex');
        const actualBuffer = Buffer.from(actual, 'hex');
        return expectedBuffer.length === actualBuffer.length
            && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
    }

    private provisionedTenantSlug(name: string): string {
        const base = name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40)
            .replace(/-+$/g, '') || 'workspace';
        return `${base}-${crypto.randomBytes(3).toString('hex')}`;
    }
}
