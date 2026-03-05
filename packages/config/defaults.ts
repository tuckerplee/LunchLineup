import { PlatformConfig } from './schema';

export interface SystemEnvironment {
    totalMemoryGB: number;
    cpuCores: number;
    storageType: 'nvme' | 'ssd' | 'hdd';
}

export function computeDefaults(env: SystemEnvironment): Partial<PlatformConfig> {
    return {
        postgres: {
            sharedBuffers: Math.floor(env.totalMemoryGB * 0.25) + 'GB',
            effectiveCache: Math.floor(env.totalMemoryGB * 0.75) + 'GB',
            workMem: Math.floor((env.totalMemoryGB * 1024) / (env.cpuCores * 4)) + 'MB',
            maintenanceMem: Math.min(Math.floor(env.totalMemoryGB * 0.03125), 2) + 'GB',
            maxParallelWorkers: Math.min(env.cpuCores - 2, 8),
            randomPageCost: env.storageType === 'nvme' ? 1.1 : 4.0,
            effectiveIoConcurrency: env.storageType === 'nvme' ? 200 : 2,
            maxConnections: 200,
        },
        redis: {
            maxMemory: Math.floor(env.totalMemoryGB * 0.10) + 'GB',
        },
        security: {
            rateLimitGlobalRps: 100,
            loginLockoutAttempts: 5,
            loginLockoutDurationMin: 15,
            sessionTimeoutMin: 30,
            csrfTokenLifetimeMin: 60,
            jwtAccessTokenLifetimeMin: 15,
            jwtRefreshTokenLifetimeDays: 7,
            keyRotationOverlapHours: 24,
            hstsMaxAge: 63072000,
            hstsPreload: true,
            allowIframeEmbedding: false,
            cspExtraScriptSrc: [],
            cspExtraStyleSrc: [],
            cspExtraImgSrc: [],
            cspExtraFontSrc: [],
            cspExtraConnectSrc: [],
            iframeAllowedOrigins: [],
        },
        backup: {
            schedule: '0 3 * * *',
            retentionDays: 90,
            walRetentionDays: 30,
            drDrillSchedule: '0 4 1 * *',
            offsiteEnabled: true,
        },
        observability: {
            slowQueryThresholdMs: 100,
            logRetentionDays: 30,
            alertP99LatencyMs: 1000,
            alertErrorRatePercent: 2,
            alertDiskUsagePercent: 85,
        },
    };
}
