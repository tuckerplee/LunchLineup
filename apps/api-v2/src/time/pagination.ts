import { ProblemError } from '../platform/problem';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TimeCardCursor = {
  clockInAt: Date;
  publicId: string;
};

export function parseTimeCardLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return 100;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw invalidCursorOrLimit('limit must be an integer from 1 through 200.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw invalidCursorOrLimit('limit must be an integer from 1 through 200.');
  }
  return parsed;
}

export function encodeTimeCardCursor(cursor: TimeCardCursor): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    clockInAt: cursor.clockInAt.toISOString(),
    publicId: cursor.publicId,
  }), 'utf8').toString('base64url');
}

export function decodeTimeCardCursor(value: unknown): TimeCardCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512) throw invalidCursorOrLimit('cursor is invalid.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const clockInAt = parseStoredInstant(parsed.clockInAt);
    if (parsed.v !== 1 || typeof parsed.publicId !== 'string' || !UUID.test(parsed.publicId)) {
      throw new Error('invalid cursor');
    }
    return { clockInAt, publicId: parsed.publicId };
  } catch {
    throw invalidCursorOrLimit('cursor is invalid.');
  }
}

export function parseTimeCardInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidTimeCardInput(`${field} is required.`);
  }
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)) {
    throw invalidTimeCardInput(`${field} must use a UTC ISO 8601 instant.`);
  }
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== normalized.slice(0, 19)) {
    throw invalidTimeCardInput(`${field} must use a valid UTC ISO 8601 instant.`);
  }
  return parsed;
}

export function invalidTimeCardInput(detail: string): ProblemError {
  return new ProblemError(422, 'invalid_time_card_input', detail, 'Time-card validation failed');
}

function invalidCursorOrLimit(detail: string): ProblemError {
  return new ProblemError(422, 'invalid_time_card_pagination', detail, 'Time-card pagination failed');
}

function parseStoredInstant(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error('invalid cursor');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid cursor');
  return parsed;
}
