import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { MetricsService } from '../common/metrics.service';

@Controller({ path: 'admin', version: '1' })
@UseGuards(JwtAuthGuard)
export class AdminController {
    private prisma = new PrismaClient();

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
    ) { }

    private assertSuperAdmin(req: any) {
        if (req?.user?.role !== 'SUPER_ADMIN') {
            throw new ForbiddenException('SUPER_ADMIN role required.');
        }
    }

    @Get('stats')
    async stats(@Req() req: any) {
        this.assertSuperAdmin(req);

        const now = new Date();
        const [totalTenants, totalUsers, activeSessions] = await Promise.all([
            this.prisma.tenant.count({ where: { deletedAt: null } }),
            this.prisma.user.count({ where: { deletedAt: null } }),
            this.prisma.session.count({
                where: {
                    revokedAt: null,
                    expiresAt: { gt: now },
                },
            }),
        ]);

        return {
            totalTenants,
            totalUsers,
            activeSessions,
            solverQueue: 0,
        };
    }

    @Get('tenants')
    async tenants(@Req() req: any) {
        this.assertSuperAdmin(req);

        const data = await this.prisma.tenant.findMany({
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            include: {
                _count: {
                    select: {
                        users: {
                            where: { deletedAt: null },
                        },
                        locations: {
                            where: { deletedAt: null },
                        },
                    },
                },
            },
        });

        return {
            data: data.map((tenant: any) => ({
                id: tenant.id,
                name: tenant.name,
                slug: tenant.slug,
                planTier: tenant.planTier,
                status: tenant.status,
                usageCredits: tenant.usageCredits,
                createdAt: tenant.createdAt,
                usersCount: tenant._count?.users ?? 0,
                locationsCount: tenant._count?.locations ?? 0,
            })),
        };
    }

    @Get('users')
    async users(@Req() req: any, @Query('q') q?: string) {
        this.assertSuperAdmin(req);

        const search = q?.trim();
        const where: any = { deletedAt: null };
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { tenant: { name: { contains: search, mode: 'insensitive' } } },
                { tenant: { slug: { contains: search, mode: 'insensitive' } } },
            ];
        }

        const data = await this.prisma.user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                    },
                },
            },
            take: 200,
        });

        return {
            data: data.map((user: any) => ({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt,
                lastLoginAt: user.lastLoginAt,
                lockedUntil: user.lockedUntil,
                tenant: user.tenant,
            })),
        };
    }

    @Get('audit')
    async audit(@Req() req: any, @Query('limit') limitRaw?: string) {
        this.assertSuperAdmin(req);

        const limit = Math.min(Math.max(Number(limitRaw) || 25, 1), 100);
        const rows = await this.prisma.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        role: true,
                    },
                },
            },
        });

        return {
            data: rows.map((row: any) => ({
                id: row.id,
                tenantId: row.tenantId,
                action: row.action,
                resource: row.resource,
                resourceId: row.resourceId,
                createdAt: row.createdAt,
                user: row.user
                    ? {
                        id: row.user.id,
                        name: row.user.name,
                        email: row.user.email,
                        role: row.user.role,
                    }
                    : null,
            })),
        };
    }

    @Get('credits')
    async credits(@Req() req: any, @Query('limit') limitRaw?: string) {
        this.assertSuperAdmin(req);

        const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);
        const [tenants, transactions] = await Promise.all([
            this.prisma.tenant.findMany({
                where: { deletedAt: null },
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    planTier: true,
                    usageCredits: true,
                },
            }),
            this.prisma.creditTransaction.findMany({
                orderBy: { createdAt: 'desc' },
                take: limit,
                include: {
                    tenant: {
                        select: {
                            id: true,
                            name: true,
                            slug: true,
                        },
                    },
                },
            }),
        ]);

        return {
            tenants: tenants.map((tenant: any) => ({
                id: tenant.id,
                name: tenant.name,
                slug: tenant.slug,
                planTier: tenant.planTier,
                usageCredits: tenant.usageCredits,
            })),
            history: transactions.map((tx: any) => ({
                id: tx.id,
                amount: tx.amount,
                reason: tx.reason,
                createdAt: tx.createdAt,
                tenant: tx.tenant
                    ? {
                        id: tx.tenant.id,
                        name: tx.tenant.name,
                        slug: tx.tenant.slug,
                    }
                    : null,
            })),
        };
    }

    @Get('health')
    async health(@Req() req: any) {
        this.assertSuperAdmin(req);

        const checkedAt = new Date().toISOString();
        const components: Array<{
            label: string;
            status: 'online' | 'degraded' | 'offline' | 'unknown';
            latencyMs: number | null;
            details?: string;
        }> = [{ label: 'API', status: 'online', latencyMs: 0, details: 'request handling active' }];

        const dbCheck = await this.timeCheck(async () => {
            await this.prisma.$queryRaw`SELECT 1`;
        });
        components.push({
            label: 'Database',
            status: dbCheck.ok ? 'online' : 'offline',
            latencyMs: dbCheck.latencyMs,
            details: dbCheck.ok ? 'query succeeded' : this.stringifyError(dbCheck.error),
        });

        const redisUrl = this.configService.get<string>('REDIS_URL') ?? process.env.REDIS_URL;
        if (!redisUrl) {
            components.push({
                label: 'Redis',
                status: 'unknown',
                latencyMs: null,
                details: 'REDIS_URL is not configured',
            });
        } else {
            const redisCheck = await this.timeCheck(async () => {
                const redis = new Redis(redisUrl, {
                    lazyConnect: true,
                    maxRetriesPerRequest: 1,
                    connectTimeout: 1500,
                });
                try {
                    await redis.connect();
                    const pong = await redis.ping();
                    if (pong !== 'PONG') {
                        throw new Error(`Unexpected ping response: ${pong}`);
                    }
                } finally {
                    redis.disconnect();
                }
            });

            components.push({
                label: 'Redis',
                status: redisCheck.ok ? 'online' : 'offline',
                latencyMs: redisCheck.latencyMs,
                details: redisCheck.ok ? 'ping succeeded' : this.stringifyError(redisCheck.error),
            });
        }

        let queueDepth: number | null = null;
        try {
            const metric: any = await this.metricsService.solverQueueDepth.get();
            const raw = Array.isArray(metric?.values) ? metric.values[0]?.value : undefined;
            queueDepth = typeof raw === 'number' ? raw : null;
        } catch {
            queueDepth = null;
        }

        components.push({
            label: 'Solver Queue',
            status: queueDepth === null ? 'unknown' : queueDepth > 50 ? 'degraded' : 'online',
            latencyMs: null,
            details: queueDepth === null ? 'no queue telemetry available yet' : `${queueDepth} pending jobs`,
        });

        const hasOffline = components.some((component) => component.status === 'offline');
        const hasDegraded = components.some((component) => component.status === 'degraded');
        const hasUnknown = components.some((component) => component.status === 'unknown');
        const overall = hasOffline ? 'offline' : hasDegraded || hasUnknown ? 'degraded' : 'online';

        return { checkedAt, overall, components };
    }

    private async timeCheck(task: () => Promise<void>) {
        const start = Date.now();
        try {
            await task();
            return { ok: true as const, latencyMs: Date.now() - start, error: null as string | null };
        } catch (error) {
            return { ok: false as const, latencyMs: Date.now() - start, error: this.stringifyError(error) };
        }
    }

    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return 'Unknown error';
    }
}
