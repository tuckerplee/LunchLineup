import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Docker, { ContainerInfo } from 'dockerode';
import express, { NextFunction, Request, Response } from 'express';

type PlatformStatus = 'RUNNING' | 'DEGRADED' | 'UNKNOWN';
type ServiceState = 'ONLINE' | 'DEGRADED' | 'UNHEALTHY' | 'STOPPED' | 'MISSING' | 'UNKNOWN';
type StatusSource = 'docker' | 'disabled' | 'fallback';

export interface RuntimeConfig {
    host: string;
    port: number;
    expectedServices: string[];
    adminToken?: string;
    metricsToken?: string;
    requireAdminToken: boolean;
    requireMetricsToken: boolean;
    dockerStatusEnabled: boolean;
    dockerSocketPath?: string;
}

export interface DockerStatusClient {
    listContainers(options: { all: boolean }): Promise<ContainerInfo[]>;
}

interface ServiceStatus {
    name: string;
    status: ServiceState;
    containers: number;
    onlineContainers: number;
    detail?: string;
}

interface StatusPayload {
    status: PlatformStatus;
    observedAt: string;
    source: StatusSource;
    services: ServiceStatus[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
    const adminToken = readToken(env, 'CONTROL_PLANE_ADMIN_TOKEN', 'CONTROL_PLANE_ADMIN_TOKEN_FILE')
        ?? normalizeToken(env.CONTROL_PLANE_PASSWORD);
    const metricsToken = readToken(env, 'CONTROL_PLANE_METRICS_TOKEN', 'CONTROL_PLANE_METRICS_TOKEN_FILE');
    const requireAdminToken = env.NODE_ENV === 'production'
        || env.CONTROL_PLANE_REQUIRE_ADMIN_TOKEN === 'true'
        || Boolean(adminToken);
    const requireMetricsToken = env.NODE_ENV === 'production'
        || env.CONTROL_PLANE_REQUIRE_METRICS_TOKEN === 'true'
        || Boolean(metricsToken);
    const dockerStatusEnabled = env.CONTROL_PLANE_DOCKER_STATUS === 'enabled'
        || env.CONTROL_PLANE_DOCKER_STATUS === 'true';
    const dockerSocketPath = normalizeToken(env.CONTROL_PLANE_DOCKER_SOCKET_PATH ?? env.DOCKER_SOCKET_PATH);

    if (requireAdminToken && !adminToken) {
        throw new Error('CONTROL_PLANE_ADMIN_TOKEN or CONTROL_PLANE_ADMIN_TOKEN_FILE is required');
    }
    if (requireMetricsToken && !metricsToken) {
        throw new Error('CONTROL_PLANE_METRICS_TOKEN or CONTROL_PLANE_METRICS_TOKEN_FILE is required');
    }
    if (dockerStatusEnabled && !dockerSocketPath) {
        throw new Error('CONTROL_PLANE_DOCKER_SOCKET_PATH is required when CONTROL_PLANE_DOCKER_STATUS is enabled');
    }

    return {
        host: env.CONTROL_PLANE_HOST ?? '127.0.0.1',
        port: parsePort(env.CONTROL_PLANE_PORT, 3001),
        expectedServices: parseExpectedServices(env.CONTROL_PLANE_EXPECTED_SERVICES),
        adminToken,
        metricsToken,
        requireAdminToken,
        requireMetricsToken,
        dockerStatusEnabled,
        dockerSocketPath,
    };
}

export function createApp(config: RuntimeConfig, docker?: DockerStatusClient) {
    const app = express();
    const startedAt = Date.now();
    const dockerClient = config.dockerStatusEnabled
        ? docker ?? new Docker({ socketPath: config.dockerSocketPath })
        : undefined;

    app.disable('x-powered-by');
    app.use(express.json({ limit: process.env.CONTROL_PLANE_JSON_LIMIT ?? '32kb' }));
    app.use(securityHeaders);
    app.use('/api/status', requireAdminToken(config));
    app.use('/api/control', requireAdminToken(config));
    app.use('/api/metrics', requireMetricsToken(config));

    app.get('/api/status', async (_req: Request, res: Response) => {
        res.json(await collectStatus(dockerClient, config.expectedServices));
    });

    app.get('/api/health', (_req: Request, res: Response) => {
        res.json({ status: 'healthy', service: 'control-plane' });
    });

    app.get('/api/metrics', async (_req: Request, res: Response) => {
        const uptimeSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        const status = await collectStatus(dockerClient, config.expectedServices);
        res.type('text/plain; version=0.0.4; charset=utf-8').send([
            '# HELP lunchlineup_control_plane_up Control plane process health.',
            '# TYPE lunchlineup_control_plane_up gauge',
            'lunchlineup_control_plane_up 1',
            '# HELP lunchlineup_control_plane_uptime_seconds Control plane process uptime.',
            '# TYPE lunchlineup_control_plane_uptime_seconds gauge',
            `lunchlineup_control_plane_uptime_seconds ${uptimeSeconds}`,
            '# HELP lunchlineup_control_plane_docker_available Docker socket status collection availability.',
            '# TYPE lunchlineup_control_plane_docker_available gauge',
            `lunchlineup_control_plane_docker_available ${status.source === 'docker' ? 1 : 0}`,
            '# HELP lunchlineup_control_plane_service_up Expected Compose service health from Docker.',
            '# TYPE lunchlineup_control_plane_service_up gauge',
            ...status.services.map((service) => (
                `lunchlineup_control_plane_service_up{service="${escapeLabel(service.name)}"} ${service.status === 'ONLINE' ? 1 : 0}`
            )),
            '',
        ].join('\n'));
    });

    app.use((_req: Request, res: Response) => {
        res.status(404).json({ error: 'not_found' });
    });

    app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
        console.error('Control plane request failed category=unknown');
        res.status(500).json({ error: 'internal_error' });
    });

    return app;
}

