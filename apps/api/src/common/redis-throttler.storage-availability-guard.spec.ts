import { HttpException, Logger, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import type { TenantPrismaService } from '../database/tenant-prisma.service';
import { RateLimitsGuard } from './guards/rate-limits.guard';
import { ProductionExceptionFilter } from './production-exception.filter';
import { RedisThrottlerStorage, type RateLimitRedisClient } from './redis-throttler.storage';

// SOURCE ONLY: real guard/storage/filter, fake context/DB/Redis, no Nest server,
// real Redis, auth, metadata integration, bridge or production readiness proof.
const PRIVATE = 'synthetic-secret-redis://driver-credential';
const ROWS = [
  { mode: 'allowed', status: 200, evals: 2 },
  { mode: 'principal-blocked', status: 429, evals: 1 },
  { mode: 'tenant-blocked', status: 429, evals: 2 },
  { mode: 'principal-rejected', status: 503, evals: 1 },
  { mode: 'tenant-rejected', status: 503, evals: 2 },
  { mode: 'malformed', status: 503, evals: 1 },
  { mode: 'diagnostic-throws', status: 503, evals: 1 },
] as const;
class ControlController { findAll(): void {} }
describe('retained quota availability through the actual guard and production filter', () => {
  it.each(ROWS)('$mode remains $status without business work or local fallback', async row => {
    const diagnostic = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      if (row.mode === 'diagnostic-throws') throw new Error(PRIVATE);
    });
    let storage: RedisThrottlerStorage | undefined;
    try {
      let nextEval = 0;
      const evalCommand = vi.fn(async (_script: string, _numberOfKeys: number, ..._args: string[]) => {
        const index = nextEval++;
        if (row.mode === 'principal-rejected' || row.mode === 'diagnostic-throws'
          || (row.mode === 'tenant-rejected' && index === 1)) throw new Error(PRIVATE);
        if (row.mode === 'malformed') return ['invalid'];
        if (row.mode === 'principal-blocked') return [61, 60, 1, 59];
        if (row.mode === 'tenant-blocked' && index === 1) return [601, 60, 1, 58];
        return [1, 60, 0, 0];
      });
      const client: RateLimitRedisClient = {
        status: 'ready', connect: vi.fn(async () => undefined), ping: vi.fn(async () => 'PONG'),
        eval: evalCommand, disconnect: vi.fn(),
      };
      const fallback = { increment: vi.fn(async () => { throw new Error('Fallback must not run'); }) } as ThrottlerStorage;
      storage = new RedisThrottlerStorage({
        redisUrl: 'redis://synthetic-never-connected', production: true, client, fallback,
      });
      const findUnique = vi.fn(async () => ({ planTier: 'FREE', status: 'ACTIVE' }));
      const withTenant = vi.fn(async (_tenant: string, run: (tx: unknown) => Promise<unknown>) => run({ tenant: { findUnique } }));
      const options = { throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }] };
      const guard = new RateLimitsGuard(options, storage, new Reflector(), { withTenant } as unknown as TenantPrismaService);
      await guard.onModuleInit();
      const headers = new Map<string, number>();
      const response = {
        header: vi.fn((name: string, value: number) => headers.set(name.toLowerCase(), value)),
        status: vi.fn().mockReturnThis(), json: vi.fn(),
      };
      const request = {
        method: 'GET', originalUrl: '/v1/availability-control', correlationId: 'synthetic-correlation',
        headers: {}, ip: '192.0.2.10',
        user: { tenantId: 'tenant-control', sub: 'subject-control', sessionId: 'session-control' },
      };
      const context = {
        getHandler: () => ControlController.prototype.findAll, getClass: () => ControlController,
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      } as unknown as ExecutionContext;
      const business = vi.fn();
      // Observe any rejection immediately; preserve the actual exception rather
      // than fabricating a guard result or manually replacing its HTTP status.
      const result = await guard.canActivate(context).then(
        value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error }),
      );
      if (row.status === 200) {
        expect(result).toEqual({ ok: true, value: true });
        business();
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Expected quota denial');
        expect(result.error).toBeInstanceOf(HttpException);
        expect((result.error as HttpException).getStatus()).toBe(row.status);
        // The diagnostic-throw control is confined to admission. Restore a
        // nonthrowing log sink before exercising the separate actual filter.
        diagnostic.mockImplementation(() => undefined);
        new ProductionExceptionFilter().catch(result.error, context);
        expect(response.status).toHaveBeenCalledWith(row.status);
        expect(response.json).toHaveBeenCalledTimes(1);
        expect(response.json.mock.calls[0][0].statusCode).toBe(row.status);
        expect(JSON.stringify(response.json.mock.calls)).not.toContain(PRIVATE);
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(PRIVATE);
        expect(result.error).not.toHaveProperty('cause');
      }
      expect(business).toHaveBeenCalledTimes(row.status === 200 ? 1 : 0);
      expect(fallback.increment).not.toHaveBeenCalled();
      expect(evalCommand).toHaveBeenCalledTimes(row.evals);
      expect(withTenant).toHaveBeenCalledTimes(1);
      if (row.evals > 1) {
        expect(evalCommand.mock.calls[1].slice(-3)).toEqual(['60000', '600', '60000']);
        expect(headers.get('x-ratelimit-remaining')).toBe(59);
      }
      if (row.status === 503) expect(headers.get('retry-after')).toBeUndefined();
      if (row.mode === 'principal-blocked') expect(headers.get('retry-after')).toBe(59);
      if (row.mode === 'tenant-blocked') expect(headers.get('retry-after-tenantceiling')).toBe(58);
      expect(client.connect).not.toHaveBeenCalled();
      expect(client.ping).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
    } finally {
      try { storage?.onApplicationShutdown(); } finally { diagnostic.mockRestore(); }
    }
  });
});
