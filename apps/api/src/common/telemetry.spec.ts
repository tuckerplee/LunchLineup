import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { querySafeHttpSpanAttributes, resolveTelemetryConfig } from './telemetry';

describe('API telemetry configuration', () => {
    it('stays disabled when no OTLP endpoint is configured', () => {
        expect(resolveTelemetryConfig({})).toBeNull();
    });

    it('uses an explicit traces endpoint and bounded service metadata', () => {
        expect(resolveTelemetryConfig({
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://otel-collector:4318/v1/traces',
            OTEL_SERVICE_NAME: 'lunchlineup-api',
            OTEL_DEPLOYMENT_ENVIRONMENT: 'production',
        })).toEqual({
            endpoint: 'http://otel-collector:4318/v1/traces',
            serviceName: 'lunchlineup-api',
            environment: 'production',
        });
    });

    it('rejects non-HTTP exporter endpoints', () => {
        expect(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'file:///tmp/traces' })).toBeNull();
    });
});

describe('API telemetry HTTP URL redaction', () => {
    it('removes inbound OIDC query credentials before creating a span', () => {
        expect(querySafeHttpSpanAttributes({ url: '/api/v1/auth/oidc/callback?code=secret&state=csrf' })).toEqual({
            'http.target': '/api/v1/auth/oidc/callback',
            'http.url': '/api/v1/auth/oidc/callback',
            'url.full': '/api/v1/auth/oidc/callback',
            'url.query': '[REDACTED]',
        });
    });

    it('removes outbound query strings and fragments', () => {
        expect(querySafeHttpSpanAttributes({ url: 'https://idp.example/token?client_secret=secret#ignored' })).toEqual({
            'http.target': 'https://idp.example/token',
            'http.url': 'https://idp.example/token',
            'url.full': 'https://idp.example/token',
            'url.query': '[REDACTED]',
        });
    });
    it('removes embedded URL credentials before creating a span', () => {
        const attributes = querySafeHttpSpanAttributes({
            url: 'https://trace-user:trace-secret@idp.example/token?client_secret=query-secret',
        });

        expect(attributes['http.url']).toBe('https://idp.example/token');
        expect(JSON.stringify(attributes)).not.toContain('trace-user');
        expect(JSON.stringify(attributes)).not.toContain('trace-secret');
        expect(JSON.stringify(attributes)).not.toContain('query-secret');
    });

    it('applies query redaction to Node HTTP and fetch spans', () => {
        const source = readFileSync(resolve(process.cwd(), 'src/common/telemetry.ts'), 'utf8');
        expect(source).toMatch(/'@opentelemetry\/instrumentation-http'[\s\S]*startOutgoingSpanHook: querySafeHttpSpanAttributes/);
        expect(source).toMatch(/'@opentelemetry\/instrumentation-undici'[\s\S]*startSpanHook: querySafeHttpSpanAttributes/);
    });
});
