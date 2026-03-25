import { PlatformConfig } from './schema';
import { SystemEnvironment } from './defaults';
export declare class ConfigLoader {
    private env;
    private config;
    constructor(env: SystemEnvironment);
    loadConfig(overrides?: Partial<PlatformConfig>): Promise<PlatformConfig>;
    getConfig(): PlatformConfig;
}
//# sourceMappingURL=loader.d.ts.map