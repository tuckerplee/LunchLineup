import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const NATIVE_METRICS_TOKEN_MAX_BYTES = 4096;
const ERROR = 'Invalid native metrics configuration';
export type MetricsTokenReader = (path: string, maximumBytes: number) => Buffer;
export type MetricsSecretFileOps = {
  open(path: string, flags: number): number;
  stat(fd: number): { regular: boolean; size: number };
  read(fd: number, buffer: Buffer, offset: number, length: number): number;
  close(fd: number): void;
};
const FILE_OPS: MetricsSecretFileOps = {
  open: (path, flags) => openSync(path, flags),
  stat: fd => { const value = fstatSync(fd); return { regular: value.isFile(), size: value.size }; },
  read: (fd, buffer, offset, length) => readSync(fd, buffer, offset, length, null),
  close: fd => closeSync(fd),
};

export function isNativeMetricsToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32
    && value.length <= NATIVE_METRICS_TOKEN_MAX_BYTES && !/[^\x21-\x7e]/.test(value);
}

/**
 * Startup-only bounded regular-file read; no polling/reload or whole-file read.
 * Linux O_NONBLOCK rejects waiting on FIFO open; O_NOFOLLOW rejects leaf symlinks.
 * File metadata/4097th-byte check and partial-read progress bound allocated/read
 * bytes. Neither this nor a guest timeout proves a storage/kernel hard deadline.
 */
export function readBoundedMetricsFile(
  path: string,
  maximumBytes: number,
  ops: MetricsSecretFileOps = FILE_OPS,
): Buffer {
  try {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
        || maximumBytes > NATIVE_METRICS_TOKEN_MAX_BYTES
        || !Number.isSafeInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0
        || !Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0) throw new Error(ERROR);
    let fd: number | undefined;
    try {
      fd = ops.open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const info = ops.stat(fd);
      if (!info.regular || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > maximumBytes) {
        throw new Error(ERROR);
      }
      const buffer = Buffer.alloc(maximumBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = ops.read(fd, buffer, offset, buffer.length - offset);
        if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - offset) throw new Error(ERROR);
        if (count === 0) break;
        offset += count;
      }
      if (offset > maximumBytes) throw new Error(ERROR);
      return buffer.subarray(0, offset);
    } finally { if (fd !== undefined) ops.close(fd); }
  } catch {
    // No path, token, filesystem error, cause or source configuration escapes.
    throw new Error(ERROR);
  }
}

/** Exact explicit source; conflicting or empty sources never fall back. */
export function resolveNativeMetricsToken(
  env: NodeJS.ProcessEnv,
  read: MetricsTokenReader = readBoundedMetricsFile,
): string {
  try {
    const hasFile = env.METRICS_TOKEN_FILE !== undefined;
    const hasDirect = env.METRICS_TOKEN !== undefined;
    if (hasFile === hasDirect) throw new Error(ERROR);
    if (hasDirect) {
      if (!isNativeMetricsToken(env.METRICS_TOKEN)) throw new Error(ERROR);
      return env.METRICS_TOKEN;
    }
    const path = env.METRICS_TOKEN_FILE;
    if (typeof path !== 'string' || !isAbsolute(path) || path.length === 0
        || Buffer.byteLength(path, 'utf8') > 4096 || /[\x00-\x1f\x7f]/.test(path)
        || path !== path.trim()) throw new Error(ERROR);
    const raw = read(path, NATIVE_METRICS_TOKEN_MAX_BYTES);
    if (!Buffer.isBuffer(raw) || raw.length > NATIVE_METRICS_TOKEN_MAX_BYTES) throw new Error(ERROR);
    // ASCII-only decoding check prevents Unicode normalization/replacement.
    for (const byte of raw) {
      if (byte > 0x7e || byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)) throw new Error(ERROR);
    }
    const value = raw.toString('ascii').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
    if (!isNativeMetricsToken(value)) throw new Error(ERROR);
    return value;
  } catch { throw new Error(ERROR); }
}
