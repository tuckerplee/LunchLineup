import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { mkdir, open, readdir, stat, unlink } from 'fs/promises';
import { basename, extname, join, resolve, sep } from 'path';

import { FeatureAccessService } from '../billing/feature-access.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { AvailabilityImportPublisher } from './availability-imports.publisher';

export const MAX_AVAILABILITY_PDF_BYTES = 5 * 1024 * 1024;
const MAX_FILENAME_BYTES = 255;
const MAX_IDEMPOTENCY_KEY_BYTES = 255;
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;
export const AVAILABILITY_IMPORT_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const PDF_MIME = 'application/pdf';
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');
const ENCRYPTED_SOURCE_MAGIC = Buffer.from('LLAI', 'ascii');
const ENCRYPTED_SOURCE_VERSION = 3;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const STAFF_IDENTITY_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/;

export type UploadedAvailabilityPdf = {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
    size: number;
};

type CreateImportArgs = {
    tenantId: string;
    requestedByUserId: string;
    userId: string;
    idempotencyKey: string;
    staffIdentity?: unknown;
    file?: UploadedAvailabilityPdf;
};

type ImportRow = {
    id: string;
    userId: string;
    requestHash: string;
    targetIdentityHash: string;
    fileSha256: string;
    status: string;
    parsedAvailability: unknown;
    resultErasedAt: Date | null;
    failureCode: string | null;
    creditConsumption: unknown;
    createdAt: Date;
    completedAt: Date | null;
};

type CreditLedgerRow = {
    id: string;
    amount: number;
};

export type AvailabilityImportSettlement = {
    chargedCredits: number;
    refundedCredits: number;
    pending: boolean;
};

function availabilityImportLedgerIds(importId: string) {
    return {
        debit: `feature-usage-availability-import:${importId}`,
        refund: `feature-refund-availability-import:${importId}`,
    };
}

export function validateAvailabilityPdf(file?: UploadedAvailabilityPdf): UploadedAvailabilityPdf {
    if (!file || !Buffer.isBuffer(file.buffer)) {
        throw new BadRequestException('A PDF file is required.');
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size !== file.buffer.length) {
        throw new BadRequestException('The uploaded PDF is empty or invalid.');
    }
    if (file.size > MAX_AVAILABILITY_PDF_BYTES) {
        throw new BadRequestException('The uploaded PDF exceeds the 5 MiB limit.');
    }
    if (file.mimetype.toLowerCase() !== PDF_MIME) {
        throw new BadRequestException('The uploaded file must declare application/pdf.');
    }
    const name = basename(file.originalname || '');
    if (
        !name
        || name !== file.originalname
        || Buffer.byteLength(name, 'utf8') > MAX_FILENAME_BYTES
        || /[\u0000-\u001f\u007f]/.test(name)
        || extname(name).toLowerCase() !== '.pdf'
    ) {
        throw new BadRequestException('The uploaded file must have a valid .pdf filename.');
    }
    if (file.buffer.subarray(0, PDF_SIGNATURE.length).compare(PDF_SIGNATURE) !== 0) {
        throw new BadRequestException('The uploaded file does not have a valid PDF signature.');
    }
    return file;
}

export function normalizeImportIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key is required.');
    }
    const key = value.trim();
    if (
        Buffer.byteLength(key, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES
        || /[\u0000-\u001f\u007f]/.test(key)
    ) {
        throw new BadRequestException('Idempotency-Key must contain at most 255 printable bytes.');
    }
    return key;
}

export function normalizeAvailabilityImportStaffIdentity(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
        throw new BadRequestException('Employee or staff ID must be a visible identifier from the PDF.');
    }
    const identity = value.trim();
    if (!identity) return null;
    if (!STAFF_IDENTITY_PATTERN.test(identity)) {
        throw new BadRequestException(
            'Employee or staff ID must be 1 to 128 letters, numbers, or . _ : @ + - characters.',
        );
    }
    return identity.toLowerCase();
}

