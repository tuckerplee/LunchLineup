import { createHash } from 'node:crypto';
import Redis from 'ioredis';

const KEY_PREFIX = 'lunchlineup:rate-limit:v1';
const OPERATION_TIMEOUT_MS = 1500;
const FAILURE_LOG_INTERVAL_MS = 60_000;

// Exact retained v1 Lua protocol: Redis TIME, sliding windows, and colocated
// hits/state keys. No retry is issued after an ambiguous EVAL result.
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

export type NativeQuotaRecord = {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
};

export type NativeQuotaStorage = {
  ready(): Promise<void>;
  increment(key: string, ttl: number, limit: number, blockDuration: number, bucket: string): Promise<NativeQuotaRecord>;
};

export interface NativeQuotaRedisClient {
  readonly status?: string;
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  off(event: 'error', listener: (error: unknown) => void): unknown;
}

export class NativeQuotaStorageUnavailableError extends Error {
  constructor() {
    super('Shared rate-limit storage is unavailable.');
    this.name = 'NativeQuotaStorageUnavailableError';
  }
}

export class NativeRedisQuotaStorage implements NativeQuotaStorage {
  private readonly client: NativeQuotaRedisClient;
  private readonly ownsClient: boolean;
  private closed = false;
  private lastFailureLogAt: number | undefined;
  private readonly onRedisError = (): void => {
    if (!this.closed) this.logFailure();
  };

  constructor(redisUrl: string, private readonly reportFailure: () => void, client?: NativeQuotaRedisClient) {
    if (!redisUrl.trim()) throw new Error('Shared rate-limit Redis is required.');
    this.client = client ?? new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      connectTimeout: OPERATION_TIMEOUT_MS,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      autoResendUnfulfilledCommands: false,
    });
    this.ownsClient = client === undefined;
    // Suppress ioredis's unhandled-error console fallback. This listener never
    // records a raw client error. Other listeners on injected clients remain
    // the injecting owner's responsibility.
    this.client.on('error', this.onRedisError);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.ownsClient) this.client.disconnect(false);
    } finally {
      this.client.off('error', this.onRedisError);
    }
  }

  async ready(): Promise<void> {
    try {
      await this.ensureConnected();
      this.assertOpen();
      if (await this.withTimeout(this.client.ping()) !== 'PONG') {
        throw new Error('Unexpected rate-limit readiness response.');
      }
      const record = await this.incrementShared('readiness', 1000, 1_000_000, 1000, 'readiness');
      this.assertOpen();
      if (record.isBlocked) throw new Error('Rate-limit readiness bucket is blocked.');
    } catch {
      this.logFailure();
      throw new Error('Shared rate-limit Redis is unavailable.');
    }
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, bucket: string): Promise<NativeQuotaRecord> {
    try {
      const record = await this.incrementShared(key, ttl, limit, blockDuration, bucket);
      this.assertOpen();
      return record;
    } catch {
      this.logFailure();
      // Failed storage is service unavailability, distinct from a valid quota
      // denial. Never admit through local counters or classify failure as429.
      throw new NativeQuotaStorageUnavailableError();
    }
  }

  private async incrementShared(key: string, ttl: number, limit: number, blockDuration: number, bucket: string): Promise<NativeQuotaRecord> {
    await this.ensureConnected();
    this.assertOpen();
    const digest = createHash('sha256').update(bucket + ':' + key).digest('hex');
    const baseKey = KEY_PREFIX + ':{' + digest + '}';
    const result = await this.withTimeout(this.client.eval(
      INCREMENT_SCRIPT,
      2,
      baseKey + ':hits',
      baseKey + ':state',
      String(ttl),
      String(limit),
      String(blockDuration),
    ));
    this.assertOpen();
    if (!Array.isArray(result) || result.length !== 4) throw new Error('Invalid rate-limit response.');
    const values = result.map((value) => typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value) && value.trim() === value ? Number(value) : Number.NaN);
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
      || ![0, 1].includes(values[2])) throw new Error('Invalid rate-limit response.');
    return {
      totalHits: values[0],
      timeToExpire: values[1],
      isBlocked: values[2] === 1,
      timeToBlockExpire: values[3],
    };
  }

  private async ensureConnected(): Promise<void> {
    this.assertOpen();
    if (this.client.status === 'wait' || this.client.status === 'end') {
      await this.withTimeout(this.client.connect());
    }
    this.assertOpen();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Rate-limit storage is closed.');
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Rate-limit operation timed out.')), OPERATION_TIMEOUT_MS);
        }),
      ]);
      this.assertOpen();
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private logFailure(): void {
    if (this.closed) return;
    const now = Date.now();
    if (this.lastFailureLogAt !== undefined && now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLogAt = now;
    try { this.reportFailure(); } catch { /* diagnostics cannot change admission or expose their error */ }
  }
}
