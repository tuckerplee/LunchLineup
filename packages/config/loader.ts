import { PlatformConfig, PlatformConfigSchema } from './schema';
import { computeDefaults, SystemEnvironment } from './defaults';

export class ConfigLoader {
    private config: PlatformConfig | null = null;

    constructor(private env: SystemEnvironment) { }

    public async loadConfig(overrides: Partial<PlatformConfig> = {}): Promise<PlatformConfig> {
        const defaults = computeDefaults(this.env);

        // In a real implementation, this would also merge values from:
        // 1. Environment variables
        // 2. Database (platform_config table)
        // 3. Vault/Secrets management

        const mergedConfig = {
            ...defaults,
            ...overrides,
            // Ensure domain and email are provided as they are required in schema
            domain: overrides.domain || process.env.APP_DOMAIN || 'localhost',
            email: overrides.email || process.env.ADMIN_EMAIL || 'admin@example.com',
        };

        const validatedConfig = PlatformConfigSchema.parse(mergedConfig);
        this.config = validatedConfig;
        return validatedConfig;
    }

    public getConfig(): PlatformConfig {
        if (!this.config) {
            throw new Error('Config not loaded. Call loadConfig() first.');
        }
        return this.config;
    }
}
