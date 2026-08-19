import { readBoundedJson, withRequestTimeout } from '../../lib/http-safety';

export const INCIDENT_REVIEW_DATE = 'July 9, 2026';

const HEALTH_PROBE_TIMEOUT_MS = 1200;
const HEALTH_RESPONSE_LIMIT_BYTES = 64 * 1024;

type HealthStatus = 'ok' | 'degraded';
export type DependencyStatus = 'online' | 'offline' | 'unknown';
export type Tone = 'success' | 'warn' | 'danger' | 'info';

export type ApiHealthCheck = {
  name: string;
  status: DependencyStatus;
  latencyMs: number | null;
  details: string | null;
};

type ApiHealthPayload = {
  status: HealthStatus;
  timestamp: string | null;
  checks: ApiHealthCheck[];
};

export type HealthProbe = {
  status: HealthStatus | 'reachable' | 'unavailable' | 'not_configured';
  label: string;
  detail: string;
  checkedAt: Date;
  latencyMs: number | null;
  httpStatus: number | null;
  payload: ApiHealthPayload | null;
};

export type StatusComponent = {
  name: string;
  detail: string;
  state: string;
  tone: Tone;
  source: string;
};

const MANUAL_COMPONENTS: StatusComponent[] = [
  {
    name: 'Public web app',
    detail: 'Marketing, login, onboarding, privacy, security, and status pages render through this public app.',
    state: 'Operational',
    tone: 'success',
    source: 'Automated server render',
  },
  {
    name: 'Tenant dashboard',
    detail: 'Authenticated scheduling, staff, locations, settings, and time-card workspaces.',
    state: 'Not checked',
    tone: 'info',
    source: 'Manual beta review',
  },
  {
    name: 'Scheduling engine',
    detail: 'Lunch and break planning services for generated schedule recommendations.',
    state: 'Not checked',
    tone: 'info',
    source: 'Docker healthcheck, not public probe',
  },
  {
    name: 'Background workers',
    detail: 'Import parsing, notifications, webhooks, and asynchronous maintenance jobs.',
    state: 'Not checked',
    tone: 'info',
    source: 'Docker healthcheck, not public probe',
  },
];

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function stripVersionSuffix(value: string): string {
  return value.replace(/\/v\d+$/i, '');
}

export function resolveApiHealthUrl(env: Partial<NodeJS.ProcessEnv> = process.env): string | null {
  const explicit = env.LUNCHLINEUP_STATUS_HEALTH_URL?.trim();
  if (explicit) return explicit;
  if (env.NODE_ENV === 'production') return null;

  const internalApiV2Url = env.INTERNAL_API_V2_URL ?? 'http://api-v2:3002/v2';
  return `${trimTrailingSlash(internalApiV2Url)}/ready`;
}

function normalizeHealthPayload(value: unknown): ApiHealthPayload | null {
  if (!value || typeof value !== 'object') return null;

  const source = value as {
    status?: unknown;
    timestamp?: unknown;
    checks?: unknown;
  };

  const status = source.status === 'ok' ? 'ok' : source.status === 'degraded' ? 'degraded' : null;
  if (!status) return null;
  const timestamp = typeof source.timestamp === 'string'
    && Number.isFinite(Date.parse(source.timestamp))
    ? source.timestamp
    : null;
  if (!timestamp || !Array.isArray(source.checks) || source.checks.length === 0) return null;

  const normalizedChecks = source.checks.map((entry): ApiHealthCheck | null => {
      if (!entry || typeof entry !== 'object') return null;
      const check = entry as {
        name?: unknown;
        status?: unknown;
        latencyMs?: unknown;
        details?: unknown;
      };
      const name = typeof check.name === 'string' && check.name.trim() ? check.name.trim() : null;
      const dependencyStatus = check.status === 'online'
        ? 'online'
        : check.status === 'offline'
          ? 'offline'
          : null;
      const latencyMs = typeof check.latencyMs === 'number'
        && Number.isFinite(check.latencyMs)
        && check.latencyMs >= 0
        ? check.latencyMs
        : null;
      if (!name || !dependencyStatus || latencyMs === null || typeof check.details !== 'string') {
        return null;
      }

      return {
        name,
        status: dependencyStatus,
        latencyMs,
        details: check.details,
      };
    });
  if (normalizedChecks.some((check) => check === null)) return null;
  const checks = normalizedChecks as ApiHealthCheck[];

  return {
    status,
    timestamp,
    checks,
  };
}

