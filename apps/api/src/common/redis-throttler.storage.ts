import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import {
  ThrottlerStorageService,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import { createHash } from "crypto";
import Redis from "ioredis";

const DEFAULT_KEY_PREFIX = "lunchlineup:rate-limit:v1";
const REDIS_OPERATION_TIMEOUT_MS = 1_500;
const FAILURE_LOG_INTERVAL_MS = 60_000;

const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local stateKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local serverTime = redis.call('TIME')
local now = (tonumber(serverTime[1]) * 1000) + math.floor(tonumber(serverTime[2]) / 1000)
local cutoff = now - ttl

local function secondsRemaining(milliseconds)
    if milliseconds <= 0 then
        return 0
    end
    return math.floor((milliseconds + 999) / 1000)
end

local blockUntil = tonumber(redis.call('HGET', stateKey, 'blockUntil') or '0')
if blockUntil > 0 and blockUntil <= now then
    redis.call('DEL', hitsKey)
    redis.call('HSET', stateKey, 'blockUntil', 0)
    blockUntil = 0
end

redis.call('ZREMRANGEBYSCORE', hitsKey, '-inf', cutoff)

local function timeToExpire()
    local oldest = redis.call('ZRANGE', hitsKey, 0, 0, 'WITHSCORES')
    if #oldest == 0 then
        return secondsRemaining(ttl)
    end
    return secondsRemaining((tonumber(oldest[2]) + ttl) - now)
end

local retention = math.max(ttl, blockDuration) + ttl
if blockUntil > now then
    redis.call('PEXPIRE', hitsKey, retention)
    redis.call('PEXPIRE', stateKey, retention)
    return {
        redis.call('ZCARD', hitsKey),
        timeToExpire(),
        1,
        secondsRemaining(blockUntil - now)
    }
end

local sequence = redis.call('HINCRBY', stateKey, 'sequence', 1)
redis.call('ZADD', hitsKey, now, tostring(now) .. ':' .. tostring(sequence))
local totalHits = redis.call('ZCARD', hitsKey)
local isBlocked = 0
local timeToBlockExpire = 0

if totalHits > limit then
    blockUntil = now + blockDuration
    redis.call('HSET', stateKey, 'blockUntil', blockUntil)
    isBlocked = 1
    timeToBlockExpire = secondsRemaining(blockDuration)
end

redis.call('PEXPIRE', hitsKey, retention)
redis.call('PEXPIRE', stateKey, retention)

return {totalHits, timeToExpire(), isBlocked, timeToBlockExpire}
`;

type StorageRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

export interface RateLimitRedisClient {
  readonly status?: string;
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
}

interface ConfigReader {
  get<T = unknown>(key: string): T | undefined;
}

interface RedisThrottlerStorageOptions {
  redisUrl: string;
  production: boolean;
  client?: RateLimitRedisClient;
  fallback?: ThrottlerStorage;
  keyPrefix?: string;
}

@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly client: RateLimitRedisClient;
  private readonly fallback: ThrottlerStorage;
  private readonly keyPrefix: string;
  private readonly ownsClient: boolean;
  private lastFailureLogAt = 0;

  constructor(private readonly options: RedisThrottlerStorageOptions) {
    this.client =
      options.client ??
      new Redis(options.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        connectTimeout: REDIS_OPERATION_TIMEOUT_MS,
        enableOfflineQueue: false,
      });
    this.fallback = options.fallback ?? new ThrottlerStorageService();
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.ownsClient = !options.client;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.assertReady();
    } catch {
      this.reportStorageFailure();
      if (this.options.production) {
        throw new Error("Shared rate-limit Redis is unavailable");
      }
    }
  }

  onApplicationShutdown(): void {
    if (this.ownsClient) {
      this.client.disconnect(false);
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    const safeTtl = this.positiveInteger(ttl);
    const safeLimit = this.positiveInteger(limit);
    const safeBlockDuration = this.positiveInteger(blockDuration);

    try {
      return await this.incrementShared(
        key,
        safeTtl,
        safeLimit,
        safeBlockDuration,
        throttlerName,
      );
    } catch {
      this.reportStorageFailure();
      if (this.options.production) {
        return this.blockedRecord(safeTtl, safeLimit, safeBlockDuration);
      }
      return this.fallback.increment(
        key,
        safeTtl,
        safeLimit,
        safeBlockDuration,
        throttlerName,
      );
    }
  }

  async assertReady(): Promise<void> {
    await this.ensureConnected();
    const pong = await this.withTimeout(this.client.ping());
    if (pong !== "PONG") {
      throw new Error("Unexpected Redis readiness response");
    }

    const result = await this.incrementShared(
      "readiness",
      1_000,
      1_000_000,
      1_000,
      "readiness",
    );
    if (result.isBlocked) {
      throw new Error("Shared rate-limit readiness bucket is blocked");
    }
  }

  private async incrementShared(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    await this.ensureConnected();
    const digest = createHash("sha256")
      .update(`${throttlerName}:${key}`)
      .digest("hex");
    const baseKey = `${this.keyPrefix}:{${digest}}`;
    const rawResult = await this.withTimeout(
      this.client.eval(
        INCREMENT_SCRIPT,
        2,
        `${baseKey}:hits`,
        `${baseKey}:state`,
        String(ttl),
        String(limit),
        String(blockDuration),
      ),
    );
    return this.parseRecord(rawResult);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === "wait" || this.client.status === "end") {
      await this.withTimeout(this.client.connect());
    }
  }

  private parseRecord(value: unknown): StorageRecord {
    if (!Array.isArray(value) || value.length !== 4) {
      throw new Error("Invalid shared rate-limit storage response");
    }
    const fields = value.map((entry) => Number(entry));
    if (fields.some((entry) => !Number.isFinite(entry) || entry < 0)) {
      throw new Error("Invalid shared rate-limit storage values");
    }
    return {
      totalHits: Math.floor(fields[0]),
      timeToExpire: Math.ceil(fields[1]),
      isBlocked: fields[2] === 1,
      timeToBlockExpire: Math.ceil(fields[3]),
    };
  }

  private blockedRecord(
    ttl: number,
    limit: number,
    blockDuration: number,
  ): StorageRecord {
    return {
      totalHits: limit + 1,
      timeToExpire: Math.ceil(ttl / 1_000),
      isBlocked: true,
      timeToBlockExpire: Math.ceil(blockDuration / 1_000),
    };
  }

  private positiveInteger(value: number): number {
    return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Shared rate-limit Redis operation timed out")),
            REDIS_OPERATION_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private reportStorageFailure(): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLogAt = now;
    const action = this.options.production
      ? "request denied"
      : "local fallback enabled";
    this.logger.error(`Shared rate-limit storage unavailable; ${action}`);
  }
}

export function createRateLimitThrottlerOptions(
  config: ConfigReader,
): ThrottlerModuleOptions {
  const environment = String(
    config.get<string>("NODE_ENV") ?? process.env.NODE_ENV ?? "development",
  )
    .trim()
    .toLowerCase();
  const production = environment === "production";
  const redisUrl = String(
    config.get<string>("REDIS_URL") ?? process.env.REDIS_URL ?? "",
  ).trim();

  if (!redisUrl && production) {
    throw new Error(
      "REDIS_URL is required for shared production rate limiting",
    );
  }

  const storage: ThrottlerStorage = redisUrl
    ? new RedisThrottlerStorage({ redisUrl, production })
    : new ThrottlerStorageService();

  return {
    storage,
    throttlers: [
      { name: "default", ttl: 60_000, limit: 100 },
      { name: "auth", ttl: 900_000, limit: 5 },
      { name: "authIp", ttl: 900_000, limit: 30 },
      { name: "authIdentifier", ttl: 900_000, limit: 5 },
      { name: "refreshIp", ttl: 900_000, limit: 100 },
      { name: "refreshCredential", ttl: 900_000, limit: 5 },
      { name: "expensive", ttl: 60_000, limit: 10 },
    ],
  };
}
