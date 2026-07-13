import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as amqp from "amqplib";
import Redis from "ioredis";
import { TenantPrismaService } from "../database/tenant-prisma.service";
import { MetricsService } from "./metrics.service";

export const RABBITMQ_HEALTH_TIMEOUT_MS = 1000;

type DependencyStatus = "online" | "offline";
type OverallHealth = "ok" | "degraded";

interface DependencyCheck {
  name: string;
  status: DependencyStatus;
  latencyMs: number;
  details: string;
}

export interface HealthReport {
  status: OverallHealth;
  timestamp: string;
  checks: DependencyCheck[];
}

@Injectable()
export class HealthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly tenantDb: TenantPrismaService,
    private readonly metricsService: MetricsService,
  ) {}

  async check(): Promise<HealthReport> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkRabbitMq(),
    ]);

    for (const check of checks) {
      this.metricsService.recordDependencyStatus(
        check.name,
        check.status === "online",
      );
    }

    return {
      status: checks.every((check) => check.status === "online")
        ? "ok"
        : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async checkDatabase(): Promise<DependencyCheck> {
    const result = await this.timeCheck(async () => {
      await this.tenantDb.client.$queryRaw`SELECT 1`;
    });

    return {
      name: "database",
      status: result.ok ? "online" : "offline",
      latencyMs: result.latencyMs,
      details: result.ok ? "query succeeded" : this.safeFailureDetails(),
    };
  }

  private async checkRedis(): Promise<DependencyCheck> {
    const redisUrl =
      this.configService.get<string>("REDIS_URL") ?? process.env.REDIS_URL;
    if (!redisUrl) {
      return {
        name: "redis",
        status: "offline",
        latencyMs: 0,
        details: this.safeFailureDetails(),
      };
    }

    const redis = this.createRedisClient(redisUrl);
    try {
      const result = await this.timeCheck(async () => {
        await redis.connect();
        const pong = await redis.ping();
        if (pong !== "PONG") {
          throw new Error("unexpected Redis PING response");
        }
      });

      return {
        name: "redis",
        status: result.ok ? "online" : "offline",
        latencyMs: result.latencyMs,
        details: result.ok ? "ping succeeded" : this.safeFailureDetails(),
      };
    } finally {
      redis.disconnect();
    }
  }

  protected createRedisClient(redisUrl: string): Redis {
    return new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      enableOfflineQueue: false,
    });
  }

  private async checkRabbitMq(): Promise<DependencyCheck> {
    const rabbitUrl =
      this.configService.get<string>("RABBITMQ_URL") ??
      process.env.RABBITMQ_URL;
    if (!rabbitUrl) {
      return {
        name: "rabbitmq",
        status: "offline",
        latencyMs: 0,
        details: this.safeFailureDetails(),
      };
    }

    const connectionPromise = this.createRabbitConnection(
      rabbitUrl,
      RABBITMQ_HEALTH_TIMEOUT_MS,
    );
    let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
    const result = await this.timeCheck(async () => {
      connection = await this.withTimeout(
        connectionPromise,
        RABBITMQ_HEALTH_TIMEOUT_MS,
      );
    });

    if (connection) {
      void connection.close().catch(() => undefined);
    } else {
      // A connection that completes after our deadline must not remain open.
      void connectionPromise
        .then((lateConnection) => lateConnection.close())
        .catch(() => undefined);
    }

    return {
      name: "rabbitmq",
      status: result.ok ? "online" : "offline",
      latencyMs: result.latencyMs,
      details: result.ok ? "connection succeeded" : this.safeFailureDetails(),
    };
  }

  protected createRabbitConnection(rabbitUrl: string, timeoutMs: number) {
    return amqp.connect(rabbitUrl, { timeout: timeoutMs });
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("dependency check timed out")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async timeCheck(
    operation: () => Promise<void>,
  ): Promise<
    | { ok: true; latencyMs: number }
    | { ok: false; latencyMs: number; error: unknown }
  > {
    const start = Date.now();
    try {
      await operation();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - start, error };
    }
  }

  private safeFailureDetails(): string {
    return "dependency check failed";
  }
}
