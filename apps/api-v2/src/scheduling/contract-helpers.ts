import { createHash } from 'node:crypto';
import { ProblemError } from '../platform/problem';

const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

export function scheduleEtag(schedulePublicId: string, revision: number): string {
  return `"schedule:${schedulePublicId}:${revision}"`;
}

export function requireScheduleRevision(ifMatch: string | undefined, schedulePublicId: string): number {
  if (!ifMatch?.trim()) {
    throw new ProblemError(
      428,
      'if_match_required',
      'This scheduling write requires an If-Match header from the latest board response.',
      'Precondition required',
    );
  }
  const match = /^"schedule:([0-9a-f-]{36}):(\d+)"$/.exec(ifMatch.trim());
  if (!match || match[1] !== schedulePublicId) {
    throw new ProblemError(
      428,
      'invalid_if_match',
      'If-Match must contain the selected schedule ETag.',
      'Precondition required',
    );
  }
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ProblemError(
      428,
      'invalid_if_match',
      'If-Match must contain a valid schedule revision.',
      'Precondition required',
    );
  }
  return revision;
}

export function requireIdempotencyKey(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new ProblemError(
      428,
      'idempotency_key_required',
      'This write requires an Idempotency-Key containing 8 to 200 safe characters.',
      'Precondition required',
    );
  }
  return normalized;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export function requestHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function parseUtcInstant(value: string, pointer: string): Date {
  const match = UTC_INSTANT.exec(value);
  const parsed = new Date(value);
  if (
    !match
    || !Number.isFinite(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() !== Number(match[2]) - 1
    || parsed.getUTCDate() !== Number(match[3])
    || parsed.getUTCHours() !== Number(match[4])
    || parsed.getUTCMinutes() !== Number(match[5])
    || parsed.getUTCSeconds() !== Number(match[6])
  ) {
    throw new ProblemError(
      422,
      'invalid_utc_instant',
      'Scheduling instants must use a real UTC ISO 8601 value ending in Z.',
      'Schedule validation failed',
      [{ pointer, code: 'invalid_utc_instant', message: 'Use a UTC ISO 8601 instant ending in Z.' }],
    );
  }
  return parsed;
}

export function normalizedRole(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  const role = value.trim();
  if (role.length > 64) {
    throw new ProblemError(
      422,
      'invalid_shift_role',
      'Shift roles must contain 64 characters or fewer.',
      'Schedule validation failed',
    );
  }
  return role;
}
