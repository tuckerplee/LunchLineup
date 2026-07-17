import { Test } from "@nestjs/testing";
import { ThrottlerModule, ThrottlerStorageService } from "@nestjs/throttler";
import { describe, expect, it, vi } from "vitest";
import {
  createRateLimitThrottlerOptions,
  RedisThrottlerStorage,
  type RateLimitRedisClient,
} from "./redis-throttler.storage";

function createClient(
  overrides: Partial<RateLimitRedisClient> = {},
): RateLimitRedisClient {
  return {
    status: "ready",
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue("PONG"),
    eval: vi.fn().mockResolvedValue([1, 60, 0, 0]),
    disconnect: vi.fn(),
    ...overrides,
  };
}

describe("RedisThrottlerStorage", () => {
  it("maps the atomic Redis result to the installed Nest storage contract", async () => {
    const client = createClient({
      eval: vi.fn().mockResolvedValue([3, 42, 1, 17]),
    });
    const storage = new RedisThrottlerStorage({
      redisUrl: "redis://unused",
      production: true,
      client,
      keyPrefix: "test-rate-limit",
    });

    await expect(
      storage.increment("request-key", 60_000, 2, 30_000, "auth"),
    ).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 42,
      isBlocked: true,
      timeToBlockExpire: 17,
    });
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('TIME')"),
      2,
      expect.stringMatching(/^test-rate-limit:\{[a-f0-9]{64}\}:hits$/),
      expect.stringMatching(/^test-rate-limit:\{[a-f0-9]{64}\}:state$/),
      "60000",
      "2",
      "30000",
    );
  });

  it("fails closed without leaking a Redis failure in production", async () => {
    const storage = new RedisThrottlerStorage({
      redisUrl: "redis://unused",
      production: true,
      client: createClient({
        eval: vi.fn().mockRejectedValue(new Error("redis://user:secret@host")),
      }),
    });

    await expect(
      storage.increment("request-key", 60_000, 5, 30_000, "auth"),
    ).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 60,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
  });

  it("uses the isolated in-memory fallback only outside production", async () => {
    const fallback = new ThrottlerStorageService();
    const storage = new RedisThrottlerStorage({
      redisUrl: "redis://unused",
      production: false,
      client: createClient({
        eval: vi.fn().mockRejectedValue(new Error("offline")),
      }),
      fallback,
    });

    const first = await storage.increment(
      "request-key",
      60_000,
      5,
      30_000,
      "auth",
    );
    const second = await storage.increment(
      "request-key",
      60_000,
      5,
      30_000,
      "auth",
    );

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.isBlocked).toBe(false);
  });

  it("fails production startup when the shared storage readiness script cannot run", async () => {
    const storage = new RedisThrottlerStorage({
      redisUrl: "redis://unused",
      production: true,
      client: createClient({
        eval: vi.fn().mockRejectedValue(new Error("EVAL denied")),
      }),
    });

    await expect(storage.onModuleInit()).rejects.toThrow(
      "Shared rate-limit Redis is unavailable",
    );
  });

  it("runs the shared-storage readiness hook during Nest module startup", async () => {
    const client = createClient();
    const storage = new RedisThrottlerStorage({
      redisUrl: "redis://unused",
      production: true,
      client,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          storage,
          throttlers: [{ name: "default", ttl: 60_000, limit: 100 }],
        }),
      ],
    }).compile();

    await moduleRef.init();

    expect(client.ping).toHaveBeenCalled();
    expect(client.eval).toHaveBeenCalled();
    await moduleRef.close();
  });

  it("allows development startup to retain the local fallback during Redis downtime", async () => {
    const storage = new RedisThrottlerStorage({
      redisUrl: "redis://unused",
      production: false,
      client: createClient({
        ping: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    });

    await expect(storage.onModuleInit()).resolves.toBeUndefined();
  });

  it("requires Redis and selects shared storage in production module options", () => {
    expect(() =>
      createRateLimitThrottlerOptions({
        get: <T>(key: string) =>
          (key === "NODE_ENV" ? "production" : undefined) as T | undefined,
      }),
    ).toThrow("REDIS_URL is required for shared production rate limiting");

    const options = createRateLimitThrottlerOptions({
      get: <T>(key: string) =>
        ({
          NODE_ENV: "production",
          REDIS_URL: "redis://redis:6379",
        })[key] as T | undefined,
    });

    expect(Array.isArray(options)).toBe(false);
    expect((options as { storage: unknown }).storage).toBeInstanceOf(
      RedisThrottlerStorage,
    );
  });
});
