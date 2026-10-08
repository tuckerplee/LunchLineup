export class TimeCardMutationError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'TimeCardMutationError';
    }
}

export function isTimeCardValidationRejection(error: unknown): error is TimeCardMutationError {
    return error instanceof TimeCardMutationError && (error.status === 400 || error.status === 422);
}

export async function requireTimeCardMutationSuccess(response: Response, fallback: string): Promise<void> {
    if (response.ok) return;
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    throw new TimeCardMutationError(response.status,
        typeof body?.message === 'string' && body.message ? body.message : fallback);
}