if (require.main === module) {
    const config = loadConfig();
    const app = createApp(config);
    app.listen(config.port, config.host, () => {
        console.log(`Control Plane listening on ${config.host}:${config.port}`);
    });
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
}

function requireAdminToken(config: RuntimeConfig) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!config.requireAdminToken) {
            next();
            return;
        }

        const suppliedToken = parseBearerToken(req.get('authorization')) ?? req.get('x-control-plane-admin-token');
        if (!tokensMatch(suppliedToken, config.adminToken)) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="control-plane"');
            res.status(401).json({ error: 'unauthorized' });
            return;
        }

        next();
    };
}

function requireMetricsToken(config: RuntimeConfig) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!config.requireMetricsToken) {
            next();
            return;
        }

        const suppliedToken = parseBearerToken(req.get('authorization')) ?? req.get('x-control-plane-metrics-token');
        if (!tokensMatch(suppliedToken, config.metricsToken)) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="control-plane-metrics"');
            res.status(401).json({ error: 'unauthorized' });
            return;
        }

        next();
    };
}

function parsePort(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return fallback;
    }
    return parsed;
}

async function collectStatus(docker: DockerStatusClient | undefined, expectedServices: string[]): Promise<StatusPayload> {
    const observedAt = new Date().toISOString();

    if (!docker) {
        return {
            status: 'UNKNOWN',
            observedAt,
            source: 'disabled',
            services: expectedServices.map((name) => ({
                name,
                status: 'UNKNOWN',
                containers: 0,
                onlineContainers: 0,
                detail: 'docker_status_disabled',
            })),
        };
    }

    try {
        const containers = await docker.listContainers({ all: true });
        const services = expectedServices.map((service) => describeService(service, containers));
        return {
            status: services.every((service) => service.status === 'ONLINE') ? 'RUNNING' : 'DEGRADED',
            observedAt,
            source: 'docker',
            services,
        };
    } catch {
        return {
            status: 'UNKNOWN',
            observedAt,
            source: 'fallback',
            services: expectedServices.map((name) => ({
                name,
                status: 'UNKNOWN',
                containers: 0,
                onlineContainers: 0,
                detail: 'docker_unavailable',
            })),
        };
    }
}

function describeService(name: string, containers: ContainerInfo[]): ServiceStatus {
    const matches = containers.filter((container) => {
        const labels = container.Labels ?? {};
        return labels['com.docker.compose.service'] === name;
    });

    if (matches.length === 0) {
        return {
            name,
            status: 'MISSING',
            containers: 0,
            onlineContainers: 0,
            detail: 'no_compose_container',
        };
    }

    const states = matches.map(containerHealth);
    const onlineContainers = states.filter((state) => state === 'ONLINE').length;
    const status = summarizeStates(states);

    return {
        name,
        status,
        containers: matches.length,
        onlineContainers,
        detail: `${onlineContainers}/${matches.length} containers online`,
    };
}

function containerHealth(container: ContainerInfo): ServiceState {
    const status = (container.Status ?? '').toLowerCase();
    if (status.includes('unhealthy')) {
        return 'UNHEALTHY';
    }
    if (container.State === 'running') {
        return 'ONLINE';
    }
    if (['created', 'exited', 'dead', 'removing'].includes(container.State)) {
        return 'STOPPED';
    }
    return 'UNKNOWN';
}

function summarizeStates(states: ServiceState[]): ServiceState {
    if (states.every((state) => state === 'ONLINE')) {
        return 'ONLINE';
    }
    if (states.some((state) => state === 'ONLINE')) {
        return 'DEGRADED';
    }
    if (states.some((state) => state === 'UNHEALTHY')) {
        return 'UNHEALTHY';
    }
    if (states.every((state) => state === 'STOPPED')) {
        return 'STOPPED';
    }
    return 'UNKNOWN';
}

function parseExpectedServices(value: string | undefined): string[] {
    const configured = (value ?? '')
        .split(',')
        .map((service) => service.trim())
        .filter(Boolean);

    if (configured.length > 0) {
        return configured;
    }

    return [
        'proxy',
        'web',
        'api',
        'api-v2',
        'worker',
        'engine',
        'postgres',
        'redis',
        'rabbitmq',
        'control',
        'prometheus',
        'node-exporter',
        'grafana',
        'loki',
        'tempo',
        'autoheal',
    ];
}

function readToken(env: NodeJS.ProcessEnv, valueKey: string, fileKey: string): string | undefined {
    const filePath = env[fileKey];
    if (filePath) {
        return normalizeToken(readFileSync(filePath, 'utf8'));
    }

    return normalizeToken(env[valueKey]);
}

function normalizeToken(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function parseBearerToken(header: string | undefined): string | undefined {
    if (!header) {
        return undefined;
    }

    const [scheme, ...parts] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || parts.length !== 1) {
        return undefined;
    }

    return parts[0];
}

function tokensMatch(candidate: string | undefined, expected: string | undefined): boolean {
    if (!candidate || !expected) {
        return false;
    }

    const candidateBuffer = Buffer.from(candidate);
    const expectedBuffer = Buffer.from(expected);
    if (candidateBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
