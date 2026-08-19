import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { InvitationDelivery } from '@lunchlineup/api-contract';
import type { ApiV2Config } from '../config';
import type { TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';

const PURPOSE = 'STAFF_INVITATION' as const;
const MAX_MANUAL_RETRIES = 3;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

type InvitationRow = {
  id: string;
  tenantId: string;
  userId: string;
  recipientHash: string;
  purpose: string;
  encryptedPayload: Buffer | null;
  status: string;
  attempts: number;
  manualRetryCount: number;
  retryAt: Date | null;
  deliveredAt: Date | null;
  deadLetteredAt: Date | null;
  lastErrorCode: string | null;
};

function unavailable(): ProblemError {
  return new ProblemError(
    503,
    'staff_invitation_delivery_unavailable',
    'Staff invitation delivery is temporarily unavailable.',
    'Service unavailable',
  );
}

function conflict(detail: string): ProblemError {
  return new ProblemError(409, 'invitation_delivery_conflict', detail, 'Invitation delivery conflict');
}

function notFound(detail: string): ProblemError {
  return new ProblemError(404, 'invitation_delivery_not_found', detail, 'Invitation delivery not found');
}

function invitationKey(config: Pick<ApiV2Config, 'staffInvitationOutboxEnabled' | 'staffInvitationOutboxEncryptionKey'>): Buffer {
  if (!config.staffInvitationOutboxEnabled) throw unavailable();
  const configured = config.staffInvitationOutboxEncryptionKey.trim();
  if (!configured) throw unavailable();
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(configured)) {
    key = Buffer.from(configured, 'hex');
  } else {
    const normalized = configured.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw unavailable();
    key = Buffer.from(normalized, 'base64');
    if (key.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) throw unavailable();
  }
  if (key.length !== 32) throw unavailable();
  return key;
}

function aad(input: {
  tenantId: string;
  outboxId: string;
  userId: string;
  recipientHash: string;
  payloadVersion: number;
}): Buffer {
  return Buffer.from(JSON.stringify({
    tenantId: input.tenantId,
    outboxId: input.outboxId,
    userId: input.userId,
    recipientHash: input.recipientHash,
    purpose: PURPOSE,
    payloadVersion: input.payloadVersion,
  }), 'utf8');
}

function normalizedIdempotencyKey(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized || normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[\x20-\x7e]+$/.test(normalized)) {
    throw new ProblemError(
      422,
      'invalid_idempotency_key',
      'Idempotency-Key must contain between 1 and 200 printable characters.',
      'Invitation validation failed',
    );
  }
  return normalized;
}

function deterministicReissueId(tenantId: string, userId: string, idempotencyKey: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify({ idempotencyKey, purpose: PURPOSE, tenantId, userId }), 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deliveryResponse(row: InvitationRow, maxAttempts: number): InvitationDelivery {
  const allowed = new Set(['PENDING', 'SENDING', 'FAILED', 'DELIVERED', 'DEAD_LETTERED', 'CANCELLED']);
  if (!allowed.has(row.status)) throw unavailable();
  const status = row.status as InvitationDelivery['status'];
  const canRetry = status === 'FAILED'
    && row.attempts < maxAttempts
    && row.manualRetryCount < MAX_MANUAL_RETRIES
    && Boolean(row.encryptedPayload);
  return {
    deliveryId: row.id,
    status,
    attempts: row.attempts,
    ...(row.retryAt && (status === 'PENDING' || status === 'FAILED')
      ? { nextAttemptAt: row.retryAt.toISOString() }
      : {}),
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt.toISOString() } : {}),
    canRetry,
    canReissue: status === 'DEAD_LETTERED',
  };
}

export function notApplicableDelivery(): InvitationDelivery {
  return {
    status: 'NOT_APPLICABLE',
    attempts: 0,
    canRetry: false,
    canReissue: false,
  };
}

/**
 * Native producer for the existing encrypted invitation outbox. The worker
 * remains the sole sender; API v2 only creates, reads, and safely retries
 * durable delivery commands using the same envelope format it already reads.
 */
export class InvitationOutbox {
  constructor(private readonly config: Pick<
    ApiV2Config,
    'staffInvitationOutboxEnabled' | 'staffInvitationOutboxEncryptionKey' | 'staffInvitationMaxAttempts'
  >) {}

