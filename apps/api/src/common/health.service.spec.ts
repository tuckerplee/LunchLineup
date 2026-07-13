import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../app.controller";
import { HealthService, RABBITMQ_HEALTH_TIMEOUT_MS } from "./health.service";
import { MetricsService } from "./metrics.service";

let originalRedisUrl: string | undefined;

class TestHealthService extends HealthService {
  constructor(
    configService: any,
    tenantDb: any,
    metricsService: MetricsService,
    private readonly redisClient: any,
    private readonly rabbitConnectionPromise: Promise<any>,
  ) {
    super(configService, tenantDb, metricsService);
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

  return {
    service: new TestHealthService(
      configService,
      tenantDb,
      metricsService,
      redisClient,
      rabbitConnectionPromise,
    ),
    tenantDb,
    redisClient,
    rabbitConnection,
    metricsService,
  };
}

describe("HealthService", () => {
  beforeEach(() => {
    originalRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
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
});
