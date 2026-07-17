import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { redactUrlForLog } from './sensitive-redaction';

export interface TelemetryConfig {
    endpoint: string;
    serviceName: string;
    environment: string;
}

export function querySafeHttpSpanAttributes(request: { path?: string | null; url?: string | null }): Record<string, string> {
    const rawUrl = typeof request.url === 'string'
        ? request.url
        : typeof request.path === 'string'
            ? request.path
            : '/';
    const queryIndex = rawUrl.indexOf('?');
    const sanitizedUrl = redactUrlForLog(rawUrl) || '/';

    return {
        'http.target': sanitizedUrl,
        'http.url': sanitizedUrl,
        'url.full': sanitizedUrl,
        'url.query': queryIndex >= 0 ? '[REDACTED]' : '',
    };
}

export function resolveTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig | null {
    const endpoint = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
    if (!endpoint) {
        return null;
    }

    let parsed: URL;
    try {
        parsed = new URL(endpoint);
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return null;
    }

    return {
        endpoint: parsed.toString(),
        serviceName: env.OTEL_SERVICE_NAME?.trim() || 'lunchlineup-api',
        environment: env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || 'development',
    };
}

let sdk: NodeSDK | null = null;

export function startApiTracing(env: NodeJS.ProcessEnv = process.env): boolean {
    if (sdk) {
        return true;
    }
    const config = resolveTelemetryConfig(env);
    if (!config) {
        return false;
    }

    sdk = new NodeSDK({
        resource: resourceFromAttributes({
            'service.name': config.serviceName,
            'deployment.environment.name': config.environment,
        }),
        traceExporter: new OTLPTraceExporter({ url: config.endpoint }),
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-dns': { enabled: false },
                '@opentelemetry/instrumentation-fs': { enabled: false },
                '@opentelemetry/instrumentation-http': {
                    startIncomingSpanHook: querySafeHttpSpanAttributes,
                    startOutgoingSpanHook: querySafeHttpSpanAttributes,
                },
                '@opentelemetry/instrumentation-net': { enabled: false },
                '@opentelemetry/instrumentation-undici': {
                    startSpanHook: querySafeHttpSpanAttributes,
                },
            }),
        ],
    });
    sdk.start();
    process.once('beforeExit', () => {
        void sdk?.shutdown();
    });
    return true;
}

startApiTracing();
