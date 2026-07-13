import { describe, expect, it } from 'vitest';
import { resolveTelemetryConfig } from './telemetry';

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
