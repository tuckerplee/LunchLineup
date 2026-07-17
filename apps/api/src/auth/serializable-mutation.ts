import { ConflictException } from '@nestjs/common';

import { isSerializableTransactionConflict } from '../database/transaction-error';

export const SERIALIZABLE_MUTATION_MAX_ATTEMPTS = 2;

type SerializableMutationRetryOptions = {
    conflictMessage: string | ((error: unknown) => string);
    isConflict?: (error: unknown) => boolean;
};

export async function runSerializableMutationWithRetry<T>(
    operation: () => Promise<T>,
    options: SerializableMutationRetryOptions,
): Promise<T> {
    const isConflict = options.isConflict ?? isSerializableTransactionConflict;
    for (let attempt = 0; attempt < SERIALIZABLE_MUTATION_MAX_ATTEMPTS; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (!isConflict(error)) throw error;
            if (attempt + 1 === SERIALIZABLE_MUTATION_MAX_ATTEMPTS) {
                const message = typeof options.conflictMessage === 'function'
                    ? options.conflictMessage(error)
                    : options.conflictMessage;
                throw new ConflictException(message);
            }
        }
    }
    throw new ConflictException('The mutation changed concurrently; retry the request.');
}
