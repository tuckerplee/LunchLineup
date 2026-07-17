import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../app.controller";
import {
  DEPENDENCY_HEALTH_TIMEOUT_MS,
  HEALTH_REPORT_CACHE_TTL_MS,
  HealthService,
  RABBITMQ_HEALTH_TIMEOUT_MS,
} from "./health.service";
import { MetricsService } from "./metrics.service";

let originalRedisUrl: string | undefined;

class TestHealthService extends HealthService {
  constructor(
    configService: any,
    tenantDb: any,
    metricsService: MetricsService,
    private readonly redisClient: any,
    private readonly rabbitConnectionPromise: Promise<any>,
    rateLimitStorage?: any,
  ) {
    super(configService, tenantDb, metricsService, rateLimitStorage);
  }

  protected override createRedisClient(_redisUrl: string) {
    return this.redisClient;
  }

  protected override createRabbitConnection(
    _rabbitUrl: string,
    _timeoutMs: number,
  ) {
    return this.rabbitConnectionPromise;
  }
}

function buildService(
  options: {
    databaseOk?: boolean;
    redisUrl?: string;
    redisPing?: string;
    redisConnectError?: Error;
    rabbitUrl?: string;
    rabbitConnectError?: Error;
    rabbitConnectionPromise?: Promise<any>;
    rateLimitStorageError?: Error;
  } = {},
) {
  const tenantDb = {
    client: {
      $queryRaw: vi.fn().mockImplementation(() => {
        if (options.databaseOk === false) {
          throw new Error("database down");
        }
        return Promise.resolve([{ ok: 1 }]);
      }),
    },
  };
  const configService = {
    get: vi.fn((key: string) => {
      if (key === "REDIS_URL") {
        return options.redisUrl;
      }
      if (key === "RABBITMQ_URL") {
        return options.rabbitUrl;
      }
      return undefined;
    }),
  };
  const redisClient = {
    connect: vi.fn().mockImplementation(() => {
      if (options.redisConnectError) {
        throw options.redisConnectError;
      }
      return Promise.resolve();
    }),
    ping: vi.fn().mockResolvedValue(options.redisPing ?? "PONG"),
    disconnect: vi.fn(),
  };
  const rabbitConnection = {
    close: vi.fn().mockResolvedValue(undefined),
  };
  const rabbitConnectionPromise =
    options.rabbitConnectionPromise ??
    (options.rabbitConnectError
      ? Promise.reject(options.rabbitConnectError)
      : Promise.resolve(rabbitConnection));
  const metricsService = new MetricsService();
  const rateLimitStorage = {
    assertReady: options.rateLimitStorageError
      ? vi.fn().mockRejectedValue(options.rateLimitStorageError)
      : vi.fn().mockResolvedValue(undefined),
  };

  return {
    service: new TestHealthService(
      configService,
      tenantDb,
      metricsService,
      redisClient,
      rabbitConnectionPromise,
      rateLimitStorage,
    ),
    tenantDb,
    redisClient,
    rabbitConnection,
    metricsService,
    rateLimitStorage,
  };
}

