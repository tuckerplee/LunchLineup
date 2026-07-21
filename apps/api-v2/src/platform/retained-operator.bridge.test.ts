import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetainedOperatorBridge } from './retained-operator.bridge';

const config = {
  appOrigin: 'https://beta.lunchlineup.com',
  legacyApiBaseUrl: 'http://api:3000/v1',
  legacyRequestTimeoutMs: 5_000,
};

function request(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    id: 'request-1',
    body: { dryRun: true, stage: 'application_data' },
    headers: { authorization: 'Bearer retained-operator-token' },
    ...overrides,
  } as FastifyRequest;
}

function reply(): FastifyReply & { headers: Map<string, string>; status?: number } {
  const headers = new Map<string, string>();
  const target = {
    headers,
    header: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
      return target;
    }),
    code: vi.fn((status: number) => {
      target.status = status;
      return target;
    }),
    status: undefined as number | undefined,
  };
  return target as unknown as FastifyReply & { headers: Map<string, string>; status?: number };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RetainedOperatorBridge', () => {
  it('forwards only an explicit bearer retention request to the fixed private target', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ dryRun: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'retry-after': '3' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const bridge = new RetainedOperatorBridge(config);
    const response = reply();

    await expect(bridge.executeRetentionPurge(request(), response)).resolves.toEqual({ dryRun: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api:3000/v1/admin/retention/purge-expired',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer retained-operator-token',
          'X-Forwarded-Host': 'beta.lunchlineup.com',
          'X-Forwarded-Proto': 'https',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-lunchlineup-compatibility-owner')).toBe('API-03');
  });

  it('rejects cookie-only and malformed operator requests before making a private call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const bridge = new RetainedOperatorBridge(config);

    await expect(bridge.executeRetentionPurge(
      request({ headers: { cookie: 'access_token=browser-session' } }),
      reply(),
    )).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
