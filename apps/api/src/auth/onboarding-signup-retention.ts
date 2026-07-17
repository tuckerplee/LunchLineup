import { Prisma } from '@prisma/client';

export const ONBOARDING_SIGNUP_ATTEMPT_RETENTION_HOURS = 24;

export type OnboardingSignupAttemptRetentionResult = {
    retentionHours: number;
    eligibleCount: number;
    purgedCount: number;
};

export async function applyOnboardingSignupAttemptRetention(
    tx: Prisma.TransactionClient,
    asOf: Date,
    dryRun: boolean,
): Promise<OnboardingSignupAttemptRetentionResult> {
    if (dryRun) {
        const rows = await tx.$queryRaw<Array<{ eligibleCount: bigint | number | string }>>`
            SELECT COUNT(*)::BIGINT AS "eligibleCount"
            FROM public."OnboardingSignupAttempt"
            WHERE GREATEST(
                "updatedAt",
                "otpExpiresAt",
                COALESCE("recoveryExpiresAt", '-infinity'::TIMESTAMP)
            ) <= (${asOf}::TIMESTAMPTZ AT TIME ZONE 'UTC')
                - make_interval(hours => ${ONBOARDING_SIGNUP_ATTEMPT_RETENTION_HOURS})
        `;
        return {
            retentionHours: ONBOARDING_SIGNUP_ATTEMPT_RETENTION_HOURS,
            eligibleCount: parseDatabaseCount(rows[0]?.eligibleCount),
            purgedCount: 0,
        };
    }

    const rows = await tx.$queryRaw<Array<{ purgedCount: bigint | number | string }>>`
        SELECT public.purge_expired_onboarding_signup_attempts(
            ${asOf}::TIMESTAMPTZ AT TIME ZONE 'UTC'
        )::BIGINT AS "purgedCount"
    `;
    const purgedCount = parseDatabaseCount(rows[0]?.purgedCount);
    return {
        retentionHours: ONBOARDING_SIGNUP_ATTEMPT_RETENTION_HOURS,
        eligibleCount: purgedCount,
        purgedCount,
    };
}

function parseDatabaseCount(value: bigint | number | string | undefined): number {
    const count = Number(value ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Onboarding signup-attempt retention returned an invalid count.');
    }
    return count;
}
