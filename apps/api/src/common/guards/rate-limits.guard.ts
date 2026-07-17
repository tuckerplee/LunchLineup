import { Inject, Injectable } from '@nestjs/common';
import { resolveRateLimits } from '@lunchlineup/config';
import {
    getOptionsToken,
    getStorageToken,
    ThrottlerGuard,
    type ThrottlerModuleOptions,
    type ThrottlerStorage,
} from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import type { ThrottlerRequest } from '@nestjs/throttler/dist/throttler.guard.interface';
import { createHash } from 'crypto';
import { isIP } from 'net';
import {
    hasFutureStripeSubscriptionCurrentPeriodEnd,
    hasNonBlankStripeSubscriptionId,
} from '../../billing/plan-definitions';
import { TenantPrismaService } from '../../database/tenant-prisma.service';

type RateLimitPlan = Parameters<typeof resolveRateLimits>[0];
type RateLimits = ReturnType<typeof resolveRateLimits>;
type RateLimitTenantSnapshot = {
    planTier?: string | null;
    status?: string | null;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionCurrentPeriodEnd?: Date | string | null;
};
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';
const THROTTLER_BLOCK_DURATION = 'THROTTLER:BLOCK_DURATION';
const TENANT_CEILING_BUCKET = 'tenantCeiling';
// Ten full principal budgets form the independent aggregate abuse ceiling.
const TENANT_CEILING_MULTIPLIER = 10;

type AuthenticatedRateLimitUser = {
    tenantId?: string;
    sub?: string;
    sessionId?: string;
};

type RateLimitResponse = {
    header(name: string, value: number): unknown;
};

/**
 * Custom Rate Limits Guard.
 * Overrides the default HTTP throttler to derive dynamic limits based on the resolved `tenantId`
 * and its corresponding `planTier` (FREE, STARTER, GROWTH, ENTERPRISE).
 * Architecture Part VII-A.8
 */
@Injectable()
export class RateLimitsGuard extends ThrottlerGuard {
    private tenantRateLimitCache = new Map<string, { limits: RateLimits; expiresAt: number }>();

    constructor(
        @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
        @Inject(getStorageToken()) storageService: ThrottlerStorage,
        reflector: Reflector,
        private readonly tenantDb: TenantPrismaService,
    ) {
        super(options, storageService, reflector);
    }

    protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
        const { context, throttler, ttl, blockDuration, getTracker, generateKey } = requestProps;
        const { req, res } = this.getRequestResponse(context);
        const user = req.user as AuthenticatedRateLimitUser | undefined;
        const throttlerName = throttler.name ?? 'default';
        const limits = await this.resolveTenantRateLimits(user?.tenantId);
        if (throttlerName !== 'default' && !this.hasNamedThrottleMetadata(context, throttlerName)) {
            return true;
        }

        const appliedLimit = this.resolveAppliedLimit(throttlerName, limits, requestProps.limit);
        const tracker = await this.resolveTracker(throttlerName, user, req, context, getTracker);
        const key = generateKey(context, tracker, throttlerName);

        await this.consumeBucket(
            context,
            res as RateLimitResponse,
            key,
            tracker,
            throttlerName,
            ttl,
            appliedLimit,
            blockDuration,
        );

        const authenticatedScope = this.resolveAuthenticatedScope(user);
        if (throttlerName === 'default' && authenticatedScope) {
            const tenantLimit = appliedLimit * TENANT_CEILING_MULTIPLIER;
            const tenantKey = generateKey(context, authenticatedScope.tenantTracker, TENANT_CEILING_BUCKET);
            await this.consumeBucket(
                context,
                res as RateLimitResponse,
                tenantKey,
                authenticatedScope.tenantTracker,
                TENANT_CEILING_BUCKET,
                ttl,
                tenantLimit,
                blockDuration,
            );
        }

