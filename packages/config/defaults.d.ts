import { PlatformConfig } from './schema';
export interface SystemEnvironment {
    totalMemoryGB: number;
    cpuCores: number;
    storageType: 'nvme' | 'ssd' | 'hdd';
}
export declare function computeDefaults(env: SystemEnvironment): Partial<PlatformConfig>;
//# sourceMappingURL=defaults.d.ts.map