import { z } from 'zod';

export const PostgresConfigSchema = z.object({
    sharedBuffers: z.string(),
    effectiveCache: z.string(),
    workMem: z.string(),
    maintenanceMem: z.string(),
    maxParallelWorkers: z.number().int().min(1).max(64),
    randomPageCost: z.number().min(1.0).max(4.0),
    effectiveIoConcurrency: z.number().int().min(1).max(1000),
    maxConnections: z.number().int().min(10).max(1000).default(200),
});

export const RedisConfigSchema = z.object({
    maxMemory: z.string(),
});

export const SecurityConfigSchema = z.object({
    hstsMaxAge: z.number().int().default(63072000),
    hstsPreload: z.boolean().default(true),
    allowIframeEmbedding: z.boolean().default(false),
    rateLimitGlobalRps: z.number().int().min(10).max(10000).default(100),
    loginLockoutAttempts: z.number().int().default(5),
    loginLockoutDurationMin: z.number().int().default(15),
    sessionTimeoutMin: z.number().int().default(30),
    csrfTokenLifetimeMin: z.number().int().default(60),
    jwtAccessTokenLifetimeMin: z.number().int().default(30),
    jwtRefreshTokenLifetimeDays: z.number().int().default(7),
    keyRotationOverlapHours: z.number().int().default(24),
    cspExtraScriptSrc: z.array(z.string()).default([]),
    cspExtraStyleSrc: z.array(z.string()).default([]),
    cspExtraImgSrc: z.array(z.string()).default([]),
    cspExtraFontSrc: z.array(z.string()).default([]),
    cspExtraConnectSrc: z.array(z.string()).default([]),
    iframeAllowedOrigins: z.array(z.string()).default([]),
});

export const BackupConfigSchema = z.object({
    schedule: z.string().default('0 3 * * *'),
    retentionDays: z.number().int().default(90),
    walRetentionDays: z.number().int().default(30),
    drDrillSchedule: z.string().default('0 4 1 * *'),
    offsiteEnabled: z.boolean().default(true),
});

export const ObservabilityConfigSchema = z.object({
    slowQueryThresholdMs: z.number().int().default(100),
    logRetentionDays: z.number().int().default(30),
    alertP99LatencyMs: z.number().int().default(1000),
    alertErrorRatePercent: z.number().default(2),
    alertDiskUsagePercent: z.number().default(85),
});

export const PlatformConfigSchema = z.object({
    domain: z.string(),
    email: z.string().email(),
    postgres: PostgresConfigSchema,
    redis: RedisConfigSchema,
    security: SecurityConfigSchema,
    backup: BackupConfigSchema,
    observability: ObservabilityConfigSchema,
});

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