export async function readApiHealth(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): Promise<HealthProbe> {
  const checkedAt = new Date();
  const startedAt = Date.now();
  const healthUrl = resolveApiHealthUrl(env);
  if (!healthUrl) {
    return {
      status: 'not_configured',
      label: 'API health not configured',
      detail: 'The public API health probe is not configured for this production web runtime.',
      checkedAt,
      latencyMs: null,
      httpStatus: null,
      payload: null,
    };
  }
  try {
    const { response, body } = await withRequestTimeout(async (signal) => {
      const response = await fetch(healthUrl, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      const contentType = response.headers.get('content-type') ?? '';
      const body = contentType.toLowerCase().includes('application/json')
        ? await readBoundedJson(response, HEALTH_RESPONSE_LIMIT_BYTES).catch(() => null)
        : null;
      if (body === null) await response.body?.cancel().catch(() => undefined);
      return { response, body };
    }, HEALTH_PROBE_TIMEOUT_MS);
    const latencyMs = Date.now() - startedAt;
    const payload = normalizeHealthPayload(body);

    if (payload) {
      const degraded = payload.status !== 'ok' || !response.ok;
      return {
        status: degraded ? 'degraded' : 'ok',
        label: degraded ? 'API health degraded' : 'API health passing',
        detail: degraded
          ? 'The configured API health endpoint responded with one or more unhealthy dependency checks.'
          : 'The configured API health endpoint responded and all reported dependency checks are online.',
        checkedAt,
        latencyMs,
        httpStatus: response.status,
        payload,
      };
    }

    return {
      status: 'degraded',
      label: 'API health degraded',
      detail: `The configured API health endpoint returned an invalid dependency report. HTTP ${response.status}.`,
      checkedAt,
      latencyMs,
      httpStatus: response.status,
      payload: null,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      status: 'unavailable',
      label: 'API health unavailable',
      detail: timedOut
        ? `The API health probe did not finish within ${HEALTH_PROBE_TIMEOUT_MS} ms.`
        : 'The API health probe could not reach the configured endpoint from the web server.',
      checkedAt,
      latencyMs: Date.now() - startedAt,
      httpStatus: null,
      payload: null,
    };
  }
}

function probeTone(status: HealthProbe['status']): Tone {
  if (status === 'ok') return 'success';
  if (status === 'reachable' || status === 'not_configured') return 'info';
  if (status === 'degraded') return 'warn';
  return 'danger';
}

export function dependencyTone(status: DependencyStatus): Tone {
  if (status === 'online') return 'success';
  if (status === 'offline') return 'danger';
  return 'info';
}

export function badgeClass(tone: Tone): string {
  if (tone === 'success') return 'badge badge-success';
  if (tone === 'warn') return 'badge badge-warn';
  if (tone === 'danger') return 'badge badge-danger';
  return 'badge badge-info';
}

export function formatDateTime(date: Date): string {
  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date)}`;
}

export function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? 'No response' : `${latencyMs} ms`;
}

export function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function apiComponent(probe: HealthProbe): StatusComponent {
  const tone = probeTone(probe.status);
  const state = probe.status === 'ok'
    ? 'Operational'
    : probe.status === 'reachable'
      ? 'Reachable'
      : probe.status === 'not_configured'
        ? 'Not configured'
      : probe.status === 'degraded'
        ? 'Degraded'
        : 'Unavailable';

  return {
    name: 'API gateway',
    detail: probe.detail,
    state,
    tone,
    source: probe.status === 'not_configured'
      ? 'Runtime configuration'
      : probe.payload
        ? 'GET /health dependency report'
        : 'GET /health reachability probe',
  };
}

function dataStoreComponent(probe: HealthProbe): StatusComponent {
  const checks = probe.payload?.checks ?? [];
  const dataChecks = checks.filter((check) => /database|postgres|redis|cache/i.test(check.name));

  if (dataChecks.length === 0) {
    return {
      name: 'Data stores',
      detail: 'Primary database and cache checks are shown when the API health payload includes dependency results.',
      state: probe.payload ? 'Not checked' : 'Unknown',
      tone: 'info',
      source: 'Awaiting API dependency payload',
    };
  }

  const offlineCount = dataChecks.filter((check) => check.status !== 'online').length;
  return {
    name: 'Data stores',
    detail: dataChecks
      .map((check) => `${titleCase(check.name)} ${check.status}${check.latencyMs === null ? '' : ` in ${check.latencyMs} ms`}`)
      .join('; '),
    state: offlineCount === 0 ? 'Operational' : 'Degraded',
    tone: offlineCount === 0 ? 'success' : 'danger',
    source: 'API health dependency checks',
  };
}

export function statusComponents(probe: HealthProbe): StatusComponent[] {
  return [
    MANUAL_COMPONENTS[0],
    apiComponent(probe),
    ...MANUAL_COMPONENTS.slice(1),
    dataStoreComponent(probe),
  ];
}

export function summaryCopy(probe: HealthProbe): { heading: string; copy: string; label: string; tone: Tone } {
  if (probe.status === 'ok') {
    return {
      heading: 'Automated health checks passing',
      copy: 'This page rendered successfully and the configured API health endpoint reports its dependencies online.',
      label: 'Operational',
      tone: 'success',
    };
  }

  if (probe.status === 'reachable') {
    return {
      heading: 'Public page online; API reachable',
      copy: 'The public status page rendered and reached the API, but dependency-level health was not available from this environment.',
      label: 'Partial signal',
      tone: 'info',
    };
  }

  if (probe.status === 'not_configured') {
    return {
      heading: 'Public page online; API health not configured',
      copy: 'The public status page rendered, but this web runtime has no configured public API health endpoint.',
      label: 'Not configured',
      tone: 'info',
    };
  }

  if (probe.status === 'degraded') {
    return {
      heading: 'Automated checks need attention',
      copy: 'The public status page rendered, but the API health probe reported a degraded or unexpected response.',
      label: 'Degraded',
      tone: 'warn',
    };
  }

  return {
    heading: 'Public page online; API health unavailable',
    copy: 'The status page rendered, but the web server could not complete the API health probe within the configured timeout.',
    label: 'Needs review',
    tone: 'danger',
  };
}
