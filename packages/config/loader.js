"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigLoader = void 0;
const schema_1 = require("./schema");
const defaults_1 = require("./defaults");
class ConfigLoader {
    env;
    config = null;
    constructor(env) {
        this.env = env;
    }
    async loadConfig(overrides = {}) {
        const defaults = (0, defaults_1.computeDefaults)(this.env);
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
        const validatedConfig = schema_1.PlatformConfigSchema.parse(mergedConfig);
        this.config = validatedConfig;
        return validatedConfig;
    }
    getConfig() {
        if (!this.config) {
            throw new Error('Config not loaded. Call loadConfig() first.');
        }
        return this.config;
    }
}
exports.ConfigLoader = ConfigLoader;
//# sourceMappingURL=loader.js.map