        return true;
    }

    private async consumeBucket(
        context: ThrottlerRequest['context'],
        res: RateLimitResponse,
        key: string,
        tracker: string,
        throttlerName: string,
        ttl: number,
        limit: number,
        blockDuration: number,
    ): Promise<void> {
        const result = await this.storageService.increment(key, ttl, limit, blockDuration, throttlerName);
        const suffix = throttlerName === 'default' ? '' : '-' + throttlerName;

        res.header(this.headerPrefix + '-Limit' + suffix, limit);
        res.header(this.headerPrefix + '-Remaining' + suffix, Math.max(0, limit - result.totalHits));
        res.header(this.headerPrefix + '-Reset' + suffix, result.timeToExpire);

        if (result.isBlocked) {
            res.header('Retry-After' + suffix, result.timeToBlockExpire);
            await this.throwThrottlingException(context, {
                limit,
                ttl,
                key,
                tracker,
                ...result,
            });
        }
    }

    private resolveAppliedLimit(throttlerName: string, limits: RateLimits, configuredLimit: number): number {
        if (throttlerName === 'default') return limits.apiReqPerMin;
        if (throttlerName === 'auth') return limits.authAttemptsPerWindow;
        return configuredLimit;
    }

    private async resolveTracker(
        throttlerName: string,
        user: AuthenticatedRateLimitUser | undefined,
        req: Parameters<ThrottlerRequest['getTracker']>[0],
        context: ThrottlerRequest['context'],
        getTracker: ThrottlerRequest['getTracker'],
    ): Promise<string> {
        const authenticatedScope = this.resolveAuthenticatedScope(user);
        if (throttlerName === 'auth' && authenticatedScope) {
            return authenticatedScope.sessionTracker;
        }
        if (throttlerName === 'authIdentifier') {
            const sourceIp = this.normalizeSourceIp(await getTracker(req, context));
            return sourceIp + ':' + this.resolvePreAuthSubject(req);
        }
        if (throttlerName === 'authIp' || throttlerName === 'refreshIp') {
            return this.normalizeSourceIp(await getTracker(req, context));
        }
        if (throttlerName === 'refreshCredential') {
            const refreshToken = typeof req.cookies?.refresh_token === 'string'
                ? req.cookies.refresh_token
                : '';
            if (refreshToken) {
                return 'sha256:' + createHash('sha256').update(refreshToken).digest('hex');
            }
        }
        if (throttlerName === 'default' && authenticatedScope) {
            return authenticatedScope.principalTracker;
        }
        return getTracker(req, context);
    }

    private resolveAuthenticatedScope(user?: AuthenticatedRateLimitUser): {
        principalTracker: string;
        sessionTracker: string;
        tenantTracker: string;
    } | null {
        const tenantId = typeof user?.tenantId === 'string' ? user.tenantId.trim() : '';
        const subject = typeof user?.sub === 'string' ? user.sub.trim() : '';
        if (!tenantId || !subject) return null;

        const sessionId = typeof user?.sessionId === 'string' && user.sessionId.trim()
            ? user.sessionId.trim()
            : 'subject';
        return {
            principalTracker: this.hashTrackerValue('api-principal:' + tenantId + ':' + subject),
            sessionTracker: this.hashTrackerValue('auth-session:' + tenantId + ':' + subject + ':' + sessionId),
            tenantTracker: this.hashTrackerValue('api-tenant:' + tenantId),
        };
    }

    private resolvePreAuthSubject(req: Parameters<ThrottlerRequest['getTracker']>[0]): string {
        const body = req.body && typeof req.body === 'object'
            ? req.body as Record<string, unknown>
            : {};
        const tenant = this.normalizeIdentityPart(body.tenantSlug) || 'onboarding';
        const identifier = this.normalizeIdentityPart(body.email)
            || this.normalizeIdentityPart(body.identifier);

        if (identifier) {
            return this.hashTrackerValue(`account:${tenant}:${identifier}`);
        }

        const resetToken = typeof body.token === 'string' ? body.token.trim() : '';
        if (resetToken) {
            return this.hashTrackerValue(`reset-token:${resetToken}`);
        }

        return this.hashTrackerValue(`missing:${tenant}`);
    }

    private normalizeIdentityPart(value: unknown): string {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
    }

    private normalizeSourceIp(value: string): string {
        let address = value.trim().toLowerCase();
        if (address.startsWith('[') && address.endsWith(']')) {
            address = address.slice(1, -1);
        }

        const mappedIpv4 = this.ipv4FromMappedIpv6(address);
        if (mappedIpv4) return mappedIpv4;

        if (isIP(address) === 4) {
            return address.split('.').map((part) => String(Number(part))).join('.');
        }
        if (isIP(address) === 6) {
            try {
                return new URL(`http://[${address}]`).hostname.slice(1, -1);
            } catch {
                // Valid scoped IPv6 values are uncommon here; preserve a stable non-sensitive key.
            }
        }

        return `unparsed:${this.hashTrackerValue(address || 'missing')}`;
    }

    private ipv4FromMappedIpv6(address: string): string | null {
        const prefix = '::ffff:';
        if (!address.startsWith(prefix)) return null;

        const suffix = address.slice(prefix.length);
        if (isIP(suffix) === 4) {
            return suffix.split('.').map((part) => String(Number(part))).join('.');
        }

        const words = suffix.split(':');
        if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
            return null;
        }
        const high = Number.parseInt(words[0], 16);
        const low = Number.parseInt(words[1], 16);
        return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    }

    private hashTrackerValue(value: string): string {
        return `sha256:${createHash('sha256').update(value).digest('hex')}`;
    }

    private hasNamedThrottleMetadata(context: ThrottlerRequest['context'], throttlerName: string): boolean {
        const targets = [context.getHandler(), context.getClass()];
        return [
            `${THROTTLER_LIMIT}${throttlerName}`,
            `${THROTTLER_TTL}${throttlerName}`,
            `${THROTTLER_BLOCK_DURATION}${throttlerName}`,
        ].some((key) => this.reflector.getAllAndOverride(key, targets) !== undefined);
    }

    private async resolveTenantRateLimits(tenantId?: string): Promise<RateLimits> {
        if (!tenantId) return resolveRateLimits('free');

        const cached = this.tenantRateLimitCache.get(tenantId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.limits;
        }

        try {
            const now = new Date();
            const tenant = await this.tenantDb.withTenant(tenantId, (tx) => tx.tenant.findUnique({
                where: { id: tenantId },
                select: {
                    planTier: true,
                    status: true,
                    stripeSubscriptionId: true,
                    stripeSubscriptionCurrentPeriodEnd: true,
                },
            }));
            const plan = this.normalizeActivePlanTier(tenant, now);
            const limits = resolveRateLimits(plan);
            this.tenantRateLimitCache.set(tenantId, {
                limits,
                expiresAt: this.resolveCacheExpiry(tenant, plan, now),
            });
            return limits;
        } catch {
            return resolveRateLimits('free');
        }
    }

    private normalizeActivePlanTier(
        tenant: RateLimitTenantSnapshot | null | undefined,
        now: Date,
    ): RateLimitPlan {
        const plan = this.normalizePlanTier(tenant?.planTier);
        if (plan === 'free') return plan;
        return String(tenant?.status ?? '').trim().toUpperCase() === 'ACTIVE'
            && hasNonBlankStripeSubscriptionId(tenant?.stripeSubscriptionId)
            && hasFutureStripeSubscriptionCurrentPeriodEnd(
                tenant?.stripeSubscriptionCurrentPeriodEnd,
                now,
            )
            ? plan
            : 'free';
    }

    private resolveCacheExpiry(
        tenant: RateLimitTenantSnapshot | null | undefined,
        plan: RateLimitPlan,
        now: Date,
    ): number {
        const normalExpiry = now.getTime() + 60_000;
        if (plan === 'free') return normalExpiry;
        const paidThrough = tenant?.stripeSubscriptionCurrentPeriodEnd;
        const paidThroughEpoch = paidThrough instanceof Date
            ? paidThrough.getTime()
            : typeof paidThrough === 'string'
                ? new Date(paidThrough).getTime()
                : Number.NaN;
        return Number.isFinite(paidThroughEpoch)
            ? Math.min(normalExpiry, paidThroughEpoch)
            : now.getTime();
    }

    private normalizePlanTier(value?: string | null): RateLimitPlan {
        switch ((value ?? '').trim().toUpperCase()) {
            case 'FREE':
                return 'free';
            case 'STARTER':
            case 'BASIC':
                return 'starter';
            case 'GROWTH':
            case 'PRO':
                return 'growth';
            case 'ENTERPRISE':
                return 'enterprise';
            default:
                return 'free';
        }
    }
}
