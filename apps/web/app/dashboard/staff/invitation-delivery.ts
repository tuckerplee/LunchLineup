export type InvitationDeliveryStatus =
    | 'NOT_APPLICABLE'
    | 'PENDING'
    | 'SENDING'
    | 'FAILED'
    | 'DELIVERED'
    | 'DEAD_LETTERED'
    | 'CANCELLED';

export type InvitationDelivery = {
    deliveryId?: string;
    status: InvitationDeliveryStatus;
    attempts: number;
    canRetry: boolean;
    canReissue: boolean;
    nextAttemptAt?: string;
    deliveredAt?: string;
};

export type InvitationDeliveryUiState = {
    delivery: InvitationDelivery | null;
    isLoading: boolean;
    error: string | null;
};

export type InvitationDeliveryView = {
    label: string;
    detail: string;
    tone: 'neutral' | 'progress' | 'success' | 'warning' | 'danger';
    terminal: boolean;
    canRetry: boolean;
    canReissue: boolean;
    shouldRefresh: boolean;
};

const STATUS_ALIASES: Record<string, InvitationDeliveryStatus> = {
    NOT_APPLICABLE: 'NOT_APPLICABLE',
    not_applicable: 'NOT_APPLICABLE',
    PENDING: 'PENDING',
    pending: 'PENDING',
    queued: 'PENDING',
    SENDING: 'SENDING',
    sending: 'SENDING',
    FAILED: 'FAILED',
    failed: 'FAILED',
    DELIVERED: 'DELIVERED',
    delivered: 'DELIVERED',
    DEAD_LETTERED: 'DEAD_LETTERED',
    dead_lettered: 'DEAD_LETTERED',
    CANCELLED: 'CANCELLED',
    cancelled: 'CANCELLED',
};

const TERMINAL_STATUSES = new Set<InvitationDeliveryStatus>([
    'NOT_APPLICABLE',
    'DELIVERED',
    'DEAD_LETTERED',
    'CANCELLED',
]);

function parseOptionalDate(value: unknown): string | undefined | null {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !value.trim()) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseInvitationDelivery(value: unknown): InvitationDelivery | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    const status = typeof payload.status === 'string' ? STATUS_ALIASES[payload.status] : undefined;
    if (!status || !Number.isSafeInteger(payload.attempts) || Number(payload.attempts) < 0) return null;
    if (typeof payload.canRetry !== 'boolean') return null;

    const nextAttemptAt = parseOptionalDate(payload.nextAttemptAt);
    const deliveredAt = parseOptionalDate(payload.deliveredAt);
    if (nextAttemptAt === null || deliveredAt === null) return null;

    return {
        ...(typeof payload.deliveryId === 'string' && payload.deliveryId.trim()
            ? { deliveryId: payload.deliveryId }
            : {}),
        status,
        attempts: Number(payload.attempts),
        canRetry: status === 'FAILED' && payload.canRetry,
        canReissue: status === 'DEAD_LETTERED' && payload.canReissue === true,
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        ...(deliveredAt ? { deliveredAt } : {}),
    };
}

export function parseInvitationDeliveryResponse(value: unknown): InvitationDelivery | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return parseInvitationDelivery((value as Record<string, unknown>).invitationDelivery);
}

export function formatInvitationDeliveryDate(
    value: string | undefined,
    locale = 'en-US',
    timeZone?: string,
): string | null {
    if (!value) return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        ...(timeZone ? { timeZone } : {}),
    }).format(new Date(timestamp));
}

export function isTerminalInvitationDelivery(status: InvitationDeliveryStatus): boolean {
    return TERMINAL_STATUSES.has(status);
}

export function stableInvitationRetryKey(
    current: string | null | undefined,
    keyFactory: () => string,
): string {
    const existing = current?.trim();
    if (existing && existing.length <= 200) return existing;
    const created = keyFactory().trim();
    if (!created || created.length > 200) throw new Error('Unable to create an invitation retry key.');
    return created;
}

export function invitationDeliveryView(delivery: InvitationDelivery): InvitationDeliveryView {
    const attempts = `${delivery.attempts} ${delivery.attempts === 1 ? 'attempt' : 'attempts'}`;
    const nextAttempt = formatInvitationDeliveryDate(delivery.nextAttemptAt);
    const delivered = formatInvitationDeliveryDate(delivery.deliveredAt);

    switch (delivery.status) {
        case 'NOT_APPLICABLE':
            return {
                label: 'Not required',
                detail: 'This account does not use an email invitation.',
                tone: 'neutral',
                terminal: true,
                canRetry: false,
                canReissue: false,
                shouldRefresh: false,
            };
        case 'PENDING':
            return {
                label: 'Queued',
                detail: nextAttempt ? `Next delivery attempt: ${nextAttempt}.` : 'Waiting to be sent.',
                tone: 'progress',
                terminal: false,
                canRetry: false,
                canReissue: false,
                shouldRefresh: true,
            };
        case 'SENDING':
            return {
                label: 'Sending',
                detail: 'Invitation delivery is in progress.',
                tone: 'progress',
                terminal: false,
                canRetry: false,
                canReissue: false,
                shouldRefresh: true,
            };
        case 'FAILED':
            return {
                label: 'Delivery failed',
                detail: nextAttempt
                    ? `${attempts}. Another attempt is scheduled for ${nextAttempt}.`
                    : `${attempts}. ${delivery.canRetry ? 'You can retry now.' : 'Retry is not available.'}`,
                tone: 'warning',
                terminal: false,
                canRetry: delivery.canRetry,
                canReissue: false,
                shouldRefresh: Boolean(nextAttempt),
            };
        case 'DELIVERED':
            return {
                label: 'Delivered',
                detail: delivered ? `Delivered ${delivered}.` : 'Invitation delivered.',
                tone: 'success',
                terminal: true,
                canRetry: false,
                canReissue: false,
                shouldRefresh: false,
            };
        case 'DEAD_LETTERED':
            return {
                label: 'Dead-lettered',
                detail: `${attempts}. Automatic delivery has stopped.${delivery.canReissue ? ' Reissue with a fresh delivery action.' : ''}`,
                tone: 'danger',
                terminal: true,
                canRetry: false,
                canReissue: delivery.canReissue,
                shouldRefresh: false,
            };
        case 'CANCELLED':
            return {
                label: 'Cancelled',
                detail: 'Invitation delivery was cancelled.',
                tone: 'neutral',
                terminal: true,
                canRetry: false,
                canReissue: false,
                shouldRefresh: false,
            };
    }
}
