import { constants } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import {
  readBoundedMetricsFile, resolveNativeMetricsToken, type MetricsSecretFileOps,
} from './metrics-token.js';

const TOKEN = 'synthetic-metrics-token-0000000000000000000000000000';
const PATH = '/synthetic/never-opened-private-metrics-token';
const PRIVATE = 'private-filesystem-or-token-error-marker';
const ERROR = 'Invalid native metrics configuration';
const ENV = { NODE_ENV: 'production', JWT_SECRET: 'synthetic-access-key', METRICS_TOKEN_FILE: PATH };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function fixedError(action: () => unknown) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(ERROR);
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
  expect(String(error)).not.toContain(PRIVATE);
  expect(String(error)).not.toContain(PATH);
  expect(String(error)).not.toContain(TOKEN);
}

function file(data: Buffer, step = 4097) {
  let position = 0;
  const events: string[] = [];
  const reads: { offset: number; length: number; allocated: number }[] = [];
  const ops = {
    open: vi.fn((_path: string, _flags: number) => { events.push('open'); return 11; }),
    stat: vi.fn((_fd: number) => { events.push('stat'); return { regular: true, size: data.length }; }),
    read: vi.fn((_fd: number, buffer: Buffer, offset: number, length: number) => {
      events.push('read'); reads.push({ offset, length, allocated: buffer.length });
      const count = Math.min(length, step, data.length - position);
      data.copy(buffer, offset, position, position + count); position += count; return count;
    }),
    close: vi.fn((_fd: number) => { events.push('close'); }),
  } satisfies MetricsSecretFileOps;
  return { ops, events, reads };
}

