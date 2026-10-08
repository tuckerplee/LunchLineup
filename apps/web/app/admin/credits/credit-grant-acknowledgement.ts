export type CreditGrantAcknowledgement = {
    success: true;
    newBalance: number;
};

// A response must confirm the owning grant contract before its retained attempt
// is cleared. The stored replay balance can differ from today's wallet balance;
// do not infer it from the requested amount, local projection or another GET.
export function parseCreditGrantAcknowledgement(status: number, value: unknown): CreditGrantAcknowledgement {
    if (status !== 201 || value === null || typeof value !== 'object' || Array.isArray(value)
        || !('success' in value) || value.success !== true
        || !('newBalance' in value) || typeof value.newBalance !== 'number'
        || !Number.isSafeInteger(value.newBalance) || value.newBalance < 0) {
        throw new Error('The credit grant response could not be verified. Retry the unchanged grant.');
    }
    return { success: true, newBalance: value.newBalance };
}
