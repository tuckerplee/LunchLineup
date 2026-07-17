import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
    SERIALIZABLE_MUTATION_MAX_ATTEMPTS,
    runSerializableMutationWithRetry,
} from './serializable-mutation';

describe('runSerializableMutationWithRetry', () => {
    it('retries one recognized whole-transaction conflict', async () => {
        const operation = vi.fn()
            .mockRejectedValueOnce({ code: 'P2034' })
            .mockResolvedValueOnce('committed');

        await expect(runSerializableMutationWithRetry(operation, {
            conflictMessage: 'changed concurrently',
        })).resolves.toBe('committed');
        expect(operation).toHaveBeenCalledTimes(SERIALIZABLE_MUTATION_MAX_ATTEMPTS);
    });

    it('maps two recognized conflicts to a controlled 409', async () => {
        const operation = vi.fn().mockRejectedValue({ code: 'P2010', meta: { code: '40001' } });

        await expect(runSerializableMutationWithRetry(operation, {
            conflictMessage: 'changed concurrently',
        })).rejects.toBeInstanceOf(ConflictException);
        expect(operation).toHaveBeenCalledTimes(SERIALIZABLE_MUTATION_MAX_ATTEMPTS);
    });

    it('does not retry or mask unrelated errors', async () => {
        const unrelated = { code: 'P2002' };
        const operation = vi.fn().mockRejectedValue(unrelated);

        await expect(runSerializableMutationWithRetry(operation, {
            conflictMessage: 'changed concurrently',
        })).rejects.toBe(unrelated);
        expect(operation).toHaveBeenCalledOnce();
    });
});
