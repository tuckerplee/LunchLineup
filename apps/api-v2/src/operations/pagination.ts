import type { BoundedPagination } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';

const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export type OperationsCursor = {
  timestamp: Date;
  publicId: string;
};

export type OperationsWindow = {
  startDate?: Date;
  endDate?: Date;
};

export function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw invalidPagination('limit must be an integer from 1 through 200.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw invalidPagination('limit must be an integer from 1 through 200.');
  }
  return parsed;
}

export function parseOptionalInstant(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) {
    throw invalidPagination(`${field} must be a UTC ISO 8601 instant.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalidPagination(`${field} must be a UTC ISO 8601 instant.`);
  }
  return parsed;
}

export function parseWindow(input: { startDate?: unknown; endDate?: unknown }): OperationsWindow {
  const window = {
    startDate: parseOptionalInstant(input.startDate, 'startDate'),
    endDate: parseOptionalInstant(input.endDate, 'endDate'),
  };
  if (window.startDate && window.endDate && window.endDate <= window.startDate) {
    throw invalidPagination('endDate must be after startDate.');
  }
  return window;
}

export function decodeCursor(value: unknown): OperationsCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512) throw invalidPagination('cursor is invalid.');
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      payload.v !== 1
      || typeof payload.timestamp !== 'string'
      || typeof payload.publicId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(payload.publicId)
    ) throw new Error('invalid cursor');
    const timestamp = new Date(payload.timestamp);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== payload.timestamp) {
      throw new Error('invalid cursor');
    }
    return { timestamp, publicId: payload.publicId };
  } catch {
    throw invalidPagination('cursor is invalid.');
  }
}

export function page<T>(
  rows: readonly T[],
  limit: number,
  rowCursor: (row: T) => { timestamp: Date; publicId: string },
  window: OperationsWindow = {},
): { data: T[]; pagination: BoundedPagination } {
  const hasMore = rows.length > limit;
  const data = hasMore ? [...rows.slice(0, limit)] : [...rows];
  const last = hasMore ? data.at(-1) : undefined;
  return {
    data,
    pagination: {
      limit,
      maxLimit: 200,
      returned: data.length,
      hasMore,
      nextCursor: last ? encodeCursor(rowCursor(last)) : null,
      window: {
        startDate: window.startDate?.toISOString() ?? null,
        endDate: window.endDate?.toISOString() ?? null,
      },
    },
  };
}

export function invalidPagination(detail: string): ProblemError {
  return new ProblemError(422, 'invalid_pagination', detail, 'Pagination validation failed');
}

function encodeCursor(cursor: { timestamp: Date; publicId: string }): string {
  if (!Number.isFinite(cursor.timestamp.getTime()) || !/^[0-9a-f-]{36}$/i.test(cursor.publicId)) {
    throw new Error('Cannot encode an operations cursor.');
  }
  return Buffer.from(JSON.stringify({
    v: 1,
    timestamp: cursor.timestamp.toISOString(),
    publicId: cursor.publicId,
  }), 'utf8').toString('base64url');
}
