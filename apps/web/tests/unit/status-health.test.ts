import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/branding/LunchLineupMark', () => ({
  LunchLineupMark: () => null,
}));

import { deriveIncidentState } from '../../app/status/page';
import { resolveApiHealthUrl, type HealthProbe } from '../../app/status/health';

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
      INTERNAL_API_URL: 'http://api:3000/v1',
    })).toBe('https://status.example.test/healthz');
  });

  it('maps an internal versioned API base to the unversioned health endpoint', () => {
    expect(resolveApiHealthUrl({ INTERNAL_API_URL: 'http://api:3000/v1' })).toBe('http://api:3000/health');
  });

  it('keeps proxy prefixes while dropping only the URI-version suffix', () => {
    expect(resolveApiHealthUrl({ INTERNAL_API_URL: 'http://proxy/api/v1/' })).toBe('http://proxy/api/health');
  });
});
describe('status incident derivation', () => {
  it('keeps the healthy incident-history message when checks pass', () => {
    expect(deriveIncidentState(probe('ok'))).toEqual({
      activeCount: 0,
      heading: 'No active incidents',
      detail: 'Automated web/API health signals added to the public beta status page.',
      detectedAt: null,
    });
  });

  it('does not turn a reachable partial signal into an active incident', () => {
    expect(deriveIncidentState(probe('reachable'))).toMatchObject({
      activeCount: 0,
      heading: 'No active incidents',
    });
  });

  it.each(['degraded', 'unavailable'] as const)('reports %s health as an active incident', (status) => {
    const healthProbe = probe(status);

    expect(deriveIncidentState(healthProbe)).toEqual({
      activeCount: 1,
      heading: healthProbe.label,
      detail: healthProbe.detail,
      detectedAt: healthProbe.checkedAt,
    });
  });
});
