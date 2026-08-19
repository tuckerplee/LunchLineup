import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/branding/LunchLineupMark', () => ({
  LunchLineupMark: () => null,
}));

import { deriveIncidentState } from '../../app/status/page';
import {
  readApiHealth,
  resolveApiHealthUrl,
  type HealthProbe,
} from '../../app/status/health';

afterEach(() => {
  vi.unstubAllGlobals();
});

function probe(status: HealthProbe['status']): HealthProbe {
  return {
    status,
    label: status === 'degraded'
      ? 'API health degraded'
      : status === 'unavailable'
        ? 'API health unavailable'
        : 'API health passing',
    detail: status + ' probe detail',
    checkedAt: new Date('2026-07-12T12:00:00.000Z'),
    latencyMs: 10,
    httpStatus: status === 'unavailable' ? null : 200,
    payload: null,
  };
}

describe('status health URL resolution', () => {
  it('uses the explicit status health URL when configured', () => {
    expect(resolveApiHealthUrl({
      LUNCHLINEUP_STATUS_HEALTH_URL: 'https://status.example.test/healthz',
      INTERNAL_API_V2_URL: 'http://api-v2:3002/v2',
    })).toBe('https://status.example.test/healthz');
  });

  it('maps the internal v2 base to its explicit readiness endpoint', () => {
    expect(resolveApiHealthUrl({ INTERNAL_API_V2_URL: 'http://api-v2:3002/v2' })).toBe('http://api-v2:3002/v2/ready');
  });

  it('keeps the v2 prefix while appending readiness', () => {
    expect(resolveApiHealthUrl({ INTERNAL_API_V2_URL: 'http://proxy/api/v2/' })).toBe('http://proxy/api/v2/ready');
  });

  it('does not substitute an internal endpoint when production configuration is missing', () => {
    expect(resolveApiHealthUrl({
      NODE_ENV: 'production',
      INTERNAL_API_V2_URL: 'http://api-v2:3002/v2',
    })).toBeNull();
  });

  it('returns a neutral production configuration signal without fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const result = await readApiHealth({
      NODE_ENV: 'production',
      INTERNAL_API_V2_URL: 'http://api-v2:3002/v2',
    });

    expect(result).toMatchObject({
      status: 'not_configured',
      label: 'API health not configured',
      latencyMs: null,
      httpStatus: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe('status health response validation', () => {
  it.each([200, 401, 403, 404, 429])(
    'treats malformed HTTP %i health responses as degraded',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
        status === 200 ? JSON.stringify({ status: 'ok' }) : 'blocked',
        {
          status,
          headers: {
            'content-type': status === 200 ? 'application/json' : 'text/plain',
          },
        },
      )));

      const result = await readApiHealth();

      expect(result).toMatchObject({
        status: 'degraded',
        label: 'API health degraded',
        httpStatus: status,
        payload: null,
      });
      expect(deriveIncidentState(result)).toMatchObject({
        activeCount: 0,
        heading: 'No active incidents',
      });
    },
  );
});
describe('status incident derivation', () => {
  it('keeps the healthy incident-history message when checks pass', () => {
    expect(deriveIncidentState(probe('ok'))).toEqual({
      activeCount: 0,
      heading: 'No active incidents',
      detail: 'Automated health signals are shown separately; incident history is published only from the reviewed incident log.',
      detectedAt: null,
    });
  });

  it('does not turn a reachable partial signal into an active incident', () => {
    expect(deriveIncidentState(probe('reachable'))).toMatchObject({
      activeCount: 0,
      heading: 'No active incidents',
    });
  });

  it.each(['degraded', 'unavailable'] as const)('keeps %s automated health separate from incident history', (status) => {
    expect(deriveIncidentState(probe(status))).toMatchObject({
      activeCount: 0,
      heading: 'No active incidents',
      detectedAt: null,
    });
  });
});