export function availabilityImportDocumentIdentityHash(identity: string): string {
    const normalized = normalizeAvailabilityImportStaffIdentity(identity);
    if (!normalized) {
        throw new BadRequestException('Employee or staff ID is required.');
    }
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function availabilityImportAccountIdentityHash(target: { id: string; username?: string | null }): string {
    const username = typeof target.username === 'string' ? target.username.trim() : '';
    const identity = STAFF_IDENTITY_PATTERN.test(username) ? username.toLowerCase() : target.id.toLowerCase();
    return createHash('sha256').update(identity, 'utf8').digest('hex');
}

type AvailabilityImportSourceBinding = {
    envelopeVersion: number;
    tenantId: string;
    importId: string;
    fileSha256: string;
    requestHash: string;
    targetIdentityHash: string;
};

export function availabilityImportSourceAad(binding: AvailabilityImportSourceBinding): Buffer {
    return Buffer.from(
        JSON.stringify({
            envelopeVersion: binding.envelopeVersion,
            fileSha256: binding.fileSha256,
            importId: binding.importId,
            requestHash: binding.requestHash,
            targetIdentityHash: binding.targetIdentityHash,
            tenantId: binding.tenantId,
        }),
        'utf8',
    );
}

export function encryptAvailabilityImportSource(
    plaintext: Buffer,
    binding: Omit<AvailabilityImportSourceBinding, 'envelopeVersion'>,
    configuredKey = process.env.AVAILABILITY_IMPORT_ENCRYPTION_KEY,
): Buffer {
    const key = decodeAvailabilityImportEncryptionKey(configuredKey);
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
    cipher.setAAD(availabilityImportSourceAad({
        envelopeVersion: ENCRYPTED_SOURCE_VERSION,
        ...binding,
    }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([
        ENCRYPTED_SOURCE_MAGIC,
        Buffer.from([ENCRYPTED_SOURCE_VERSION]),
        nonce,
        cipher.getAuthTag(),
        ciphertext,
    ]);
}

function decodeAvailabilityImportEncryptionKey(configured: string | undefined): Buffer {
    const value = configured?.trim();
    if (!value) throw new ServiceUnavailableException('Availability import encryption is unavailable.');
    let decoded: Buffer;
    if (/^[a-f0-9]{64}$/i.test(value)) {
        decoded = Buffer.from(value, 'hex');
    } else {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
            throw new ServiceUnavailableException('Availability import encryption is unavailable.');
        }
        decoded = Buffer.from(normalized, 'base64');
        if (decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
            throw new ServiceUnavailableException('Availability import encryption is unavailable.');
        }
    }
    if (decoded.length !== 32) {
        throw new ServiceUnavailableException('Availability import encryption is unavailable.');
    }
    return decoded;
}

export async function deleteAvailabilityImportStorageKeys(
    storageKeys: readonly string[],
    uploadRoot = process.env.AVAILABILITY_UPLOAD_ROOT || '/app/uploads',
): Promise<void> {
    const root = resolve(uploadRoot);
    await Promise.all(storageKeys.map(async (storageKey) => {
        if (!/^[a-f0-9-]{36}\.pdf$/i.test(storageKey)) return;
        const path = resolve(join(root, storageKey));
        if (path === root || !path.startsWith(`${root}${sep}`)) return;
        try {
            await unlink(path);
        } catch {
            // The bounded orphan sweep recovers files a replica cannot remove after commit.
        }
    }));
}

@Injectable()
export class AvailabilityImportsService implements OnModuleInit, OnModuleDestroy {
    private cleanupTimer?: NodeJS.Timeout;
    private readonly uploadRoot = resolve(process.env.AVAILABILITY_UPLOAD_ROOT || '/app/uploads');
    private localStorageReady = true;

    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly featureAccess: FeatureAccessService,
        private readonly publisher: AvailabilityImportPublisher,
    ) {}

    async onModuleInit(): Promise<void> {
        try {
            await mkdir(this.uploadRoot, { recursive: true, mode: 0o700 });
        } catch {
            // Durable encrypted database storage remains authoritative.
            this.localStorageReady = false;
        }
        this.cleanupTimer = setInterval(() => void this.cleanupOrphans(), CLEANUP_INTERVAL_MS);
        this.cleanupTimer.unref();
    }

    onModuleDestroy(): void {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    }

    async createImport(args: CreateImportArgs) {
        if (!this.publisher.isReady()) {
            throw new ServiceUnavailableException('Availability import publishing is draining.');
        }
        const file = validateAvailabilityPdf(args.file);
        const idempotencyKey = normalizeImportIdempotencyKey(args.idempotencyKey);
        const suppliedIdentity = normalizeAvailabilityImportStaffIdentity(args.staffIdentity);
        if (!suppliedIdentity) {
            throw new BadRequestException('Employee or staff ID is required.');
        }
        const documentIdentityHash = availabilityImportDocumentIdentityHash(suppliedIdentity);
        const importId = randomUUID();
        const fileSha256 = createHash('sha256').update(file.buffer).digest('hex');
        const requestKeyHash = this.digest(`${args.tenantId}:${idempotencyKey}`);
        // Identity-bound jobs use requestHash as the non-reversible document identity contract.
        const requestHash = documentIdentityHash;

        let storageKey: string | null = null;
        let storagePath: string | null = null;

        let row: ImportRow;
        let replayed = false;
        try {
            const prepared = await this.tenantDb.withTenant(args.tenantId, async (tx: any) => {
                const existing = await tx.availabilityImportJob.findUnique({
                    where: { tenantId_requestKeyHash: { tenantId: args.tenantId, requestKeyHash } },
                });
                if (existing) {
                    if (!this.matchesImportRequest(existing, args.userId, fileSha256, documentIdentityHash)) {
                        throw new ConflictException('Idempotency-Key was already used for a different availability import.');
                    }
                    return { row: existing as ImportRow, replayed: true };
                }

                const target = await tx.user.findFirst({
                    where: {
                        id: args.userId,
                        tenantId: args.tenantId,
                        deletedAt: null,
                        suspendedAt: null,
                        role: { in: ['MANAGER', 'STAFF'] },
                    },
                    select: { id: true, username: true },
                });
                if (!target) throw new NotFoundException('Staff member not found.');
                const targetIdentityHash = availabilityImportAccountIdentityHash(target);
                const encryptedSourcePayload = encryptAvailabilityImportSource(file.buffer, {
                    tenantId: args.tenantId,
                    importId,
                    fileSha256,
                    requestHash,
                    targetIdentityHash,
                });

                if (this.localStorageReady) {
                    storageKey = `${randomUUID()}.pdf`;
                    storagePath = this.storagePath(storageKey);
                    try {
                        await this.writeExclusive(storagePath, encryptedSourcePayload);
                    } catch {
                        await this.safeUnlink(storagePath);
                        storageKey = null;
                        storagePath = null;
                        this.localStorageReady = false;
                    }
                }

                const entitlement = await this.featureAccess.assertFeatureEnabledInTransaction(
                    tx,
                    args.tenantId,
                    'scheduling',
                );
                await tx.availabilityImportJob.create({
                    data: {
                        id: importId,
                        tenantId: args.tenantId,
                        userId: args.userId,
                        requestedByUserId: args.requestedByUserId,
                        requestKeyHash,
                        requestHash,
                        targetIdentityHash,
                        storageKey,
                        encryptedSourcePayload,
                        fileSha256,
                        fileSize: file.size,
                        expiresAt: new Date(Date.now() + ORPHAN_MAX_AGE_MS),
                    },
                });
                const creditConsumption = await this.featureAccess.recordFeatureUsageInTransaction(
                    tx,
                    args.tenantId,
                    entitlement,
                    `Availability PDF import (${importId})`,
                    `availability-import:${importId}`,
                );
                const updated = await tx.availabilityImportJob.update({
                    where: { id: importId },
                    data: { creditConsumption },
                });
                return { row: updated as ImportRow, replayed: false };
            }, { isolationLevel: 'Serializable' });
            row = prepared.row;
            replayed = prepared.replayed;
        } catch (error) {
            if (storagePath) await this.safeUnlink(storagePath);
            if (this.isUniqueConstraint(error)) {
                const replay = await this.replayAfterRace(
                    args.tenantId,
                    requestKeyHash,
                    args.userId,
                    fileSha256,
                    documentIdentityHash,
                );
                this.publisher.kick();
                return replay;
            }
            throw error;
        }

        if (replayed && storagePath) {
            await this.safeUnlink(storagePath);
        }
        this.publisher.kick();
        return this.getImport(args.tenantId, row.id);
    }

    async getImport(tenantId: string, id: string) {
        return this.tenantDb.withTenant(tenantId, async (tx: any) => {
            const row = await tx.availabilityImportJob.findFirst({
                where: { id, tenantId },
            }) as ImportRow | null;
            if (!row) throw new NotFoundException('Availability import not found.');
            const ledgerIds = availabilityImportLedgerIds(row.id);
            const ledgerRows = await tx.creditTransaction.findMany({
                where: {
                    tenantId,
                    id: { in: [ledgerIds.debit, ledgerIds.refund] },
                },
                select: { id: true, amount: true },
            }) as CreditLedgerRow[];
            return this.serialize(row, this.deriveSettlement(row, ledgerRows));
        });
    }

    private async replayAfterRace(
        tenantId: string,
        requestKeyHash: string,
        userId: string,
        fileSha256: string,
        documentIdentityHash: string,
    ) {
        const existing = await this.tenantDb.withTenant(tenantId, (tx: any) => tx.availabilityImportJob.findUnique({
            where: { tenantId_requestKeyHash: { tenantId, requestKeyHash } },
        })) as ImportRow | null;
        if (!existing || !this.matchesImportRequest(existing, userId, fileSha256, documentIdentityHash)) {
            throw new ConflictException('Idempotency-Key was already used for a different availability import.');
        }
        return this.getImport(tenantId, existing.id);
    }

    private async cleanupOrphans(): Promise<void> {
        const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
        let names: string[];
        try {
            names = await readdir(this.uploadRoot);
        } catch {
            return;
        }
        await Promise.all(names
            .filter((name) => /^[a-f0-9-]{36}\.pdf$/i.test(name))
            .map(async (name) => {
                const path = this.storagePath(name);
                try {
                    const metadata = await stat(path);
                    if (metadata.isFile() && metadata.mtimeMs < cutoff) await unlink(path);
                } catch {
                    // Another replica or worker may have already removed it.
                }
            }));
    }

    private async writeExclusive(path: string, bytes: Buffer): Promise<void> {
        const handle = await open(path, 'wx', 0o600);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
        }
    }

    private storagePath(storageKey: string): string {
        if (!/^[a-f0-9-]{36}\.pdf$/i.test(storageKey)) {
            throw new ServiceUnavailableException('Availability import storage is unavailable.');
        }
        const path = resolve(join(this.uploadRoot, storageKey));
        if (path === this.uploadRoot || !path.startsWith(`${this.uploadRoot}${sep}`)) {
            throw new ServiceUnavailableException('Availability import storage is unavailable.');
        }
        return path;
    }

    private async safeUnlink(path: string): Promise<void> {
        try {
            await unlink(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }

    private deriveSettlement(row: ImportRow, ledgerRows: CreditLedgerRow[]): AvailabilityImportSettlement {
        const ledgerIds = availabilityImportLedgerIds(row.id);
        const debit = ledgerRows.find((entry) => entry.id === ledgerIds.debit);
        const refund = ledgerRows.find((entry) => entry.id === ledgerIds.refund);
        const chargedCredits = debit && Number.isSafeInteger(debit.amount) && debit.amount < 0
            ? -debit.amount
            : 0;
        const refundedCredits = refund && Number.isSafeInteger(refund.amount) && refund.amount > 0
            ? refund.amount
            : 0;
        const refundTerminal = row.status === 'FAILED'
            || row.status === 'DEAD_LETTERED'
            || row.status === 'CANCELLED';
        const settled = refundTerminal
            ? chargedCredits > 0 && refundedCredits === chargedCredits
            : row.status === 'SUCCEEDED'
                ? chargedCredits > 0 && refundedCredits === 0
                : false;
        return { chargedCredits, refundedCredits, pending: !settled };
    }

    private serialize(row: ImportRow, settlement: AvailabilityImportSettlement) {
        return {
            id: row.id,
            userId: row.userId,
            status: row.status,
            parsedAvailability: row.status === 'SUCCEEDED'
                && row.resultErasedAt === null
                && Array.isArray(row.parsedAvailability)
                ? row.parsedAvailability
                : null,
            failureCode: row.status === 'FAILED' || row.status === 'DEAD_LETTERED'
                ? 'IMPORT_FAILED'
                : null,
            settlement,
            createdAt: row.createdAt,
            completedAt: row.completedAt,
        };
    }

    private digest(value: string): string {
        return createHash('sha256').update(value, 'utf8').digest('hex');
    }

    private matchesImportRequest(
        existing: ImportRow,
        userId: string,
        fileSha256: string,
        documentIdentityHash: string,
    ): boolean {
        if (existing.userId !== userId || existing.fileSha256 !== fileSha256) return false;
        if (existing.requestHash === documentIdentityHash) return true;
        if (existing.targetIdentityHash !== documentIdentityHash) return false;
        return existing.requestHash === this.digest(`${userId}:${fileSha256}`)
            || existing.requestHash === this.digest(`${userId}:${fileSha256}:${documentIdentityHash}`);
    }

    private isUniqueConstraint(error: unknown): boolean {
        return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
    }
}
