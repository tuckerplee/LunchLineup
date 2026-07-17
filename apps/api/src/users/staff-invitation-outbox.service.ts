import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
    createCipheriv,
    createHash,
    createHmac,
    randomBytes,
    randomUUID,
} from 'node:crypto';

import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';

const ENCRYPTION_KEY_ENV = 'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY';
const ENABLED_ENV = 'STAFF_INVITATION_OUTBOX_ENABLED';
const MAX_ATTEMPTS_ENV = 'STAFF_INVITATION_MAX_ATTEMPTS';
const PURPOSE = 'STAFF_INVITATION' as const;
const DEFAULT_MAX_ATTEMPTS = 8;
const SCHEMA_MAX_ATTEMPTS = 8;
const MAX_MANUAL_RETRIES = 3;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const TERMINAL_DIAGNOSTIC_RETENTION_DAYS = 30;
const RETENTION_BATCH_LIMIT = 5_000;

type InvitationOutboxRow = {
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

export type InvitationDeliveryResponse = {
    deliveryId?: string;
    status: 'not_applicable' | 'queued' | 'sending' | 'failed' | 'delivered' | 'dead_lettered' | 'cancelled';
    attempts: number;
    nextAttemptAt?: Date;
    deliveredAt?: Date;
    canRetry: boolean;
    canReissue: boolean;
};

export function staffInvitationOutboxAad(input: {
    tenantId: string;
    outboxId: string;
    userId: string;
    recipientHash: string;
    purpose: string;
    payloadVersion: number;
}): Buffer {
    return Buffer.from(JSON.stringify({
        tenantId: input.tenantId,
        outboxId: input.outboxId,
        userId: input.userId,
        recipientHash: input.recipientHash,
        purpose: input.purpose,
        payloadVersion: input.payloadVersion,
    }), 'utf8');
}

@Injectable()
export class StaffInvitationOutboxService implements OnModuleInit {
    constructor(private readonly configService: ConfigService) {}
    onModuleInit(): void {
        if (this.configService.get<string>('NODE_ENV') === 'production') {
            this.validateConfiguration();
        }
    }


    validateConfiguration(): void {
        this.assertEnabled();
        this.encryptionKey();
        this.maxAttempts();
    }

    async enqueueInTransaction(
        tx: TenantPrismaTransaction,
        input: { tenantId: string; userId: string; recipient: string },
    ): Promise<InvitationOutboxRow> {
        this.assertEnabled();
        this.maxAttempts();
        const key = this.encryptionKey();
        const recipient = input.recipient.trim().toLowerCase();
        const existing = await tx.staffInvitationOutbox.findUnique({
            where: {
                tenantId_userId_purpose: {
                    tenantId: input.tenantId,
                    userId: input.userId,
                    purpose: PURPOSE,
                },
            },
            select: { id: true, status: true },
        });
        const terminalAction = existing
            && ['DELIVERED', 'DEAD_LETTERED', 'CANCELLED'].includes(existing.status);
        const outboxId = !existing || terminalAction ? randomUUID() : existing.id;
        const data = this.pendingDeliveryData({
            key,
            tenantId: input.tenantId,
            userId: input.userId,
            outboxId,
            recipient,
        });

        if (existing) {
            return tx.staffInvitationOutbox.update({
                where: { id: existing.id },
                data: {
                    ...(outboxId !== existing.id ? { id: outboxId } : {}),
                    ...data,
                },
            }) as Promise<InvitationOutboxRow>;
        }
        return tx.staffInvitationOutbox.create({
            data: {
                id: outboxId,
                tenantId: input.tenantId,
                userId: input.userId,
                ...data,
            },
        }) as Promise<InvitationOutboxRow>;
    }

    async statusInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userId: string,
    ): Promise<InvitationDeliveryResponse> {
        const user = await tx.user.findFirst({
            where: { id: userId, tenantId },
            select: { id: true },
        });
        if (!user) throw new NotFoundException('User not found');

        const row = await this.findInvitation(tx, tenantId, userId);
        return row ? this.toResponse(row) : this.notApplicable();
    }

    async retryInTransaction(
        tx: TenantPrismaTransaction,
        input: { tenantId: string; userId: string; actorUserId: string },
    ): Promise<InvitationDeliveryResponse> {
        this.assertEnabled();
        const maxAttempts = this.maxAttempts();
        const user = await tx.user.findFirst({
            where: {
                id: input.userId,
                tenantId: input.tenantId,
                deletedAt: null,
                suspendedAt: null,
            },
            select: { id: true },
        });
        if (!user) throw new NotFoundException('User not found');

        const current = await this.findInvitation(tx, input.tenantId, input.userId);
        if (!current) throw new NotFoundException('Invitation delivery not found');
        if (current.status === 'PENDING') return this.toResponse(current);
        if (current.status === 'SENDING') {
            throw new ConflictException('Invitation delivery is currently leased');
        }
        if (current.status !== 'FAILED') {
            throw new ConflictException('Invitation delivery is terminal and cannot be retried');
        }
        if (
            current.attempts >= maxAttempts
            || current.manualRetryCount >= MAX_MANUAL_RETRIES
            || !current.encryptedPayload
        ) {
            throw new ConflictException('Invitation delivery retry limit reached');
        }

        const updated = await tx.staffInvitationOutbox.updateMany({
            where: {
                id: current.id,
                tenantId: input.tenantId,
                userId: input.userId,
                purpose: PURPOSE,
                status: 'FAILED',
                attempts: { lt: maxAttempts },
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
        const row = await this.findInvitation(tx, input.tenantId, input.userId);
        if (!row) throw new NotFoundException('Invitation delivery not found');
        if (updated.count === 0 && row.status !== 'PENDING') {
            throw new ConflictException('Invitation delivery changed before retry');
        }
        if (updated.count > 0) {
            await tx.auditLog.create({
                data: {
                    tenantId: input.tenantId,
                    userId: input.actorUserId,
                    action: 'USER_INVITATION_DELIVERY_RETRIED',
                    resource: 'User',
                    resourceId: input.userId,
                },
            });
        }
        return this.toResponse(row);
    }

    async reissueInTransaction(
        tx: TenantPrismaTransaction,
        input: {
            tenantId: string;
            userId: string;
            actorUserId: string;
            idempotencyKey: string | undefined;
        },
    ): Promise<InvitationDeliveryResponse> {
        this.assertEnabled();
        this.maxAttempts();
        const key = this.encryptionKey();
        const idempotencyKey = this.normalizeIdempotencyKey(input.idempotencyKey);
        const outboxId = this.reissueDeliveryId(input.tenantId, input.userId, idempotencyKey);

        const existingAction = await this.findInvitationById(tx, outboxId);
        if (existingAction) {
            this.assertSameInvitation(existingAction, input.tenantId, input.userId);
            return this.toResponse(existingAction);
        }

        const priorAction = await tx.auditLog.findFirst({
            where: {
                tenantId: input.tenantId,
                action: 'USER_INVITATION_DELIVERY_REISSUED',
                resource: 'StaffInvitationOutbox',
                resourceId: outboxId,
            },
            select: { id: true },
        });
        if (priorAction) {
            throw new ConflictException(
                'This invitation reissue key already completed; use a new Idempotency-Key',
            );
        }

        const user = await tx.user.findFirst({
            where: {
                id: input.userId,
                tenantId: input.tenantId,
                deletedAt: null,
                suspendedAt: null,
            },
            select: { id: true, email: true },
        });
        if (!user) throw new NotFoundException('User not found');
        if (!user.email) {
            throw new ConflictException('This account does not use email invitation delivery');
        }

        const current = await this.findInvitation(tx, input.tenantId, input.userId);
        if (!current) throw new NotFoundException('Invitation delivery not found');
        if (current.status !== 'DEAD_LETTERED') {
            throw new ConflictException('Only a dead-lettered invitation can be reissued');
        }

        const data = this.pendingDeliveryData({
            key,
            tenantId: input.tenantId,
            userId: input.userId,
            outboxId,
            recipient: user.email.trim().toLowerCase(),
        });
        const replaced = await tx.staffInvitationOutbox.updateMany({
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
            const replay = await this.findInvitationById(tx, outboxId);
            if (replay) {
                this.assertSameInvitation(replay, input.tenantId, input.userId);
                return this.toResponse(replay);
            }
            throw new ConflictException('Invitation delivery changed before reissue');
        }

        await tx.auditLog.create({
            data: {
                tenantId: input.tenantId,
                userId: input.actorUserId,
                actorUserId: input.actorUserId,
                actorTenantId: input.tenantId,
                action: 'USER_INVITATION_DELIVERY_REISSUED',
                resource: 'StaffInvitationOutbox',
                resourceId: outboxId,
                oldValue: {
                    deliveryId: current.id,
                    status: current.status,
                    attempts: current.attempts,
                    manualRetryCount: current.manualRetryCount,
                    deadLetteredAt: current.deadLetteredAt?.toISOString() ?? null,
                    lastErrorCode: current.lastErrorCode,
                },
                newValue: {
                    deliveryId: outboxId,
                    status: 'PENDING',
                    attempts: 0,
                    requestKeyHash: createHash('sha256').update(idempotencyKey, 'utf8').digest('hex'),
                },
            },
        });

        const reissued = await this.findInvitationById(tx, outboxId);
        if (!reissued) throw new ServiceUnavailableException('Invitation reissue was not persisted');
        return this.toResponse(reissued);
    }

    private findInvitation(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userId: string,
    ): Promise<InvitationOutboxRow | null> {
        return tx.staffInvitationOutbox.findUnique({
            where: {
                tenantId_userId_purpose: {
                    tenantId,
                    userId,
                    purpose: PURPOSE,
                },
            },
        }) as Promise<InvitationOutboxRow | null>;
    }

    private findInvitationById(
        tx: TenantPrismaTransaction,
        id: string,
    ): Promise<InvitationOutboxRow | null> {
        return tx.staffInvitationOutbox.findUnique({ where: { id } }) as Promise<InvitationOutboxRow | null>;
    }

    toResponse(row: InvitationOutboxRow): InvitationDeliveryResponse {
        const maxAttempts = this.maxAttempts();
        const statuses: Record<string, InvitationDeliveryResponse['status']> = {
            PENDING: 'queued',
            SENDING: 'sending',
            FAILED: 'failed',
            DELIVERED: 'delivered',
            DEAD_LETTERED: 'dead_lettered',
            CANCELLED: 'cancelled',
        };
        const status = statuses[row.status];
        if (!status) throw new ServiceUnavailableException('Invitation delivery state is invalid');
        const canRetry = row.status === 'FAILED'
            && row.attempts < maxAttempts
            && row.manualRetryCount < MAX_MANUAL_RETRIES
            && Boolean(row.encryptedPayload);
        return {
            deliveryId: row.id,
            status,
            attempts: row.attempts,
            ...(row.retryAt && (row.status === 'PENDING' || row.status === 'FAILED')
                ? { nextAttemptAt: row.retryAt }
                : {}),
            ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {}),
            canRetry,
            canReissue: row.status === 'DEAD_LETTERED',
        };
    }

    notApplicable(): InvitationDeliveryResponse {
        return {
            status: 'not_applicable',
            attempts: 0,
            canRetry: false,
            canReissue: false,
        };
    }

    private pendingDeliveryData(input: {
        key: Buffer;
        tenantId: string;
        userId: string;
        outboxId: string;
        recipient: string;
    }) {
        const recipientHash = createHmac('sha256', input.key)
            .update(input.recipient, 'utf8')
            .digest('hex');
        const payloadVersion = 1;
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', input.key, nonce, { authTagLength: 16 });
        cipher.setAAD(staffInvitationOutboxAad({
            tenantId: input.tenantId,
            outboxId: input.outboxId,
            userId: input.userId,
            recipientHash,
            purpose: PURPOSE,
            payloadVersion,
        }));
        const encryptedPayload = Buffer.concat([
            cipher.update(JSON.stringify({
                recipient: input.recipient,
                template: 'staff_invitation',
            }), 'utf8'),
            cipher.final(),
        ]);
        return {
            recipientHash,
            purpose: PURPOSE,
            encryptedPayload,
            encryptionNonce: nonce,
            encryptionTag: cipher.getAuthTag(),
            encryptionKeyRef: createHash('sha256').update(input.key).digest('hex').slice(0, 16),
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

    private normalizeIdempotencyKey(value: string | undefined): string {
        const normalized = value?.trim() ?? '';
        if (
            normalized.length < 1
            || normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH
            || !/^[\x20-\x7e]+$/.test(normalized)
        ) {
            throw new BadRequestException(
                'Idempotency-Key must contain between 1 and 200 printable characters',
            );
        }
        return normalized;
    }

    private reissueDeliveryId(tenantId: string, userId: string, idempotencyKey: string): string {
        const bytes = createHash('sha256')
            .update(JSON.stringify({ idempotencyKey, purpose: PURPOSE, tenantId, userId }), 'utf8')
            .digest()
            .subarray(0, 16);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = bytes.toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    private assertSameInvitation(
        row: InvitationOutboxRow,
        tenantId: string,
        userId: string,
    ): void {
        if (row.tenantId !== tenantId || row.userId !== userId || row.purpose !== PURPOSE) {
            throw new ConflictException('Idempotency-Key resolved to a different invitation action');
        }
    }

    private assertEnabled(): void {
        const enabled = String(this.configService.get(ENABLED_ENV) ?? '');
        if (enabled !== 'true') {
            throw new ServiceUnavailableException('Staff invitation delivery is unavailable');
        }
    }

    private maxAttempts(): number {
        const configured = String(
            this.configService.get(MAX_ATTEMPTS_ENV) ?? DEFAULT_MAX_ATTEMPTS,
        );
        if (!/^[1-8]$/.test(configured)) {
            throw new ServiceUnavailableException('Staff invitation delivery is unavailable');
        }
        const maxAttempts = Number(configured);
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts > SCHEMA_MAX_ATTEMPTS) {
            throw new ServiceUnavailableException('Staff invitation delivery is unavailable');
        }
        return maxAttempts;
    }

    private encryptionKey(): Buffer {
        const configured = String(this.configService.get(ENCRYPTION_KEY_ENV) ?? '').trim();
        if (!configured) {
            throw new ServiceUnavailableException('Staff invitation delivery is unavailable');
        }
        let key: Buffer;
        if (/^[a-f0-9]{64}$/i.test(configured)) {
            key = Buffer.from(configured, 'hex');
        } else {
            const normalized = configured.replace(/-/g, '+').replace(/_/g, '/');
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
                throw new ServiceUnavailableException('Staff invitation delivery is unavailable');
            }
            key = Buffer.from(normalized, 'base64');
            if (key.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
                throw new ServiceUnavailableException('Staff invitation delivery is unavailable');
            }
        }
        if (key.length !== 32) {
            throw new ServiceUnavailableException('Staff invitation delivery is unavailable');
        }
        return key;
    }
}

export async function applyStaffInvitationOutboxRetention(
    tx: Prisma.TransactionClient,
    asOf: Date,
    dryRun: boolean,
) {
    const terminalBefore = new Date(
        asOf.getTime() - TERMINAL_DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );
    const rows = await tx.$queryRaw<Array<{ eligibleCount: bigint | number }>>(Prisma.sql`
        SELECT COUNT(*) AS "eligibleCount"
        FROM "StaffInvitationOutbox"
        WHERE "status" IN ('DELIVERED', 'DEAD_LETTERED', 'CANCELLED')
          AND "diagnosticsEraseAfter" <= ${asOf}
          AND "diagnosticsErasedAt" IS NULL
    `);
    const eligibleCount = Number(rows[0]?.eligibleCount ?? 0);
    if (!Number.isSafeInteger(eligibleCount) || eligibleCount < 0) {
        throw new Error('Staff invitation retention count is invalid');
    }
    let purgedCount = 0;
    if (!dryRun && eligibleCount > 0) {
        const purged = await tx.$queryRaw<Array<{ purgedCount: bigint | number }>>(Prisma.sql`
            SELECT public.purge_staff_invitation_outbox_diagnostics(
                ${asOf},
                ${RETENTION_BATCH_LIMIT}
            ) AS "purgedCount"
        `);
        purgedCount = Number(purged[0]?.purgedCount ?? 0);
        if (!Number.isSafeInteger(purgedCount) || purgedCount < 0) {
            throw new Error('Staff invitation retention purge is invalid');
        }
    }
    return {
        retentionDays: TERMINAL_DIAGNOSTIC_RETENTION_DAYS,
        terminalBefore: terminalBefore.toISOString(),
        batchLimit: RETENTION_BATCH_LIMIT,
        eligibleCount,
        purgedCount,
    };
}
