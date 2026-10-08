import { applicationApiOperation } from '@lunchlineup/api-contract';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { installProblemHandler } from './problem';
import { RetainedApplicationBridge } from './retained-application.bridge';

const message = 'Credit amount exceeds the available wallet capacity. Refresh balances and enter a smaller amount.';

describe('Administrative credit capacity refusal compatibility', () => {
  it('maps the native400 grant refusal to actionable422 without returning a successful acknowledgement', async () => {
    const config = loadConfig({ APP_ORIGIN: 'https://beta.lunchlineup.com',
      ALLOWED_ORIGINS: 'https://beta.lunchlineup.com', LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'synthetic-unit-jwt', NODE_ENV: 'test', LOG_LEVEL: 'silent',
      METRICS_TOKEN: 'synthetic-config-metrics-token-00000000000000000000', DEPLOY_RELEASE_SHA: 'a'.repeat(40) });
    const nativeBody = { statusCode: 400, message, error: 'Bad Request' };
    const payload = { tenantId: 'tenant-capacity', amount: 100, reason: 'Capacity boundary' };
    const forwarded = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://api:3000/v1/admin/credits/grant');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(payload);
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('capacity-admin-key');
      return new Response(JSON.stringify(nativeBody), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const app = Fastify({ logger: false });
    try {
      vi.stubGlobal('fetch', forwarded);
      installProblemHandler(app);
      const operation = applicationApiOperation('/admin/credits/grant', 'POST');
      if (!operation) throw new Error('Actual grant operation is absent from catalog');
      const bridge = new RetainedApplicationBridge(config);
      app.post('/v2/admin/credits/grant', (request, reply) => bridge.execute({ operation, request, reply }));
      const response = await app.inject({ method: 'POST', url: '/v2/admin/credits/grant',
        headers: { 'idempotency-key': 'capacity-admin-key' }, payload });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ status: 422, message, detail: message });
      expect(response.json()).not.toHaveProperty('success');
      expect(response.json()).not.toHaveProperty('newBalance');
      expect(forwarded).toHaveBeenCalledOnce();
    } finally {
      try { await app.close(); } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
    }
  });
});
