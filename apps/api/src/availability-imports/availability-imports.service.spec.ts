import { BadRequestException, ConflictException } from '@nestjs/common';
import { createDecipheriv, createHash } from 'crypto';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AVAILABILITY_IMPORT_TERMINAL_RETENTION_MS,
    AvailabilityImportsService,
    availabilityImportAccountIdentityHash,
    availabilityImportDocumentIdentityHash,
    availabilityImportSourceAad,
    normalizeAvailabilityImportStaffIdentity,
    normalizeImportIdempotencyKey,
    validateAvailabilityPdf,
} from './availability-imports.service';

describe('AvailabilityImportsService', () => {
    let tenantDb: any;
    let featureAccess: any;
    let publisher: any;
    let tx: any;
    let previousRoot: string | undefined;
    let previousEncryptionKey: string | undefined;
    const encryptionKey = Buffer.alloc(32, 0x7a);

    beforeEach(() => {
        previousRoot = process.env.AVAILABILITY_UPLOAD_ROOT;
        previousEncryptionKey = process.env.AVAILABILITY_IMPORT_ENCRYPTION_KEY;
        process.env.AVAILABILITY_IMPORT_ENCRYPTION_KEY = encryptionKey.toString('base64');
        tx = {
            availabilityImportJob: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
            user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1', username: 'staff-1' }) },
            creditTransaction: {
                findMany: vi.fn(async ({ where }: any) => [{
                    id: where.id.in[0],
                    amount: -1,
                }]),
            },
        };
        tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, operation: (client: any) => Promise<unknown>) => operation(tx)),
        };
        featureAccess = {
            assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ code: 'scheduling' }),
            recordFeatureUsageInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 1 }),
        };
        publisher = {
            isReady: vi.fn().mockReturnValue(true),
            kick: vi.fn(),
        };
    });

    afterEach(() => {
        if (previousRoot === undefined) delete process.env.AVAILABILITY_UPLOAD_ROOT;
        else process.env.AVAILABILITY_UPLOAD_ROOT = previousRoot;
        if (previousEncryptionKey === undefined) delete process.env.AVAILABILITY_IMPORT_ENCRYPTION_KEY;
        else process.env.AVAILABILITY_IMPORT_ENCRYPTION_KEY = previousEncryptionKey;
        vi.restoreAllMocks();
    });

    it('validates MIME, extension, signature, size, and printable idempotency keys', () => {
        const valid = {
            buffer: Buffer.from('%PDF-1.7\n'),
            mimetype: 'application/pdf',
            originalname: 'availability.pdf',
            size: 9,
        };

        expect(validateAvailabilityPdf(valid)).toBe(valid);
        expect(normalizeImportIdempotencyKey(' request-1 ')).toBe('request-1');
        expect(normalizeAvailabilityImportStaffIdentity(' EMP-10492 ')).toBe('emp-10492');
        expect(normalizeAvailabilityImportStaffIdentity('')).toBeNull();
        expect(() => validateAvailabilityPdf({ ...valid, mimetype: 'text/plain' })).toThrow('application/pdf');
        expect(() => validateAvailabilityPdf({ ...valid, originalname: 'availability.txt' })).toThrow('.pdf');
        expect(() => validateAvailabilityPdf({ ...valid, buffer: Buffer.from('not-pdf'), size: 7 })).toThrow('signature');
        expect(() => normalizeImportIdempotencyKey('bad\nkey')).toThrow('printable');
        expect(() => normalizeAvailabilityImportStaffIdentity('employee id 1')).toThrow('Employee or staff ID');
        expect(() => normalizeAvailabilityImportStaffIdentity('x'.repeat(129))).toThrow('1 to 128');
    });

    it('imports for an email-only target using a normalized visible identity and replays without a second debit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'availability-import-api-'));
        process.env.AVAILABILITY_UPLOAD_ROOT = root;
        tx.user.findFirst.mockResolvedValue({ id: 'user-1', username: null });
        const service = new AvailabilityImportsService(tenantDb, featureAccess, publisher);
        const createdAt = new Date('2026-07-14T12:00:00.000Z');
        let durable: any = null;
        tx.availabilityImportJob.findUnique.mockImplementation(async () => durable);
        tx.availabilityImportJob.findFirst.mockImplementation(async () => durable);
        tx.availabilityImportJob.create.mockImplementation(async ({ data }: any) => {
            durable = {
                ...data,
                status: 'PENDING',
                parsedAvailability: null,
                resultErasedAt: null,
                failureCode: null,
                creditConsumption: null,
                createdAt,
                completedAt: null,
            };
            return durable;
        });
        tx.availabilityImportJob.update.mockImplementation(async ({ data }: any) => {
            durable = { ...durable, ...data };
            return durable;
        });
        const file = {
            buffer: Buffer.from('%PDF-1.7\n'),
            mimetype: 'application/pdf',
            originalname: 'availability.pdf',
            size: 9,
        };
        const args = {
            tenantId: 'tenant-1',
            requestedByUserId: 'manager-1',
            userId: 'user-1',
            idempotencyKey: 'request-1',
            staffIdentity: ' EMP-10492 ',
            file,
        };

        try {
            const first = await service.createImport(args);
            durable = { ...durable, status: 'FAILED', completedAt: new Date() };
            tx.creditTransaction.findMany.mockImplementation(async ({ where }: any) => [
                { id: where.id.in[0], amount: -1 },
                { id: where.id.in[1], amount: 1 },
            ]);
            const second = await service.createImport(args);

            expect(first.settlement).toEqual({
                chargedCredits: 1,
                refundedCredits: 0,
                pending: true,
            });
            expect(second.id).toBe(first.id);
            expect(second.settlement).toEqual({
                chargedCredits: 1,
                refundedCredits: 1,
                pending: false,
            });
            expect(tx.availabilityImportJob.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    requestHash: availabilityImportDocumentIdentityHash('emp-10492'),
                    targetIdentityHash: availabilityImportAccountIdentityHash({ id: 'user-1', username: null }),
                }),
            });
            const createData = tx.availabilityImportJob.create.mock.calls[0][0].data;
            expect(createData.requestHash).toBe(availabilityImportDocumentIdentityHash('emp-10492'));
            expect(AVAILABILITY_IMPORT_TERMINAL_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
            expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
            expect(publisher.kick).toHaveBeenCalledTimes(2);
            const envelope = createData.encryptedSourcePayload as Buffer;
            expect(Buffer.isBuffer(envelope)).toBe(true);
            expect(envelope.subarray(0, 4).toString('ascii')).toBe('LLAI');
            expect(envelope[4]).toBe(3);
            expect(envelope.includes(file.buffer)).toBe(false);
            const nonce = envelope.subarray(5, 17);
            const tag = envelope.subarray(17, 33);
            const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
            const sourceBinding = {
                envelopeVersion: 3,
                tenantId: 'tenant-1',
                importId: createData.id,
                fileSha256: createData.fileSha256,
                requestHash: createData.requestHash,
                targetIdentityHash: createData.targetIdentityHash,
            };
            decipher.setAAD(availabilityImportSourceAad(sourceBinding));
            decipher.setAuthTag(tag);
            expect(Buffer.concat([
                decipher.update(envelope.subarray(33)),
                decipher.final(),
            ])).toEqual(file.buffer);
            const localFiles = await readdir(root);
            expect(localFiles).toHaveLength(1);
            expect(await readFile(join(root, localFiles[0]))).toEqual(envelope);

            for (const tamperedBinding of [
                { ...sourceBinding, envelopeVersion: 2 },
                { ...sourceBinding, requestHash: '1'.repeat(64) },
                { ...sourceBinding, targetIdentityHash: '2'.repeat(64) },
            ]) {
                const tamperedDecipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
                tamperedDecipher.setAAD(availabilityImportSourceAad(tamperedBinding));
                tamperedDecipher.setAuthTag(tag);
                tamperedDecipher.update(envelope.subarray(33));
                expect(() => tamperedDecipher.final()).toThrow();
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('requires managers to explicitly supply the visible identity even when a username exists', async () => {
        const service = new AvailabilityImportsService(tenantDb, featureAccess, publisher);
        tx.availabilityImportJob.findUnique.mockResolvedValue(null);

        await expect(service.createImport({
            tenantId: 'tenant-1',
            requestedByUserId: 'manager-1',
            userId: 'user-1',
            idempotencyKey: 'username-default',
            file: {
                buffer: Buffer.from('%PDF-1.7\n'),
                mimetype: 'application/pdf',
                originalname: 'availability.pdf',
                size: 9,
            },
        })).rejects.toBeInstanceOf(BadRequestException);

        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    });

    it('rejects email-only targets without a visible identity before entitlement or debit', async () => {
        tx.user.findFirst.mockResolvedValue({ id: 'user-1', username: null });
        const service = new AvailabilityImportsService(tenantDb, featureAccess, publisher);

        await expect(service.createImport({
            tenantId: 'tenant-1',
            requestedByUserId: 'manager-1',
            userId: 'user-1',
            idempotencyKey: 'missing-visible-identity',
            file: {
                buffer: Buffer.from('%PDF-1.7\n'),
                mimetype: 'application/pdf',
                originalname: 'availability.pdf',
                size: 9,
            },
        })).rejects.toBeInstanceOf(BadRequestException);

        expect(featureAccess.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(tx.availabilityImportJob.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid supplied identity before opening a tenant transaction', async () => {
        const service = new AvailabilityImportsService(tenantDb, featureAccess, publisher);

        await expect(service.createImport({
            tenantId: 'tenant-1',
            requestedByUserId: 'manager-1',
            userId: 'user-1',
            idempotencyKey: 'invalid-visible-identity',
            staffIdentity: 'employee id 1',
            file: {
                buffer: Buffer.from('%PDF-1.7\n'),
                mimetype: 'application/pdf',
                originalname: 'availability.pdf',
                size: 9,
            },
        })).rejects.toBeInstanceOf(BadRequestException);

        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    });

    it('rejects new imports before validation or debit while the publisher is draining', async () => {
        publisher.isReady.mockReturnValue(false);
        const service = new AvailabilityImportsService(tenantDb, featureAccess, publisher);

        await expect(service.createImport({
            tenantId: 'tenant-1',
            requestedByUserId: 'manager-1',
            userId: 'user-1',
            idempotencyKey: 'draining-import',
        })).rejects.toThrow('publishing is draining');

        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(featureAccess.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(publisher.kick).not.toHaveBeenCalled();
    });

    it('withholds a succeeded result after completion-based retention erases its payload', async () => {
        const service = new AvailabilityImportsService(tenantDb, featureAccess, publisher);
        const completedAt = new Date('2026-07-14T12:00:00.000Z');
        tx.availabilityImportJob.findFirst.mockResolvedValue({
            id: 'import-1',
            userId: 'user-1',
            status: 'SUCCEEDED',
            parsedAvailability: [{ dayOfWeek: 1, startTimeMinutes: 540, endTimeMinutes: 1020 }],
            resultErasedAt: new Date(completedAt.getTime() + AVAILABILITY_IMPORT_TERMINAL_RETENTION_MS),
            failureCode: null,
            creditConsumption: { consumedCredits: 1 },
            createdAt: new Date('2026-07-14T11:00:00.000Z'),
            completedAt,
        });

        await expect(service.getImport('tenant-1', 'import-1')).resolves.toMatchObject({
            id: 'import-1',
            status: 'SUCCEEDED',
            parsedAvailability: null,
            completedAt,
        });
    });
    it.each([
        ['failed without refund', 'FAILED', -3, null, { chargedCredits: 3, refundedCredits: 0, pending: true }],
        ['exact refund', 'FAILED', -3, 3, { chargedCredits: 3, refundedCredits: 3, pending: false }],
        ['partial refund', 'FAILED', -3, 1, { chargedCredits: 3, refundedCredits: 1, pending: true }],
        ['over refund', 'FAILED', -3, 4, { chargedCredits: 3, refundedCredits: 4, pending: true }],
        ['success charge', 'SUCCEEDED', -1, null, { chargedCredits: 1, refundedCredits: 0, pending: false }],
    ])('derives %s from exact durable ledger identities', async (
        _caseName,
        status,
        debitAmount,
        refundAmount,
        expectedSettlement,
    ) => {
        const service = new AvailabilityImportsService(tenantDb, featureAccess, publisher);
        tx.availabilityImportJob.findFirst.mockResolvedValue({
            id: 'import-1',
            userId: 'user-1',
            status,
            parsedAvailability: status === 'SUCCEEDED' ? [] : null,
            resultErasedAt: null,
            failureCode: null,
            creditConsumption: { consumedCredits: 99 },
            createdAt: new Date(),
            completedAt: new Date(),
        });
        tx.creditTransaction.findMany.mockImplementation(async ({ where }: any) => [
            { id: where.id.in[0], amount: debitAmount },
            ...(refundAmount === null ? [] : [{ id: where.id.in[1], amount: refundAmount }]),
        ]);

        const result = await service.getImport('tenant-1', 'import-1');

        expect(result.settlement).toEqual(expectedSettlement);
        expect(result).not.toHaveProperty('creditConsumption');
        expect(tx.creditTransaction.findMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                id: {
                    in: [
                        'feature-usage-availability-import:import-1',
                        'feature-refund-availability-import:import-1',
                    ],
                },
            },
            select: { id: true, amount: true },
        });
    });

    it('binds the normalized visible identity into idempotency and removes only the replay source', async () => {
        const root = await mkdtemp(join(tmpdir(), 'availability-import-api-'));
        process.env.AVAILABILITY_UPLOAD_ROOT = root;
        const service = new AvailabilityImportsService(tenantDb, featureAccess, publisher);
        const file = {
            buffer: Buffer.from('%PDF-1.7\n'),
            mimetype: 'application/pdf',
            originalname: 'availability.pdf',
            size: 9,
        };
        const fileSha256 = createHash('sha256').update(file.buffer).digest('hex');
        const originalIdentityHash = availabilityImportDocumentIdentityHash('employee-1');
        tx.availabilityImportJob.findUnique.mockResolvedValue({
            userId: 'user-1',
            fileSha256,
            targetIdentityHash: originalIdentityHash,
            requestHash: originalIdentityHash,
            encryptedSourcePayload: Buffer.from('LLAI\x02', 'binary'),
        });

        try {
            await expect(service.createImport({
                tenantId: 'tenant-1',
                requestedByUserId: 'manager-1',
                userId: 'user-1',
                idempotencyKey: 'request-1',
                staffIdentity: 'employee-2',
                file,
            })).rejects.toBeInstanceOf(ConflictException);
            expect(await readdir(root)).toHaveLength(0);
            expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
            expect(publisher.kick).not.toHaveBeenCalled();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
