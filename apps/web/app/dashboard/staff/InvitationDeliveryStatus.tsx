'use client';

import { RefreshCw, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { invitationDeliveryView, type InvitationDeliveryUiState } from './invitation-delivery';

type InvitationDeliveryStatusProps = {
    state: InvitationDeliveryUiState;
    isRetrying?: boolean;
    onRefresh?: () => void;
    onRetry?: () => void;
};

const TONE_STYLES = {
    neutral: { color: '#52647f', background: '#eef2f7', borderColor: '#d4dce8' },
    progress: { color: '#244aa8', background: '#edf3ff', borderColor: '#c9d6ef' },
    success: { color: '#11663f', background: '#eaf8f0', borderColor: '#b9e2ca' },
    warning: { color: '#8a4b0f', background: '#fff7e8', borderColor: '#f1d7a5' },
    danger: { color: '#a1263d', background: '#fff0f3', borderColor: '#efc2cc' },
} as const;

export function InvitationDeliveryStatus({
    state,
    isRetrying = false,
    onRefresh,
    onRetry,
}: InvitationDeliveryStatusProps) {
    const view = state.delivery ? invitationDeliveryView(state.delivery) : null;
    const isBusy = state.isLoading || isRetrying;

    return (
        <div
            aria-live={isBusy || state.error ? 'polite' : 'off'}
            aria-atomic="true"
            style={{ display: 'grid', gap: '0.35rem', minWidth: 190, maxWidth: 300 }}
        >
            {view ? (
                <div style={{ display: 'grid', gap: '0.25rem' }}>
                    <span
                        style={{
                            width: 'fit-content',
                            border: '1px solid',
                            borderRadius: 6,
                            padding: '0.2rem 0.42rem',
                            fontSize: '0.7rem',
                            fontWeight: 800,
                            ...TONE_STYLES[view.tone],
                        }}
                    >
                        {view.label}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem', lineHeight: 1.35 }}>
                        {view.detail}
                    </span>
                </div>
            ) : (
                <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>
                    {state.isLoading ? 'Checking delivery status...' : 'Delivery status unavailable.'}
                </span>
            )}

            {state.error ? (
                <span role="alert" style={{ color: '#a1263d', fontSize: '0.72rem', lineHeight: 1.35 }}>
                    {state.error}
                </span>
            ) : null}

            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {(view?.canRetry || view?.canReissue) && onRetry ? (
                    <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={isBusy}>
                        <RotateCcw aria-hidden="true" size={14} />
                        {isRetrying
                            ? (view.canReissue ? 'Reissuing...' : 'Retrying...')
                            : (view.canReissue ? 'Reissue invitation' : 'Retry invitation')}
                    </Button>
                ) : null}
                {onRefresh && state.delivery?.status !== 'NOT_APPLICABLE' ? (
                    <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={isBusy}>
                        <RefreshCw aria-hidden="true" size={14} />
                        {state.isLoading ? 'Refreshing...' : 'Refresh status'}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
