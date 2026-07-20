import type { Prisma } from '@prisma/client';
import type {
  NotificationListQuery,
  NotificationListResponse,
  NotificationReadAllResponse,
  NotificationReadResponse,
  NotificationRecord,
  SessionIdentity,
} from '@lunchlineup/api-contract';
import type { TenantDatabase } from '../platform/database';
import { ProblemError } from '../platform/problem';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NOTIFICATION_SELECT = {
  publicId: true,
  type: true,
  title: true,
  body: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

type NotificationCursor = {
  createdAt: Date;
  publicId: string;
};

type NotificationRow = {
  publicId: string;
  type: NotificationRecord['type'];
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
};

function notificationProblem(code: string, detail: string): ProblemError {
  return new ProblemError(422, code, detail, 'Notification request failed');
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(value)) {
    throw notificationProblem('invalid_notification_limit', 'limit must be a whole number.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw notificationProblem('invalid_notification_limit', `limit must be between 1 and ${MAX_LIMIT}.`);
  }
  return parsed;
}

function encodeCursor(row: Pick<NotificationCursor, 'createdAt' | 'publicId'>): string {
  return Buffer.from(JSON.stringify({
    createdAt: row.createdAt.toISOString(),
    publicId: row.publicId,
  }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): NotificationCursor | null {
  if (value === undefined) return null;
  if (!value || value.length > MAX_CURSOR_LENGTH) {
    throw notificationProblem('invalid_notification_cursor', 'cursor is invalid.');
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      publicId?: unknown;
    };
    if (typeof decoded.createdAt !== 'string' || typeof decoded.publicId !== 'string' || !UUID_PATTERN.test(decoded.publicId)) {
      throw new Error('Invalid cursor structure');
    }
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== decoded.createdAt) {
      throw new Error('Invalid cursor timestamp');
    }
    return { createdAt, publicId: decoded.publicId };
  } catch {
    throw notificationProblem('invalid_notification_cursor', 'cursor is invalid.');
  }
}

function normalizePublicIds(ids: readonly string[]): string[] {
  if (ids.length < 1 || ids.length > MAX_LIMIT) {
    throw notificationProblem('invalid_notification_ids', `ids must contain between 1 and ${MAX_LIMIT} public UUIDs.`);
  }
  const unique = new Set(ids);
  if (unique.size !== ids.length || ids.some((id) => !UUID_PATTERN.test(id))) {
    throw notificationProblem('invalid_notification_ids', 'ids must contain unique public UUIDs.');
  }
  return [...unique];
}

function serialize(row: NotificationRow): NotificationRecord {
  return {
    id: row.publicId,
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Native API-02 notification-feed owner. Notification delivery and feed
 * creation remain decoupled: this owner only exposes the tenant/session
 * scoped durable records and never sends a request through API v1.
 */
export class NotificationService {
  constructor(private readonly database: Pick<TenantDatabase, 'withTenant'>) {}

  async list(identity: SessionIdentity, query: NotificationListQuery): Promise<NotificationListResponse> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const unreadOnly = query.status === 'unread';
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const where: Prisma.NotificationWhereInput = {
        tenantId: identity.tenantId,
        userId: identity.sub,
        ...(unreadOnly ? { readAt: null } : {}),
        ...(cursor
          ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, publicId: { lt: cursor.publicId } },
            ],
          }
          : {}),
      };
      const [rows, unreadCount] = await Promise.all([
        transaction.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { publicId: 'desc' }],
          take: limit + 1,
          select: NOTIFICATION_SELECT,
        }),
        transaction.notification.count({
          where: { tenantId: identity.tenantId, userId: identity.sub, readAt: null },
        }),
      ]);
      const page = (rows as NotificationRow[]).slice(0, limit);
      const hasMore = rows.length > limit;
      return {
        data: page.map(serialize),
        unreadCount,
        pagination: {
          limit,
          maxLimit: MAX_LIMIT,
          returned: page.length,
          hasMore,
          nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
        },
      };
    });
  }

  async markRead(identity: SessionIdentity, ids: readonly string[]): Promise<NotificationReadResponse> {
    const publicIds = normalizePublicIds(ids);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const updated = await transaction.notification.updateMany({
        where: {
          tenantId: identity.tenantId,
          userId: identity.sub,
          publicId: { in: publicIds },
          readAt: null,
        },
        data: { readAt: new Date() },
      });
      const unreadCount = await transaction.notification.count({
        where: { tenantId: identity.tenantId, userId: identity.sub, readAt: null },
      });
      return { updated: updated.count, unreadCount };
    });
  }

  async markAllRead(identity: SessionIdentity): Promise<NotificationReadAllResponse> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const updated = await transaction.notification.updateMany({
        where: { tenantId: identity.tenantId, userId: identity.sub, readAt: null },
        data: { readAt: new Date() },
      });
      return { success: true, updated: updated.count, unreadCount: 0 };
    });
  }
}