describe('explicit startup token selection; synthetic reader only', () => {
  it.each([32, 4096])('accepts exact explicit direct token boundary%s without file reads', length => {
    const token = 'a'.repeat(length); const read = vi.fn(() => { throw new Error(PRIVATE); });
    expect(resolveNativeMetricsToken({ NODE_ENV: 'production', METRICS_TOKEN: token }, read)).toBe(token);
    expect(read).not.toHaveBeenCalled();
  });
  const directInvalid = ['', 'a'.repeat(31), 'a'.repeat(4097), TOKEN + '\n', ' ' + TOKEN,
    TOKEN + ' ', TOKEN.slice(0, 10) + '\t' + TOKEN.slice(10), 'é'.repeat(32)];
  it.each(directInvalid)('rejects invalid direct token without trimming or fallback', token => {
    const read = vi.fn(() => Buffer.from(TOKEN));
    fixedError(() => resolveNativeMetricsToken({ METRICS_TOKEN: token }, read));
    expect(read).not.toHaveBeenCalled();
  });
  it.each([{}, { METRICS_TOKEN: undefined }, { METRICS_TOKEN_FILE: undefined }])(
    'rejects missing explicit sources without ambient fallback', env => {
      vi.stubEnv('METRICS_TOKEN', TOKEN); vi.stubEnv('METRICS_TOKEN_FILE', PATH);
      const read = vi.fn(() => Buffer.from(TOKEN));
      fixedError(() => resolveNativeMetricsToken(env, read)); expect(read).not.toHaveBeenCalled();
    });
  it.each([
    { METRICS_TOKEN_FILE: PATH, METRICS_TOKEN: TOKEN },
    { METRICS_TOKEN_FILE: '', METRICS_TOKEN: TOKEN },
    { METRICS_TOKEN_FILE: PATH, METRICS_TOKEN: '' },
    { METRICS_TOKEN_FILE: '', METRICS_TOKEN: '' },
  ])('rejects conflicting sources, including explicitly empty ones, before any reader', env => {
    const read = vi.fn(() => Buffer.from(TOKEN));
    fixedError(() => resolveNativeMetricsToken(env, read)); expect(read).not.toHaveBeenCalled();
  });
  it.each(['', 'relative-secret', ' ' + PATH, PATH + ' ', PATH + '\n', '/bad\0path', '/' + 'a'.repeat(4096),
    '/' + 'é'.repeat(2048)])('rejects invalid file path before invoking synthetic reader', path => {
      const read = vi.fn(() => Buffer.from(TOKEN));
      fixedError(() => resolveNativeMetricsToken({ METRICS_TOKEN_FILE: path }, read));
      expect(read).not.toHaveBeenCalled();
    });
  it.each([TOKEN, TOKEN + '\n', '\t ' + TOKEN + '\r\n', 'a'.repeat(4096)])(
    'accepts bounded ASCII file token with only edge whitespace normalization', payload => {
      const read = vi.fn(() => Buffer.from(payload));
      expect(resolveNativeMetricsToken({ METRICS_TOKEN_FILE: PATH }, read)).toBe(payload.trim());
      expect(read).toHaveBeenCalledExactlyOnceWith(PATH, 4096);
    });
  const invalidFiles: Buffer[] = [
    Buffer.alloc(0), Buffer.from('a'.repeat(31)), Buffer.from('a'.repeat(4097)),
    Buffer.from(TOKEN + '\0'), Buffer.from(TOKEN + '\x7f'), Buffer.from('é'.repeat(32)),
    Buffer.from(TOKEN.slice(0, 10) + ' ' + TOKEN.slice(10)),
    Buffer.from(TOKEN.slice(0, 10) + '\n' + TOKEN.slice(10)),
    Buffer.from(TOKEN.slice(0, 10) + '\t' + TOKEN.slice(10)), Buffer.from([0xff]),
    Buffer.from('a'.repeat(4096) + '\n'),
  ];
  it.each(invalidFiles)('rejects invalid/oversize file bytes with fixed error', payload => {
    const read = vi.fn(() => payload);
    fixedError(() => resolveNativeMetricsToken({ METRICS_TOKEN_FILE: PATH }, read));
    expect(read).toHaveBeenCalledExactlyOnceWith(PATH, 4096);
  });
  it('redacts synthetic reader error and rejects a non-Buffer result', () => {
    fixedError(() => resolveNativeMetricsToken({ METRICS_TOKEN_FILE: PATH }, () => { throw new Error(PRIVATE + PATH); }));
    fixedError(() => resolveNativeMetricsToken({ METRICS_TOKEN_FILE: PATH }, () => TOKEN as unknown as Buffer));
  });
  it('loadConfig uses supplied env, caches one read, and preserves separate startup snapshots', () => {
    vi.stubEnv('METRICS_TOKEN', 'ambient-must-never-win-000000000000000000000000000000');
    vi.stubEnv('METRICS_TOKEN_FILE', '/ambient-never-read');
    const second = 'synthetic-new-token-00000000000000000000000000000000';
    const read = vi.fn().mockReturnValueOnce(Buffer.from(TOKEN)).mockReturnValueOnce(Buffer.from(second));
    const a = loadConfig(ENV, read);
    expect(a.metricsToken).toBe(TOKEN); expect(a.metricsToken).toBe(TOKEN);
    expect(read).toHaveBeenCalledExactlyOnceWith(PATH, 4096);
    const b = loadConfig(ENV, read);
    expect(b.metricsToken).toBe(second); expect(a.metricsToken).toBe(TOKEN); expect(read).toHaveBeenCalledTimes(2);
    expect(a.cookieSecure).toBe(true);
  });
  it('loadConfig missing production token fails closed; no default/public scrape credential', () => {
    const read = vi.fn(() => Buffer.from(TOKEN));
    fixedError(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'synthetic-access-key' }, read));
    expect(read).not.toHaveBeenCalled();
  });
});

