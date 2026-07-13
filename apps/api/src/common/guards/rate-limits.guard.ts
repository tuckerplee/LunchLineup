import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { resolveRateLimits } from '@lunchlineup/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler/dist/throttler.guard.interface';
import { createHash } from 'crypto';
import { isIP } from 'net';
import { TenantPrismaService } from '../../database/tenant-prisma.service';

type RateLimitPlan = Parameters<typeof resolveRateLimits>[0];
type RateLimits = ReturnType<typeof resolveRateLimits>;
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';
const THROTTLER_BLOCK_DURATION = 'THROTTLER:BLOCK_DURATION';

/**
 * Custom Rate Limits Guard.
 * Overrides the default HTTP throttler to derive dynamic limits based on the resolved `tenantId`
 * and its corresponding `planTier` (FREE, STARTER, GROWTH, ENTERPRISE).
 * Architecture Part VII-A.8
 */
@Injectable()
export class RateLimitsGuard extends ThrottlerGuard {
    private prisma = new PrismaClient();
    private tenantDb = new TenantPrismaService(this.prisma);
    private tenantRateLimitCache = new Map<string, { limits: RateLimits; expiresAt: number }>();

    protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
        const { context, throttler, ttl, blockDuration, getTracker, generateKey } = requestProps;
        const { req, res } = this.getRequestResponse(context);
        const user = req.user;
        const throttlerName = throttler.name ?? 'default';
        const limits = await this.resolveTenantRateLimits(user?.tenantId);
        if (throttlerName !== 'default' && !this.hasNamedThrottleMetadata(context, throttlerName)) {
            return true;
        }

        const appliedLimit = this.resolveAppliedLimit(throttlerName, limits, requestProps.limit);
        const appliedTtl = ttl;

        const tracker = await this.resolveTracker(throttlerName, user, req, context, getTracker);
        const key = generateKey(context, tracker, throttlerName);

        const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } =
            await this.storageService.increment(
                key,
                appliedTtl,
                appliedLimit,
                blockDuration,
                throttlerName
            );

        const suffix = throttlerName === 'default' ? '' : `-${throttlerName}`;

        res.header(`${this.headerPrefix}-Limit${suffix}`, appliedLimit);
        res.header(`${this.headerPrefix}-Remaining${suffix}`, Math.max(0, appliedLimit - totalHits));
        res.header(`${this.headerPrefix}-Reset${suffix}`, timeToExpire);

        if (isBlocked) {
            res.header(`Retry-After${suffix}`, timeToBlockExpire);
            await this.throwThrottlingException(context, {
                limit: appliedLimit,
                ttl: appliedTtl,
                key,
                tracker,
                totalHits,
                timeToExpire,
                isBlocked,
                timeToBlockExpire,
            });
        }

        return true;
    }

    private resolveAppliedLimit(throttlerName: string, limits: RateLimits, configuredLimit: number): number {
        if (throttlerName === 'default') return limits.apiReqPerMin;
        if (throttlerName === 'auth') return limits.authAttemptsPerWindow;
        return configuredLimit;
    }

    private async resolveTracker(
        throttlerName: string,
        user: { tenantId?: string; sub?: string; sessionId?: string } | undefined,
        req: Parameters<ThrottlerRequest['getTracker']>[0],
        context: ThrottlerRequest['context'],
        getTracker: ThrottlerRequest['getTracker'],
    ): Promise<string> {
        if (throttlerName === 'auth' && user?.tenantId && user?.sub && user?.sessionId) {
            return `${user.tenantId}:${user.sub}:${user.sessionId}`;
        }
        if (throttlerName === 'authIdentifier') {
            const sourceIp = this.normalizeSourceIp(await getTracker(req, context));
            return `${sourceIp}:${this.resolvePreAuthSubject(req)}`;
        }
        if (throttlerName === 'authIp' || throttlerName === 'refreshIp') {
            return this.normalizeSourceIp(await getTracker(req, context));
        }
        if (throttlerName === 'refreshCredential') {
            const refreshToken = typeof req.cookies?.refresh_token === 'string'
                ? req.cookies.refresh_token
                : '';
            if (refreshToken) {
                return `sha256:${createHash('sha256').update(refreshToken).digest('hex')}`;
            }
        }
        if (throttlerName === 'default' && user?.tenantId) {
            return user.tenantId;
        }
        return getTracker(req, context);
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
            const tenant = await this.tenantDb.withTenant(tenantId, (tx) => tx.tenant.findUnique({
                where: { id: tenantId },
                select: { planTier: true, status: true, stripeSubscriptionId: true },
            }));
            const limits = resolveRateLimits(this.normalizeActivePlanTier(tenant));
            this.tenantRateLimitCache.set(tenantId, {
                limits,
                expiresAt: Date.now() + 60_000,
            });
            return limits;
        } catch {
            return resolveRateLimits('free');
        }
    }

    private normalizeActivePlanTier(tenant?: { planTier?: string | null; status?: string | null; stripeSubscriptionId?: string | null } | null): RateLimitPlan {
        const plan = this.normalizePlanTier(tenant?.planTier);
        if (plan === 'free') return plan;
        return tenant?.status === 'ACTIVE' && Boolean(tenant?.stripeSubscriptionId)
            ? plan
            : 'free';
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
