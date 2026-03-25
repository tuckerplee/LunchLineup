"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformConfigSchema = exports.ObservabilityConfigSchema = exports.BackupConfigSchema = exports.SecurityConfigSchema = exports.RedisConfigSchema = exports.PostgresConfigSchema = void 0;
const zod_1 = require("zod");
exports.PostgresConfigSchema = zod_1.z.object({
    sharedBuffers: zod_1.z.string(),
    effectiveCache: zod_1.z.string(),
    workMem: zod_1.z.string(),
    maintenanceMem: zod_1.z.string(),
    maxParallelWorkers: zod_1.z.number().int().min(1).max(64),
    randomPageCost: zod_1.z.number().min(1.0).max(4.0),
    effectiveIoConcurrency: zod_1.z.number().int().min(1).max(1000),
    maxConnections: zod_1.z.number().int().min(10).max(1000).default(200),
});
exports.RedisConfigSchema = zod_1.z.object({
    maxMemory: zod_1.z.string(),
});
exports.SecurityConfigSchema = zod_1.z.object({
    hstsMaxAge: zod_1.z.number().int().default(63072000),
    hstsPreload: zod_1.z.boolean().default(true),
    allowIframeEmbedding: zod_1.z.boolean().default(false),
    rateLimitGlobalRps: zod_1.z.number().int().min(10).max(10000).default(100),
    loginLockoutAttempts: zod_1.z.number().int().default(5),
    loginLockoutDurationMin: zod_1.z.number().int().default(15),
    sessionTimeoutMin: zod_1.z.number().int().default(30),
    csrfTokenLifetimeMin: zod_1.z.number().int().default(60),
    jwtAccessTokenLifetimeMin: zod_1.z.number().int().default(15),
    jwtRefreshTokenLifetimeDays: zod_1.z.number().int().default(7),
    keyRotationOverlapHours: zod_1.z.number().int().default(24),
    cspExtraScriptSrc: zod_1.z.array(zod_1.z.string()).default([]),
    cspExtraStyleSrc: zod_1.z.array(zod_1.z.string()).default([]),
    cspExtraImgSrc: zod_1.z.array(zod_1.z.string()).default([]),
    cspExtraFontSrc: zod_1.z.array(zod_1.z.string()).default([]),
    cspExtraConnectSrc: zod_1.z.array(zod_1.z.string()).default([]),
    iframeAllowedOrigins: zod_1.z.array(zod_1.z.string()).default([]),
});
exports.BackupConfigSchema = zod_1.z.object({
    schedule: zod_1.z.string().default('0 3 * * *'),
    retentionDays: zod_1.z.number().int().default(90),
    walRetentionDays: zod_1.z.number().int().default(30),
    drDrillSchedule: zod_1.z.string().default('0 4 1 * *'),
    offsiteEnabled: zod_1.z.boolean().default(true),
});
exports.ObservabilityConfigSchema = zod_1.z.object({
    slowQueryThresholdMs: zod_1.z.number().int().default(100),
    logRetentionDays: zod_1.z.number().int().default(30),
    alertP99LatencyMs: zod_1.z.number().int().default(1000),
    alertErrorRatePercent: zod_1.z.number().default(2),
    alertDiskUsagePercent: zod_1.z.number().default(85),
});
exports.PlatformConfigSchema = zod_1.z.object({
    domain: zod_1.z.string(),
    email: zod_1.z.string().email(),
    postgres: exports.PostgresConfigSchema,
    redis: exports.RedisConfigSchema,
    security: exports.SecurityConfigSchema,
    backup: exports.BackupConfigSchema,
    observability: exports.ObservabilityConfigSchema,
});
//# sourceMappingURL=schema.js.map