describe('bounded regular-file reader via explicit fake operations; no native filesystem proof', () => {
  it.each([1, 4097])('handles partial read step%s, exact flags and owned fd cleanup', step => {
    const f = file(Buffer.from(TOKEN), step);
    expect(readBoundedMetricsFile(PATH, 4096, f.ops).toString('ascii')).toBe(TOKEN);
    expect(f.ops.open).toHaveBeenCalledExactlyOnceWith(PATH, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    expect(f.ops.stat).toHaveBeenCalledExactlyOnceWith(11); expect(f.ops.close).toHaveBeenCalledExactlyOnceWith(11);
    expect(f.events[0]).toBe('open'); expect(f.events[1]).toBe('stat'); expect(f.events.at(-1)).toBe('close');
    expect(f.reads.every(x => x.allocated === 4097 && x.offset >= 0 && x.length === 4097 - x.offset)).toBe(true);
    expect(f.reads.length).toBe(step === 1 ? TOKEN.length + 1 : 2);
  });
  it.each([
    { regular: false, size: TOKEN.length }, { regular: true, size: -1 },
    { regular: true, size: 4097 }, { regular: true, size: Number.NaN },
    { regular: true, size: 1.5 },
  ])('rejects nonregular/invalid metadata before read and closes ownedfd', info => {
    const f = file(Buffer.from(TOKEN)); f.ops.stat.mockReturnValue(info);
    fixedError(() => readBoundedMetricsFile(PATH, 4096, f.ops));
    expect(f.ops.read).not.toHaveBeenCalled(); expect(f.ops.close).toHaveBeenCalledExactlyOnceWith(11);
  });
  it.each(['open', 'stat', 'read', 'close'] as const)('redacts%s failure and owns cleanup', fault => {
    const f = file(Buffer.from(TOKEN));
    f.ops[fault].mockImplementation(() => { throw new Error(PRIVATE + PATH); });
    fixedError(() => readBoundedMetricsFile(PATH, 4096, f.ops));
    expect(f.ops.close).toHaveBeenCalledTimes(fault === 'open' ? 0 : 1);
    if (fault === 'open' || fault === 'stat') expect(f.ops.read).not.toHaveBeenCalled();
  });
  it.each([4096, 4097])('detects growing file boundary%s independent of stale statsize', size => {
    const f = file(Buffer.from('a'.repeat(size))); f.ops.stat.mockReturnValue({ regular: true, size: 0 });
    if (size === 4096) expect(readBoundedMetricsFile(PATH, 4096, f.ops)).toHaveLength(4096);
    else fixedError(() => readBoundedMetricsFile(PATH, 4096, f.ops));
    expect(f.ops.close).toHaveBeenCalledExactlyOnceWith(11);
    expect(f.reads.every(x => x.allocated === 4097 && x.length <= 4097)).toBe(true);
  });
  it.each([-1, Number.NaN, 1.5, 4098])('rejects invalid read progress%s rather than spinning', count => {
    const f = file(Buffer.from(TOKEN)); f.ops.read.mockReturnValue(count);
    fixedError(() => readBoundedMetricsFile(PATH, 4096, f.ops));
    expect(f.ops.read).toHaveBeenCalledTimes(1); expect(f.ops.close).toHaveBeenCalledExactlyOnceWith(11);
  });
  it.each([0, -1, 4097, Number.NaN, 1.5])('rejects invalid bytebudget%s before opening', limit => {
    const f = file(Buffer.from(TOKEN));
    fixedError(() => readBoundedMetricsFile(PATH, limit, f.ops)); expect(f.ops.open).not.toHaveBeenCalled();
    expect(f.ops.close).not.toHaveBeenCalled();
  });
  it('EOF is finite and synthetic reader composes through resolver without default I/O', () => {
    const f = file(Buffer.from(TOKEN + '\n'), 3);
    const reader = vi.fn((path: string, max: number) => readBoundedMetricsFile(path, max, f.ops));
    expect(resolveNativeMetricsToken({ METRICS_TOKEN_FILE: PATH }, reader)).toBe(TOKEN);
    expect(reader).toHaveBeenCalledExactlyOnceWith(PATH, 4096);
    expect(f.ops.close).toHaveBeenCalledExactlyOnceWith(11);
  });
});
