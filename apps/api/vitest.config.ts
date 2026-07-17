import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        globals: true,
        environment: 'node',
        env: {
            PLATFORM_ADMIN_DB_CONTEXT_SECRET:
                process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET
                ?? 'unit-test-platform-admin-capability',
        },
        include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
        exclude: ['node_modules', 'dist'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/main.ts'],
            thresholds: {
                lines: 40,
                functions: 38,
                branches: 34,
                statements: 39,
            },
        },
    },
});
