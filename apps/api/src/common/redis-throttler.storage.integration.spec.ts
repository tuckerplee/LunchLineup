import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisThrottlerStorage } from "./redis-throttler.storage";

const redisUrl = process.env.RATE_LIMIT_REDIS_TEST_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

describeWithRedis("RedisThrottlerStorage integration", () => {
  const prefix = `lunchlineup:rate-limit:test:${process.pid}:${Date.now()}`;
  let first: RedisThrottlerStorage;
  let second: RedisThrottlerStorage;

  beforeAll(async () => {
    first = new RedisThrottlerStorage({
      redisUrl: redisUrl!,
      production: true,
      keyPrefix: prefix,
    });
    second = new RedisThrottlerStorage({
      redisUrl: redisUrl!,
      production: true,
      keyPrefix: prefix,
    });
    await Promise.all([first.onModuleInit(), second.onModuleInit()]);
  });

  afterAll(() => {
    first?.onApplicationShutdown();
    second?.onApplicationShutdown();
  });

  it("shares an atomic bucket across API instances", async () => {
    const one = await first.increment(
      "shared-request",
      2_000,
      5,
      2_000,
      "auth",
    );
    const two = await second.increment(
      "shared-request",
      2_000,
      5,
      2_000,
      "auth",
    );

    expect(one.totalHits).toBe(1);
    expect(two.totalHits).toBe(2);
    expect(two.isBlocked).toBe(false);
  });

  it("expires hits after the TTL", async () => {
    await first.increment("ttl-request", 200, 5, 200, "default");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const reset = await second.increment("ttl-request", 200, 5, 200, "default");
    expect(reset.totalHits).toBe(1);
    expect(reset.isBlocked).toBe(false);
  });

  it("holds a shared block and starts a clean bucket after block expiry", async () => {
    await first.increment("blocked-request", 2_000, 2, 250, "expensive");
    await second.increment("blocked-request", 2_000, 2, 250, "expensive");
    const blocked = await first.increment(
      "blocked-request",
      2_000,
      2,
      250,
      "expensive",
    );
    const stillBlocked = await second.increment(
      "blocked-request",
      2_000,
      2,
      250,
      "expensive",
    );

    expect(blocked).toMatchObject({ totalHits: 3, isBlocked: true });
    expect(stillBlocked).toMatchObject({ totalHits: 3, isBlocked: true });

    await new Promise((resolve) => setTimeout(resolve, 350));
    const reset = await second.increment(
      "blocked-request",
      2_000,
      2,
      250,
      "expensive",
    );
    expect(reset).toMatchObject({ totalHits: 1, isBlocked: false });
  });
});
