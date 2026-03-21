import { z } from 'zod';
export declare const PostgresConfigSchema: z.ZodObject<{
    sharedBuffers: z.ZodString;
    effectiveCache: z.ZodString;
    workMem: z.ZodString;
    maintenanceMem: z.ZodString;
    maxParallelWorkers: z.ZodNumber;
    randomPageCost: z.ZodNumber;
    effectiveIoConcurrency: z.ZodNumber;
    maxConnections: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    sharedBuffers: string;
    effectiveCache: string;
    workMem: string;
    maintenanceMem: string;
    maxParallelWorkers: number;
    randomPageCost: number;
    effectiveIoConcurrency: number;
    maxConnections: number;
}, {
    sharedBuffers: string;
    effectiveCache: string;
    workMem: string;
    maintenanceMem: string;
    maxParallelWorkers: number;
    randomPageCost: number;
    effectiveIoConcurrency: number;
    maxConnections?: number | undefined;
}>;
export declare const RedisConfigSchema: z.ZodObject<{
    maxMemory: z.ZodString;
}, "strip", z.ZodTypeAny, {
    maxMemory: string;
}, {
    maxMemory: string;
}>;
export declare const SecurityConfigSchema: z.ZodObject<{
    hstsMaxAge: z.ZodDefault<z.ZodNumber>;
    hstsPreload: z.ZodDefault<z.ZodBoolean>;
    allowIframeEmbedding: z.ZodDefault<z.ZodBoolean>;
    rateLimitGlobalRps: z.ZodDefault<z.ZodNumber>;
    loginLockoutAttempts: z.ZodDefault<z.ZodNumber>;
    loginLockoutDurationMin: z.ZodDefault<z.ZodNumber>;
    sessionTimeoutMin: z.ZodDefault<z.ZodNumber>;
    csrfTokenLifetimeMin: z.ZodDefault<z.ZodNumber>;
    jwtAccessTokenLifetimeMin: z.ZodDefault<z.ZodNumber>;
    jwtRefreshTokenLifetimeDays: z.ZodDefault<z.ZodNumber>;
    keyRotationOverlapHours: z.ZodDefault<z.ZodNumber>;
    cspExtraScriptSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    cspExtraStyleSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    cspExtraImgSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    cspExtraFontSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    cspExtraConnectSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    iframeAllowedOrigins: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    hstsMaxAge: number;
    hstsPreload: boolean;
    allowIframeEmbedding: boolean;
    rateLimitGlobalRps: number;
    loginLockoutAttempts: number;
    loginLockoutDurationMin: number;
    sessionTimeoutMin: number;
    csrfTokenLifetimeMin: number;
    jwtAccessTokenLifetimeMin: number;
    jwtRefreshTokenLifetimeDays: number;
    keyRotationOverlapHours: number;
    cspExtraScriptSrc: string[];
    cspExtraStyleSrc: string[];
    cspExtraImgSrc: string[];
    cspExtraFontSrc: string[];
    cspExtraConnectSrc: string[];
    iframeAllowedOrigins: string[];
}, {
    hstsMaxAge?: number | undefined;
    hstsPreload?: boolean | undefined;
    allowIframeEmbedding?: boolean | undefined;
    rateLimitGlobalRps?: number | undefined;
    loginLockoutAttempts?: number | undefined;
    loginLockoutDurationMin?: number | undefined;
    sessionTimeoutMin?: number | undefined;
    csrfTokenLifetimeMin?: number | undefined;
    jwtAccessTokenLifetimeMin?: number | undefined;
    jwtRefreshTokenLifetimeDays?: number | undefined;
    keyRotationOverlapHours?: number | undefined;
    cspExtraScriptSrc?: string[] | undefined;
    cspExtraStyleSrc?: string[] | undefined;
    cspExtraImgSrc?: string[] | undefined;
    cspExtraFontSrc?: string[] | undefined;
    cspExtraConnectSrc?: string[] | undefined;
    iframeAllowedOrigins?: string[] | undefined;
}>;
export declare const BackupConfigSchema: z.ZodObject<{
    schedule: z.ZodDefault<z.ZodString>;
    retentionDays: z.ZodDefault<z.ZodNumber>;
    walRetentionDays: z.ZodDefault<z.ZodNumber>;
    drDrillSchedule: z.ZodDefault<z.ZodString>;
    offsiteEnabled: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    schedule: string;
    retentionDays: number;
    walRetentionDays: number;
    drDrillSchedule: string;
    offsiteEnabled: boolean;
}, {
    schedule?: string | undefined;
    retentionDays?: number | undefined;
    walRetentionDays?: number | undefined;
    drDrillSchedule?: string | undefined;
    offsiteEnabled?: boolean | undefined;
}>;
export declare const ObservabilityConfigSchema: z.ZodObject<{
    slowQueryThresholdMs: z.ZodDefault<z.ZodNumber>;
    logRetentionDays: z.ZodDefault<z.ZodNumber>;
    alertP99LatencyMs: z.ZodDefault<z.ZodNumber>;
    alertErrorRatePercent: z.ZodDefault<z.ZodNumber>;
    alertDiskUsagePercent: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    slowQueryThresholdMs: number;
    logRetentionDays: number;
    alertP99LatencyMs: number;
    alertErrorRatePercent: number;
    alertDiskUsagePercent: number;
}, {
    slowQueryThresholdMs?: number | undefined;
    logRetentionDays?: number | undefined;
    alertP99LatencyMs?: number | undefined;
    alertErrorRatePercent?: number | undefined;
    alertDiskUsagePercent?: number | undefined;
}>;
export declare const PlatformConfigSchema: z.ZodObject<{
    domain: z.ZodString;
    email: z.ZodString;
    postgres: z.ZodObject<{
        sharedBuffers: z.ZodString;
        effectiveCache: z.ZodString;
        workMem: z.ZodString;
        maintenanceMem: z.ZodString;
        maxParallelWorkers: z.ZodNumber;
        randomPageCost: z.ZodNumber;
        effectiveIoConcurrency: z.ZodNumber;
        maxConnections: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        sharedBuffers: string;
        effectiveCache: string;
        workMem: string;
        maintenanceMem: string;
        maxParallelWorkers: number;
        randomPageCost: number;
        effectiveIoConcurrency: number;
        maxConnections: number;
    }, {
        sharedBuffers: string;
        effectiveCache: string;
        workMem: string;
        maintenanceMem: string;
        maxParallelWorkers: number;
        randomPageCost: number;
        effectiveIoConcurrency: number;
        maxConnections?: number | undefined;
    }>;
    redis: z.ZodObject<{
        maxMemory: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        maxMemory: string;
    }, {
        maxMemory: string;
    }>;
    security: z.ZodObject<{
        hstsMaxAge: z.ZodDefault<z.ZodNumber>;
        hstsPreload: z.ZodDefault<z.ZodBoolean>;
        allowIframeEmbedding: z.ZodDefault<z.ZodBoolean>;
        rateLimitGlobalRps: z.ZodDefault<z.ZodNumber>;
        loginLockoutAttempts: z.ZodDefault<z.ZodNumber>;
        loginLockoutDurationMin: z.ZodDefault<z.ZodNumber>;
        sessionTimeoutMin: z.ZodDefault<z.ZodNumber>;
        csrfTokenLifetimeMin: z.ZodDefault<z.ZodNumber>;
        jwtAccessTokenLifetimeMin: z.ZodDefault<z.ZodNumber>;
        jwtRefreshTokenLifetimeDays: z.ZodDefault<z.ZodNumber>;
        keyRotationOverlapHours: z.ZodDefault<z.ZodNumber>;
        cspExtraScriptSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        cspExtraStyleSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        cspExtraImgSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        cspExtraFontSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        cspExtraConnectSrc: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        iframeAllowedOrigins: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        hstsMaxAge: number;
        hstsPreload: boolean;
        allowIframeEmbedding: boolean;
        rateLimitGlobalRps: number;
        loginLockoutAttempts: number;
        loginLockoutDurationMin: number;
        sessionTimeoutMin: number;
        csrfTokenLifetimeMin: number;
        jwtAccessTokenLifetimeMin: number;
        jwtRefreshTokenLifetimeDays: number;
        keyRotationOverlapHours: number;
        cspExtraScriptSrc: string[];
        cspExtraStyleSrc: string[];
        cspExtraImgSrc: string[];
        cspExtraFontSrc: string[];
        cspExtraConnectSrc: string[];
        iframeAllowedOrigins: string[];
    }, {
        hstsMaxAge?: number | undefined;
        hstsPreload?: boolean | undefined;
        allowIframeEmbedding?: boolean | undefined;
        rateLimitGlobalRps?: number | undefined;
        loginLockoutAttempts?: number | undefined;
        loginLockoutDurationMin?: number | undefined;
        sessionTimeoutMin?: number | undefined;
        csrfTokenLifetimeMin?: number | undefined;
        jwtAccessTokenLifetimeMin?: number | undefined;
        jwtRefreshTokenLifetimeDays?: number | undefined;
        keyRotationOverlapHours?: number | undefined;
        cspExtraScriptSrc?: string[] | undefined;
        cspExtraStyleSrc?: string[] | undefined;
        cspExtraImgSrc?: string[] | undefined;
        cspExtraFontSrc?: string[] | undefined;
        cspExtraConnectSrc?: string[] | undefined;
        iframeAllowedOrigins?: string[] | undefined;
    }>;
    backup: z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        retentionDays: z.ZodDefault<z.ZodNumber>;
        walRetentionDays: z.ZodDefault<z.ZodNumber>;
        drDrillSchedule: z.ZodDefault<z.ZodString>;
        offsiteEnabled: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        schedule: string;
        retentionDays: number;
        walRetentionDays: number;
        drDrillSchedule: string;
        offsiteEnabled: boolean;
    }, {
        schedule?: string | undefined;
        retentionDays?: number | undefined;
        walRetentionDays?: number | undefined;
        drDrillSchedule?: string | undefined;
        offsiteEnabled?: boolean | undefined;
    }>;
    observability: z.ZodObject<{
        slowQueryThresholdMs: z.ZodDefault<z.ZodNumber>;
        logRetentionDays: z.ZodDefault<z.ZodNumber>;
        alertP99LatencyMs: z.ZodDefault<z.ZodNumber>;
        alertErrorRatePercent: z.ZodDefault<z.ZodNumber>;
        alertDiskUsagePercent: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        slowQueryThresholdMs: number;
        logRetentionDays: number;
        alertP99LatencyMs: number;
        alertErrorRatePercent: number;
        alertDiskUsagePercent: number;
    }, {
        slowQueryThresholdMs?: number | undefined;
        logRetentionDays?: number | undefined;
        alertP99LatencyMs?: number | undefined;
        alertErrorRatePercent?: number | undefined;
        alertDiskUsagePercent?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    email: string;
    domain: string;
    postgres: {
        sharedBuffers: string;
        effectiveCache: string;
        workMem: string;
        maintenanceMem: string;
        maxParallelWorkers: number;
        randomPageCost: number;
        effectiveIoConcurrency: number;
        maxConnections: number;
    };
    redis: {
        maxMemory: string;
    };
    security: {
        hstsMaxAge: number;
        hstsPreload: boolean;
        allowIframeEmbedding: boolean;
        rateLimitGlobalRps: number;
        loginLockoutAttempts: number;
        loginLockoutDurationMin: number;
        sessionTimeoutMin: number;
        csrfTokenLifetimeMin: number;
        jwtAccessTokenLifetimeMin: number;
        jwtRefreshTokenLifetimeDays: number;
        keyRotationOverlapHours: number;
        cspExtraScriptSrc: string[];
        cspExtraStyleSrc: string[];
        cspExtraImgSrc: string[];
        cspExtraFontSrc: string[];
        cspExtraConnectSrc: string[];
        iframeAllowedOrigins: string[];
    };
    backup: {
        schedule: string;
        retentionDays: number;
        walRetentionDays: number;
        drDrillSchedule: string;
        offsiteEnabled: boolean;
    };
    observability: {
        slowQueryThresholdMs: number;
        logRetentionDays: number;
        alertP99LatencyMs: number;
        alertErrorRatePercent: number;
        alertDiskUsagePercent: number;
    };
}, {
    email: string;
    domain: string;
    postgres: {
        sharedBuffers: string;
        effectiveCache: string;
        workMem: string;
        maintenanceMem: string;
        maxParallelWorkers: number;
        randomPageCost: number;
        effectiveIoConcurrency: number;
        maxConnections?: number | undefined;
    };
    redis: {
        maxMemory: string;
    };
    security: {
        hstsMaxAge?: number | undefined;
        hstsPreload?: boolean | undefined;
        allowIframeEmbedding?: boolean | undefined;
        rateLimitGlobalRps?: number | undefined;
        loginLockoutAttempts?: number | undefined;
        loginLockoutDurationMin?: number | undefined;
        sessionTimeoutMin?: number | undefined;
        csrfTokenLifetimeMin?: number | undefined;
        jwtAccessTokenLifetimeMin?: number | undefined;
        jwtRefreshTokenLifetimeDays?: number | undefined;
        keyRotationOverlapHours?: number | undefined;
        cspExtraScriptSrc?: string[] | undefined;
        cspExtraStyleSrc?: string[] | undefined;
        cspExtraImgSrc?: string[] | undefined;
        cspExtraFontSrc?: string[] | undefined;
        cspExtraConnectSrc?: string[] | undefined;
        iframeAllowedOrigins?: string[] | undefined;
    };
    backup: {
        schedule?: string | undefined;
        retentionDays?: number | undefined;
        walRetentionDays?: number | undefined;
        drDrillSchedule?: string | undefined;
        offsiteEnabled?: boolean | undefined;
    };
    observability: {
        slowQueryThresholdMs?: number | undefined;
        logRetentionDays?: number | undefined;
        alertP99LatencyMs?: number | undefined;
        alertErrorRatePercent?: number | undefined;
        alertDiskUsagePercent?: number | undefined;
    };
}>;
export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
//# sourceMappingURL=schema.d.ts.map