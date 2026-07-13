'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { fetchWithSession } from '@/lib/client-api';
import {
    normalizeMfaEnrollmentState,
    normalizeMfaSetupChallenge,
    readRecoveryCodes,
    type MfaEnrollmentState,
    type MfaSetupChallenge,
} from './mfa-enrollment-contract';

type Banner = {
    tone: 'success' | 'error';
    text: string;
} | null;

type ApiError = Error & { status?: number };

type PendingAction = 'refresh' | 'start' | 'confirm' | 'disable' | null;

type MfaEnrollmentPanelProps = {
    tenantMfaRequired: boolean;
};

const EMPTY_STATE: MfaEnrollmentState = {
    enabled: false,
    verifiedAt: null,
    recoveryCodesRemaining: null,
    setup: null,
};

const PANEL_STYLE: CSSProperties = {
    padding: '0.9rem',
    display: 'grid',
    gap: '0.8rem',
};

const HEADER_STYLE: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '0.9rem',
    flexWrap: 'wrap',
};

const BADGE_BASE_STYLE: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    borderRadius: 999,
    padding: '0.32rem 0.6rem',
    fontSize: '0.76rem',
    fontWeight: 750,
    whiteSpace: 'nowrap',
};

function normalizeCode(value: string): string {
    return value.trim().replace(/\s+/g, '');
}

function noticeStyle(tone: 'success' | 'error'): CSSProperties {
    return {
        padding: '0.72rem 0.82rem',
        borderRadius: 8,
        border: tone === 'success' ? '1px solid #bdeed4' : '1px solid #ffd0da',
        background: tone === 'success' ? '#e9fbf1' : '#fff1f4',
        color: tone === 'success' ? '#0f8c52' : '#cb3653',
        fontWeight: 650,
        fontSize: '0.82rem',
    };
}

function badgeStyle(enabled: boolean): CSSProperties {
    return {
        ...BADGE_BASE_STYLE,
        border: enabled ? '1px solid #bdeed4' : '1px solid #d8e0ee',
        background: enabled ? '#e9fbf1' : '#f4f7fb',
        color: enabled ? '#0f8c52' : 'var(--text-secondary)',
    };
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchWithSession(path, init);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message = typeof (payload as { message?: unknown }).message === 'string'
            ? String((payload as { message: string }).message)
            : `Request failed (${response.status})`;
        const error = new Error(message) as ApiError;
        error.status = response.status;
        throw error;
    }

    return payload as T;
}

function jsonInit(method: 'POST' | 'PUT' | 'DELETE', body?: unknown): RequestInit {
    return {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    };
}

