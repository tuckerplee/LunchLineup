import { describe, expect, it } from 'vitest';
import {
    isPrismaUniqueConstraintConflict,
    isSerializableTransactionConflict,
} from './transaction-error';

describe('database transaction error classification', () => {
    it.each([
        { code: 'P2034' },
        { code: '40001' },
        { code: '40P01' },
        { code: 'P2010', meta: { code: '40001' } },
        { code: 'P2010', meta: { code: '40P01' } },
    ])('recognizes a controlled Serializable conflict shape', (error) => {
        expect(isSerializableTransactionConflict(error)).toBe(true);
    });

    it.each([
        null,
        new Error('could not serialize access'),
        { code: 'P2010', meta: { code: '23505' } },
        { code: 'P2002' },
        { code: '42501' },
    ])('does not mask an unrelated database error', (error) => {
        expect(isSerializableTransactionConflict(error)).toBe(false);
    });

    it('recognizes only Prisma unique-constraint conflicts', () => {
        expect(isPrismaUniqueConstraintConflict({ code: 'P2002' })).toBe(true);
        expect(isPrismaUniqueConstraintConflict({ code: '23505' })).toBe(false);
    });
});
