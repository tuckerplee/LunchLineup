import { describe, expect, it } from 'vitest';
import {
    normalizeSetupShiftsIdempotencyKey,
    setupShiftsNeedsSemanticReplay,
    setupShiftsOperationId,
    setupShiftsRequestHash,
    setupShiftsSemanticOperationId,
} from './setup-shifts-idempotency';

describe('setup shift idempotency', () => {
    it('requires a bounded printable key', () => {
        expect(() => normalizeSetupShiftsIdempotencyKey(undefined)).toThrow('Idempotency-Key header is required');
        expect(() => normalizeSetupShiftsIdempotencyKey(`key-${'x'.repeat(252)}`)).toThrow('255 printable');
        expect(() => normalizeSetupShiftsIdempotencyKey('key\nvalue')).toThrow('255 printable');
        expect(normalizeSetupShiftsIdempotencyKey(' setup-shifts-1 ')).toBe('setup-shifts-1');
    });

    it('creates a tenant-scoped stable operation identity', () => {
        const operationId = setupShiftsOperationId('tenant-1', 'setup-shifts-1');
        expect(operationId).toHaveLength(64);
        expect(operationId).not.toContain('setup-shifts-1');
        expect(operationId).not.toBe(setupShiftsOperationId('tenant-2', 'setup-shifts-1'));
    });

    it('hashes ordered normalized write semantics and excludes display-only data', () => {
        const request = {
            locationId: 'location-1',
            rows: [{
                shiftId: 'shift-1',
                userId: null,
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            }],
        };
        expect(setupShiftsRequestHash(request)).toBe(setupShiftsRequestHash({
            locationId: 'location-1',
            rows: request.rows.map((row) => ({ ...row })),
        }));
        expect(setupShiftsRequestHash(request)).not.toBe(setupShiftsRequestHash({
            ...request,
            rows: [{ ...request.rows[0], endTime: '2026-03-10T22:00:00.000Z' }],
        }));
    });

    it('normalizes omitted and null users for new unassigned rows only', () => {
        const omitted = {
            locationId: 'location-1',
            rows: [{
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            }],
        };
        expect(setupShiftsRequestHash(omitted)).toBe(setupShiftsRequestHash({
            locationId: omitted.locationId,
            rows: [{ ...omitted.rows[0], userId: null }],
        }));
        expect(setupShiftsRequestHash({
            locationId: omitted.locationId,
            rows: [{ ...omitted.rows[0], shiftId: 'shift-1' }],
        })).not.toBe(setupShiftsRequestHash({
            locationId: omitted.locationId,
            rows: [{ ...omitted.rows[0], shiftId: 'shift-1', userId: null }],
        }));
    });

    it('uses semantic replay only when a request can create an unassigned shift', () => {
        const unassigned = {
            locationId: 'location-1',
            rows: [{
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            }],
        };
        expect(setupShiftsNeedsSemanticReplay(unassigned)).toBe(true);
        expect(setupShiftsNeedsSemanticReplay({
            ...unassigned,
            rows: [{ ...unassigned.rows[0], userId: 'user-1' }],
        })).toBe(false);
        expect(setupShiftsNeedsSemanticReplay({
            ...unassigned,
            rows: [{ ...unassigned.rows[0], shiftId: 'shift-1' }],
        })).toBe(false);

        const requestHash = setupShiftsRequestHash(unassigned);
        const operationId = setupShiftsSemanticOperationId('tenant-1', requestHash);
        expect(operationId).toHaveLength(64);
        expect(operationId).toBe(setupShiftsSemanticOperationId('tenant-1', requestHash));
        expect(operationId).not.toBe(setupShiftsSemanticOperationId('tenant-2', requestHash));
    });
});