describe("HealthService", () => {
  beforeEach(() => {
    originalRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("reports ok and publishes metrics when all dependency checks pass", async () => {
    const { service, tenantDb, redisClient, rabbitConnection, metricsService } =
      buildService({
        redisUrl: "redis://redis:6379",
        rabbitUrl: "amqp://rabbitmq:5672",
      });

    const report = await service.check();
    const metrics = await metricsService.getMetrics();

    expect(report.status).toBe("ok");
    expect(report.checks.map((check) => [check.name, check.status])).toEqual([
      ["database", "online"],
      ["redis", "online"],
      ["rabbitmq", "online"],
    ]);
    expect(tenantDb.client.$queryRaw).toHaveBeenCalled();
    expect(redisClient.connect).toHaveBeenCalled();
    expect(redisClient.ping).toHaveBeenCalled();
    expect(redisClient.disconnect).toHaveBeenCalled();
    expect(rabbitConnection.close).toHaveBeenCalled();
    expect(metrics).toMatch(
      /lunchlineup_dependency_up\{dependency="rabbitmq",app="lunchlineup-api"\} 1/,
    );
  });

  it("reports degraded when database is down", async () => {
    const { service } = buildService({
      databaseOk: false,
      redisUrl: "redis://redis:6379",
      rabbitUrl: "amqp://rabbitmq:5672",
    });

    const report = await service.check();

    expect(report.status).toBe("degraded");
    expect(
      report.checks.find((check) => check.name === "database")?.status,
    ).toBe("offline");
    expect(
      report.checks.find((check) => check.name === "database")?.details,
    ).toBe("dependency check failed");
    expect(JSON.stringify(report)).not.toContain("database down");
  });

  it("reports degraded when Redis is not configured", async () => {
    const { service, redisClient } = buildService({
      rabbitUrl: "amqp://rabbitmq:5672",
    });

    const report = await service.check();

    expect(report.status).toBe("degraded");
    expect(report.checks.find((check) => check.name === "redis")?.details).toBe(
      "dependency check failed",
    );
    expect(redisClient.connect).not.toHaveBeenCalled();
  });

  it("reports degraded when the shared rate-limit script cannot run", async () => {
    const { service, rateLimitStorage } = buildService({
      redisUrl: "redis://redis:6379",
      rabbitUrl: "amqp://rabbitmq:5672",
      rateLimitStorageError: new Error("EVAL denied for secret-bearing user"),
    });

    const report = await service.check();
    const redis = report.checks.find((check) => check.name === "redis");

    expect(rateLimitStorage.assertReady).toHaveBeenCalled();
    expect(redis).toMatchObject({
      status: "offline",
      details: "dependency check failed",
    });
    expect(JSON.stringify(report)).not.toContain("secret-bearing");
  });

  it("reports degraded and publishes zero when RabbitMQ rejects the connection", async () => {
    const { service, metricsService } = buildService({
      redisUrl: "redis://redis:6379",
      rabbitUrl: "amqp://user:rabbit-secret@rabbitmq:5672",
      rabbitConnectError: new Error(
        "amqp://user:rabbit-secret@rabbitmq:5672 unavailable",
      ),
    });

    const report = await service.check();
    const metrics = await metricsService.getMetrics();
    const rabbit = report.checks.find((check) => check.name === "rabbitmq");

    expect(report.status).toBe("degraded");
    expect(rabbit).toMatchObject({
      status: "offline",
      details: "dependency check failed",
    });
    expect(JSON.stringify(report)).not.toContain("rabbit-secret");
    expect(metrics).toMatch(
      /lunchlineup_dependency_up\{dependency="rabbitmq",app="lunchlineup-api"\} 0/,
    );
  });

  it("bounds a RabbitMQ connection that never settles", async () => {
    vi.useFakeTimers();
    try {
      const { service } = buildService({
        redisUrl: "redis://redis:6379",
        rabbitUrl: "amqp://rabbitmq:5672",
        rabbitConnectionPromise: new Promise(() => undefined),
      });

      const reportPromise = service.check();
      await vi.advanceTimersByTimeAsync(RABBITMQ_HEALTH_TIMEOUT_MS);
      const report = await reportPromise;

      expect(report.status).toBe("degraded");
      expect(
        report.checks.find((check) => check.name === "rabbitmq"),
      ).toMatchObject({
        status: "offline",
        latencyMs: RABBITMQ_HEALTH_TIMEOUT_MS,
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a stuck database probe and starts a fresh probe after cache expiry", async () => {
    vi.useFakeTimers();
    const { service, tenantDb } = buildService({
      redisUrl: "redis://redis:6379",
      rabbitUrl: "amqp://rabbitmq:5672",
    });
    tenantDb.client.$queryRaw
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue([{ ok: 1 }]);

    const firstReportPromise = service.check();
    await vi.advanceTimersByTimeAsync(DEPENDENCY_HEALTH_TIMEOUT_MS);
    const firstReport = await firstReportPromise;
    expect(firstReport.checks.find((check) => check.name === "database"))
      .toMatchObject({ status: "offline", latencyMs: DEPENDENCY_HEALTH_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(HEALTH_REPORT_CACHE_TTL_MS + 1);
    const secondReport = await service.check();
    expect(secondReport.checks.find((check) => check.name === "database"))
      .toMatchObject({ status: "online" });
    expect(tenantDb.client.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("bounds a stuck Redis probe and starts a fresh probe after cache expiry", async () => {
    vi.useFakeTimers();
    const { service, redisClient } = buildService({
      redisUrl: "redis://redis:6379",
      rabbitUrl: "amqp://rabbitmq:5672",
    });
    redisClient.ping
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue("PONG");

    const firstReportPromise = service.check();
    await vi.advanceTimersByTimeAsync(DEPENDENCY_HEALTH_TIMEOUT_MS);
    const firstReport = await firstReportPromise;
    expect(firstReport.checks.find((check) => check.name === "redis"))
      .toMatchObject({ status: "offline", latencyMs: DEPENDENCY_HEALTH_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(HEALTH_REPORT_CACHE_TTL_MS + 1);
    const secondReport = await service.check();
    expect(secondReport.checks.find((check) => check.name === "redis"))
      .toMatchObject({ status: "online" });
    expect(redisClient.ping).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent readiness probes and briefly caches the report", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { service, tenantDb, redisClient } = buildService({
        redisUrl: "redis://redis:6379",
        rabbitUrl: "amqp://rabbitmq:5672",
      });

      const [first, second] = await Promise.all([service.check(), service.check()]);
      expect(second).toBe(first);
      expect(tenantDb.client.$queryRaw).toHaveBeenCalledTimes(1);
      expect(redisClient.connect).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_000 + HEALTH_REPORT_CACHE_TTL_MS - 1);
      await service.check();
      expect(tenantDb.client.$queryRaw).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_000 + HEALTH_REPORT_CACHE_TTL_MS + 1);
      await service.check();
      expect(tenantDb.client.$queryRaw).toHaveBeenCalledTimes(2);
      expect(redisClient.connect).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});

describe("AppController health status", () => {
  it("sets 503 when a required dependency is offline", async () => {
    const health = {
      status: "degraded",
      timestamp: new Date().toISOString(),
      checks: [
        {
          name: "rabbitmq",
          status: "offline",
          latencyMs: RABBITMQ_HEALTH_TIMEOUT_MS,
          details: "dependency check failed",
        },
      ],
    };
    const healthService = { check: vi.fn().mockResolvedValue(health) };
    const response = { status: vi.fn() };
    const controller = new AppController(healthService as any);

    await controller.checkHealth(response as any);

    expect(response.status).toHaveBeenCalledWith(503);
  });

  it("reports process liveness without probing dependencies", () => {
    const healthService = { check: vi.fn() };
    const controller = new AppController(healthService as any);

    expect(controller.checkLiveness()).toMatchObject({ status: "ok" });
    expect(healthService.check).not.toHaveBeenCalled();
  });

  it("exempts readiness and liveness from request throttling", () => {
    expect(Reflect.getMetadata(
      "THROTTLER:SKIPdefault",
      AppController.prototype.checkHealth,
    )).toBe(true);
    expect(Reflect.getMetadata(
      "THROTTLER:SKIPdefault",
      AppController.prototype.checkLiveness,
    )).toBe(true);
  });
});