export function MfaEnrollmentPanel({ tenantMfaRequired }: MfaEnrollmentPanelProps) {
    const [state, setState] = useState<MfaEnrollmentState>(EMPTY_STATE);
    const [setup, setSetup] = useState<MfaSetupChallenge | null>(null);
    const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
    const [confirmCode, setConfirmCode] = useState('');
    const [disableCode, setDisableCode] = useState('');
    const [notice, setNotice] = useState<Banner>(null);
    const [contractUnavailable, setContractUnavailable] = useState(false);
    const [pendingAction, setPendingAction] = useState<PendingAction>('refresh');

    const isBusy = pendingAction !== null;
    const disableBlockedByPolicy = state.enabled && tenantMfaRequired;
    const statusLabel = state.enabled ? 'Enabled' : 'Not enrolled';

    const loadEnrollment = useCallback(async () => {
        setPendingAction('refresh');
        setContractUnavailable(false);
        try {
            const payload = await requestJson<unknown>('/auth/mfa/enrollment');
            const nextState = normalizeMfaEnrollmentState(payload);
            setState(nextState);
            setSetup(nextState.setup);
        } catch (error) {
            const apiError = error as ApiError;
            setContractUnavailable(apiError.status === 404);
            setNotice({
                tone: 'error',
                text: apiError.status === 404
                    ? 'MFA enrollment API is not available yet.'
                    : apiError.message || 'Unable to load MFA enrollment.',
            });
        } finally {
            setPendingAction(null);
        }
    }, []);

    useEffect(() => {
        void loadEnrollment();
    }, [loadEnrollment]);

    const startEnrollment = useCallback(async () => {
        setPendingAction('start');
        setNotice(null);
        setRecoveryCodes([]);
        try {
            const payload = await requestJson<unknown>('/auth/mfa/enrollment', jsonInit('POST'));
            setSetup(normalizeMfaSetupChallenge(payload));
            setNotice({ tone: 'success', text: 'MFA setup started.' });
        } catch (error) {
            const apiError = error as ApiError;
            setContractUnavailable(apiError.status === 404);
            setNotice({ tone: 'error', text: apiError.message || 'Unable to start MFA setup.' });
        } finally {
            setPendingAction(null);
        }
    }, []);

    const confirmEnrollment = useCallback(async () => {
        const code = normalizeCode(confirmCode);
        if (code.length < 6) {
            setNotice({ tone: 'error', text: 'Enter a valid authenticator code.' });
            return;
        }

        setPendingAction('confirm');
        setNotice(null);
        try {
            const payload = await requestJson<unknown>('/auth/mfa/enrollment', jsonInit('PUT', {
                code,
                enrollmentId: setup?.enrollmentId ?? undefined,
            }));
            setState(normalizeMfaEnrollmentState({ ...(payload as Record<string, unknown>), enabled: true }));
            setRecoveryCodes(readRecoveryCodes(payload));
            setSetup(null);
            setConfirmCode('');
            setNotice({ tone: 'success', text: 'MFA is enabled.' });
        } catch (error) {
            const apiError = error as ApiError;
            setNotice({ tone: 'error', text: apiError.message || 'Unable to enable MFA.' });
        } finally {
            setPendingAction(null);
        }
    }, [confirmCode, setup?.enrollmentId]);

    const disableEnrollment = useCallback(async () => {
        if (disableBlockedByPolicy) {
            setNotice({ tone: 'error', text: 'Workspace policy requires MFA for this account.' });
            return;
        }

        const code = normalizeCode(disableCode);
        if (code.length < 6) {
            setNotice({ tone: 'error', text: 'Enter an authenticator or recovery code.' });
            return;
        }

        setPendingAction('disable');
        setNotice(null);
        try {
            const payload = await requestJson<unknown>('/auth/mfa/enrollment', jsonInit('DELETE', { code }));
            setState(normalizeMfaEnrollmentState({ ...(payload as Record<string, unknown>), enabled: false }));
            setSetup(null);
            setRecoveryCodes([]);
            setDisableCode('');
            setNotice({ tone: 'success', text: 'MFA is disabled.' });
        } catch (error) {
            const apiError = error as ApiError;
            setNotice({ tone: 'error', text: apiError.message || 'Unable to disable MFA.' });
        } finally {
            setPendingAction(null);
        }
    }, [disableBlockedByPolicy, disableCode]);

    const recoverySummary = useMemo(() => {
        if (state.recoveryCodesRemaining === null) return null;
        return `${state.recoveryCodesRemaining} recovery code${state.recoveryCodesRemaining === 1 ? '' : 's'} remaining`;
    }, [state.recoveryCodesRemaining]);

    return (
        <div className="surface-muted" style={PANEL_STYLE}>
            <div style={HEADER_STYLE}>
                <div style={{ display: 'grid', gap: '0.2rem', minWidth: 220 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--text-primary)' }}>
                        <ShieldCheck size={18} aria-hidden="true" />
                        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 750 }}>Multi-factor authentication</h3>
                    </div>
                    <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                        Enroll an authenticator app for your own sign-in.
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span style={badgeStyle(state.enabled)}>
                        {state.enabled ? <CheckCircle2 size={14} aria-hidden="true" /> : <KeyRound size={14} aria-hidden="true" />}
                        {statusLabel}
                    </span>
                    <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => void loadEnrollment()}
                        disabled={isBusy}
                        aria-label="Refresh MFA status"
                    >
                        {pendingAction === 'refresh' ? <Loader2 size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                        Refresh
                    </button>
                </div>
            </div>

            {tenantMfaRequired ? (
                <div style={noticeStyle('success')} role="status">
                    Workspace policy requires MFA for all users.
                </div>
            ) : null}

            {notice ? (
                <div style={noticeStyle(notice.tone)} role="status">
                    {notice.text}
                </div>
            ) : null}

            {contractUnavailable ? (
                <div style={{ ...noticeStyle('error'), display: 'grid', gap: '0.35rem' }} role="status">
                    <strong>Client contract required</strong>
                    <span>
                        Implement GET, POST, PUT, and DELETE /auth/mfa/enrollment with same-origin session credentials.
                    </span>
                </div>
            ) : null}

            {!state.enabled && !setup ? (
                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void startEnrollment()}
                        disabled={isBusy || contractUnavailable}
                    >
                        {pendingAction === 'start' ? <Loader2 size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
                        Start MFA setup
                    </button>
                    {state.verifiedAt ? (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Last verified {state.verifiedAt}</span>
                    ) : null}
                </div>
            ) : null}

            {setup ? (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.8rem', alignItems: 'start' }}>
                        <div
                            style={{
                                aspectRatio: '1 / 1',
                                maxWidth: 180,
                                border: '1px solid var(--border)',
                                borderRadius: 8,
                                background: '#ffffff',
                                display: 'grid',
                                placeItems: 'center',
                                overflow: 'hidden',
                                pointerEvents: 'none',
                            }}
                        >
                            {setup.qrCodeDataUrl ? (
                                <img src={setup.qrCodeDataUrl} alt="MFA setup QR code" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                            ) : (
                                <KeyRound size={34} aria-hidden="true" color="var(--text-secondary)" />
                            )}
                        </div>
                        <div style={{ display: 'grid', gap: '0.6rem' }}>
                            <label className="form-group">
                                <span className="form-label">Manual setup key</span>
                                <input className="form-input" value={setup.manualEntryKey} readOnly aria-label="Manual setup key" />
                            </label>
                            {setup.accountLabel || setup.issuer || setup.expiresAt ? (
                                <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.55rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                                    {setup.issuer ? (
                                        <>
                                            <dt>Issuer</dt>
                                            <dd style={{ margin: 0 }}>{setup.issuer}</dd>
                                        </>
                                    ) : null}
                                    {setup.accountLabel ? (
                                        <>
                                            <dt>Account</dt>
                                            <dd style={{ margin: 0 }}>{setup.accountLabel}</dd>
                                        </>
                                    ) : null}
                                    {setup.expiresAt ? (
                                        <>
                                            <dt>Expires</dt>
                                            <dd style={{ margin: 0 }}>{setup.expiresAt}</dd>
                                        </>
                                    ) : null}
                                </dl>
                            ) : null}
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.55rem', alignItems: 'end' }}>
                        <label className="form-group" style={{ margin: 0 }}>
                            <span className="form-label">Authenticator code</span>
                            <input
                                className="form-input"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                value={confirmCode}
                                onChange={(event) => setConfirmCode(event.target.value)}
                            />
                        </label>
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => void confirmEnrollment()}
                            disabled={isBusy}
                        >
                            {pendingAction === 'confirm' ? <Loader2 size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                            Verify and enable
                        </button>
                    </div>
                </div>
            ) : null}

            {recoveryCodes.length > 0 ? (
                <div style={{ display: 'grid', gap: '0.45rem' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 750, color: 'var(--text-primary)' }}>Recovery codes</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.4rem' }}>
                        {recoveryCodes.map((code) => (
                            <code key={code} style={{ padding: '0.45rem 0.55rem', borderRadius: 8, background: '#ffffff', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '0.78rem' }}>
                                {code}
                            </code>
                        ))}
                    </div>
                </div>
            ) : null}

            {state.enabled ? (
                <div style={{ display: 'grid', gap: '0.6rem' }}>
                    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                        {state.verifiedAt ? <span>Last verified {state.verifiedAt}</span> : null}
                        {recoverySummary ? <span>{recoverySummary}</span> : null}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.55rem', alignItems: 'end' }}>
                        <label className="form-group" style={{ margin: 0 }}>
                            <span className="form-label">Authenticator or backup code</span>
                            <input
                                className="form-input"
                                inputMode="text"
                                autoComplete="one-time-code"
                                value={disableCode}
                                onChange={(event) => setDisableCode(event.target.value)}
                                disabled={disableBlockedByPolicy}
                            />
                        </label>
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void disableEnrollment()}
                            disabled={isBusy || disableBlockedByPolicy}
                        >
                            {pendingAction === 'disable' ? <Loader2 size={15} aria-hidden="true" /> : <ShieldOff size={15} aria-hidden="true" />}
                            Disable MFA
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
