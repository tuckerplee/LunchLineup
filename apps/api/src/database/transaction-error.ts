export function isSerializableTransactionConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; meta?: unknown };
    if (candidate.code === 'P2034' || candidate.code === '40001' || candidate.code === '40P01') {
        return true;
    }
    if (candidate.code !== 'P2010' || !candidate.meta || typeof candidate.meta !== 'object') {
        return false;
    }
    const databaseCode = (candidate.meta as { code?: unknown }).code;
    return databaseCode === '40001' || databaseCode === '40P01';
}

export function isPrismaUniqueConstraintConflict(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002');
}