  async enqueue(
    transaction: TenantTransaction,
    input: { tenantId: string; userId: string; recipient: string },
  ): Promise<InvitationDelivery> {
    const key = invitationKey(this.config);
    const recipient = input.recipient.trim().toLowerCase();
    const existing = await transaction.staffInvitationOutbox.findUnique({
      where: {
        tenantId_userId_purpose: {
          tenantId: input.tenantId,
          userId: input.userId,
          purpose: PURPOSE,
        },
      },
      select: { id: true, status: true },
    });
    const terminal = Boolean(existing && ['DELIVERED', 'DEAD_LETTERED', 'CANCELLED'].includes(existing.status));
    const outboxId = !existing || terminal ? randomUUID() : existing.id;
    const data = this.pendingData(key, { ...input, recipient, outboxId });
    const row = existing
      ? await transaction.staffInvitationOutbox.update({
        where: { id: existing.id },
        data: { ...(outboxId === existing.id ? {} : { id: outboxId }), ...data },
      })
      : await transaction.staffInvitationOutbox.create({
        data: { id: outboxId, tenantId: input.tenantId, userId: input.userId, ...data },
      });
    return deliveryResponse(row as InvitationRow, this.config.staffInvitationMaxAttempts);
  }

  async status(transaction: TenantTransaction, tenantId: string, userId: string): Promise<InvitationDelivery> {
    const user = await transaction.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true },
    });
    if (!user) throw notFound('The selected staff member was not found.');
    const row = await this.find(transaction, tenantId, userId);
    return row ? deliveryResponse(row, this.config.staffInvitationMaxAttempts) : notApplicableDelivery();
  }

  async retry(
    transaction: TenantTransaction,
    input: { tenantId: string; userId: string; actorUserId: string },
  ): Promise<InvitationDelivery> {
    invitationKey(this.config);
    const user = await transaction.user.findFirst({
      where: { id: input.userId, tenantId: input.tenantId, deletedAt: null, suspendedAt: null },
      select: { id: true },
    });
    if (!user) throw notFound('The selected staff member was not found.');
    const current = await this.find(transaction, input.tenantId, input.userId);
    if (!current) throw notFound('Invitation delivery was not found.');
    if (current.status === 'PENDING') return deliveryResponse(current, this.config.staffInvitationMaxAttempts);
    if (current.status === 'SENDING') throw conflict('Invitation delivery is currently being sent.');
    if (current.status !== 'FAILED') throw conflict('Invitation delivery is terminal and cannot be retried.');
    if (current.attempts >= this.config.staffInvitationMaxAttempts || current.manualRetryCount >= MAX_MANUAL_RETRIES || !current.encryptedPayload) {
      throw conflict('Invitation delivery retry limit was reached.');
    }
    const updated = await transaction.staffInvitationOutbox.updateMany({
      where: {
        id: current.id,
        tenantId: input.tenantId,
        userId: input.userId,
        purpose: PURPOSE,
        status: 'FAILED',
        attempts: { lt: this.config.staffInvitationMaxAttempts },
        manualRetryCount: { lt: MAX_MANUAL_RETRIES },
        encryptedPayload: { not: null },
      },
      data: {
        status: 'PENDING',
        manualRetryCount: { increment: 1 },
        retryAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      },
    });
    const row = await this.find(transaction, input.tenantId, input.userId);
    if (!row) throw notFound('Invitation delivery was not found.');
    if (updated.count === 0 && row.status !== 'PENDING') throw conflict('Invitation delivery changed before retry.');
    if (updated.count > 0) {
      await transaction.auditLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.actorUserId,
          actorUserId: input.actorUserId,
          actorTenantId: input.tenantId,
          action: 'USER_INVITATION_DELIVERY_RETRIED',
          resource: 'User',
          resourceId: input.userId,
        },
      });
    }
    return deliveryResponse(row, this.config.staffInvitationMaxAttempts);
  }

  async reissue(
    transaction: TenantTransaction,
    input: { tenantId: string; userId: string; actorUserId: string; idempotencyKey?: string },
  ): Promise<InvitationDelivery> {
    const key = invitationKey(this.config);
    const idempotencyKey = normalizedIdempotencyKey(input.idempotencyKey);
    const outboxId = deterministicReissueId(input.tenantId, input.userId, idempotencyKey);
    const replay = await transaction.staffInvitationOutbox.findUnique({ where: { id: outboxId } }) as InvitationRow | null;
    if (replay) {
      if (replay.tenantId !== input.tenantId || replay.userId !== input.userId || replay.purpose !== PURPOSE) {
        throw conflict('Idempotency-Key resolved to a different invitation action.');
      }
      return deliveryResponse(replay, this.config.staffInvitationMaxAttempts);
    }
    const user = await transaction.user.findFirst({
      where: { id: input.userId, tenantId: input.tenantId, deletedAt: null, suspendedAt: null },
      select: { id: true, email: true },
    });
    if (!user) throw notFound('The selected staff member was not found.');
    if (!user.email) throw conflict('This account does not use email invitation delivery.');
    const current = await this.find(transaction, input.tenantId, input.userId);
    if (!current) throw notFound('Invitation delivery was not found.');
    if (current.status !== 'DEAD_LETTERED') throw conflict('Only a dead-lettered invitation can be reissued.');
    const data = this.pendingData(key, {
      tenantId: input.tenantId,
      userId: input.userId,
      recipient: user.email.trim().toLowerCase(),
      outboxId,
    });
    const replaced = await transaction.staffInvitationOutbox.updateMany({
      where: {
        id: current.id,
        tenantId: input.tenantId,
        userId: input.userId,
        purpose: PURPOSE,
        status: 'DEAD_LETTERED',
      },
      data: { id: outboxId, ...data },
    });
    if (replaced.count !== 1) {
      const changed = await transaction.staffInvitationOutbox.findUnique({ where: { id: outboxId } }) as InvitationRow | null;
      if (changed && changed.tenantId === input.tenantId && changed.userId === input.userId && changed.purpose === PURPOSE) {
        return deliveryResponse(changed, this.config.staffInvitationMaxAttempts);
      }
      throw conflict('Invitation delivery changed before reissue.');
    }
    await transaction.auditLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.actorUserId,
        actorUserId: input.actorUserId,
        actorTenantId: input.tenantId,
        action: 'USER_INVITATION_DELIVERY_REISSUED',
        resource: 'StaffInvitationOutbox',
        resourceId: outboxId,
        oldValue: { deliveryId: current.id, status: current.status, attempts: current.attempts },
        newValue: {
          deliveryId: outboxId,
          status: 'PENDING',
          attempts: 0,
          requestKeyHash: createHash('sha256').update(idempotencyKey, 'utf8').digest('hex'),
        },
      },
    });
    const row = await transaction.staffInvitationOutbox.findUnique({ where: { id: outboxId } }) as InvitationRow | null;
    if (!row) throw unavailable();
    return deliveryResponse(row, this.config.staffInvitationMaxAttempts);
  }

  private async find(
    transaction: TenantTransaction,
    tenantId: string,
    userId: string,
  ): Promise<InvitationRow | null> {
    return transaction.staffInvitationOutbox.findUnique({
      where: { tenantId_userId_purpose: { tenantId, userId, purpose: PURPOSE } },
    }) as Promise<InvitationRow | null>;
  }

  private pendingData(
    key: Buffer,
    input: { tenantId: string; userId: string; recipient: string; outboxId: string },
  ) {
    const recipientHash = createHmac('sha256', key).update(input.recipient, 'utf8').digest('hex');
    const payloadVersion = 1;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad({
      tenantId: input.tenantId,
      outboxId: input.outboxId,
      userId: input.userId,
      recipientHash,
      payloadVersion,
    }));
    const encryptedPayload = Buffer.concat([
      cipher.update(JSON.stringify({ recipient: input.recipient, template: 'staff_invitation' }), 'utf8'),
      cipher.final(),
    ]);
    return {
      recipientHash,
      purpose: PURPOSE,
      encryptedPayload,
      encryptionNonce: nonce,
      encryptionTag: cipher.getAuthTag(),
      encryptionKeyRef: createHash('sha256').update(key).digest('hex').slice(0, 16),
      payloadVersion,
      status: 'PENDING' as const,
      attempts: 0,
      manualRetryCount: 0,
      retryAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      providerMessageId: null,
      lastErrorCode: null,
      deliveredAt: null,
      deadLetteredAt: null,
      cancelledAt: null,
      payloadErasedAt: null,
      diagnosticsEraseAfter: null,
      diagnosticsErasedAt: null,
    };
  }
}
