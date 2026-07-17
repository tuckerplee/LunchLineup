'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Copy, Printer } from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { fetchPublicApi } from '@/lib/client-api';
import { safeInternalNavigationPath } from '@/lib/safe-navigation';
import { legalContacts } from '../legal-config';
import { readOneTimeRecoveryCodes, recoveryCodesAsText } from './recovery-codes';

type MfaMode = 'checking' | 'verify' | 'setup' | 'recovery-codes' | 'recovery';

type MfaSetup = {
    manualEntryKey?: string;
    otpauthUrl?: string;
    qrCodeDataUrl?: string;
    expiresAt?: string;
};

function getCsrfToken(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function readEnrollmentEnabled(payload: unknown): boolean | null {
    if (!isRecord(payload)) return null;
    for (const key of ['enabled', 'mfaEnabled', 'enrolled']) {
        if (typeof payload[key] === 'boolean') return payload[key];
    }
    return null;
}

function readSetup(payload: unknown): MfaSetup | null {
    if (!isRecord(payload)) return null;
    const nestedSetup = isRecord(payload.setup) ? payload.setup : null;
    const source = nestedSetup ?? payload;
    const setup: MfaSetup = {
        manualEntryKey: readString(source.manualEntryKey) ?? readString(source.secret),
        otpauthUrl: readString(source.otpauthUrl),
        qrCodeDataUrl: readString(source.qrCodeDataUrl),
        expiresAt: readString(source.expiresAt),
    };
    return setup.manualEntryKey || setup.otpauthUrl || setup.qrCodeDataUrl ? setup : null;
}

function readMessage(payload: unknown, fallback: string): string {
    if (!isRecord(payload)) return fallback;
    return readString(payload.message) ?? readString(payload.error) ?? fallback;
}

async function readJson(response: Response): Promise<unknown> {
    return response.json().catch(() => ({}));
}

function csrfHeaders(): Record<string, string> {
    const csrfToken = getCsrfToken();
    return {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    };
}

function MfaError({ message }: { message: string | null }) {
    if (!message) return null;

    return (
        <div className="mfa-error" role="alert" aria-live="assertive" aria-atomic="true">
            {message}
        </div>
    );
}

function PrivilegedAccountRecovery() {
    const support = legalContacts.support;

    return (
        <aside className="mfa-support" aria-labelledby="mfa-support-title">
            <strong id="mfa-support-title">Lost every MFA factor?</strong>
            <p>Workspace owners and administrators can contact support for identity-verified account recovery.</p>
            <a className="btn btn-secondary btn-sm" href={support.href ?? '/privacy'}>
                Contact LunchLineup support
            </a>
        </aside>
    );
}

function MfaContent() {
    const searchParams = useSearchParams();
    const requestedNextPath = safeInternalNavigationPath(searchParams.get('next'));
    const nextPath = requestedNextPath === '/mfa' || requestedNextPath.startsWith('/mfa?')
        ? '/dashboard'
        : requestedNextPath;
    const [mode, setMode] = useState<MfaMode>('checking');
    const [setup, setSetup] = useState<MfaSetup | null>(null);
    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
    const [recoveryCodesAcknowledged, setRecoveryCodesAcknowledged] = useState(false);
    const [copyStatus, setCopyStatus] = useState<string | null>(null);
    const [recoveryMessage, setRecoveryMessage] = useState('Contact your workspace administrator to finish MFA setup, then sign in again.');
    const [isHydrated, setIsHydrated] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        setIsHydrated(true);
    }, []);

    const beginEnrollment = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetchPublicApi('/auth/mfa/enrollment', {
                method: 'POST',
                headers: csrfHeaders(),
                credentials: 'include',
            });
            const data = await readJson(res);
            if (!res.ok) {
                setRecoveryMessage(readMessage(data, 'MFA setup is required, but setup cannot be started from this browser session. Contact your workspace administrator, then sign in again.'));
                setMode('recovery');
                return false;
            }

            const nextSetup = readSetup(data);
            if (!nextSetup) {
                setRecoveryMessage('MFA setup is required, but the server did not return setup details. Contact your workspace administrator, then sign in again.');
                setMode('recovery');
                return false;
            }

            setSetup(nextSetup);
            setMode('setup');
            return true;
        } catch {
            setRecoveryMessage('MFA setup is required, but setup is temporarily unavailable. Contact your workspace administrator, then sign in again.');
            setMode('recovery');
            return false;
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function loadEnrollmentState() {
            try {
                const res = await fetchPublicApi('/auth/mfa/enrollment', {
                    method: 'GET',
                    credentials: 'include',
                    cache: 'no-store',
                });
                const data = await readJson(res);
                if (cancelled) return;

                if (res.status === 401) {
                    setRecoveryMessage('Your sign-in expired. Sign in again to continue.');
                    setMode('recovery');
                    return;
                }

                if (!res.ok) {
                    setMode('verify');
                    return;
                }

                const existingSetup = readSetup(data);
                if (existingSetup) {
                    setSetup(existingSetup);
                    setMode('setup');
                    return;
                }

                const enabled = readEnrollmentEnabled(data);
                if (enabled === false) {
                    await beginEnrollment();
                    return;
                }

                setMode('verify');
            } catch {
                if (!cancelled) setMode('verify');
            }
        }

        void loadEnrollmentState();
        return () => {
            cancelled = true;
        };
    }, [beginEnrollment]);

    const verifyCode = async (event: React.FormEvent) => {
        event.preventDefault();
        const normalizedCode = code.trim().replace(/\s+/g, '');
        if (normalizedCode.length < 6) {
            setError('Enter your authentication code.');
            return;
        }

        setIsLoading(true);
        setError(null);
        try {
            const res = await fetchPublicApi('/auth/mfa/verify', {
                method: 'POST',
                headers: csrfHeaders(),
                credentials: 'include',
                body: JSON.stringify({ code: normalizedCode }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                const message = readMessage(data, 'Invalid authentication code.');
                if (res.status === 409 || /enroll|setup|required/i.test(message)) {
                    await beginEnrollment();
                    return;
                }
                throw new Error(message);
            }
            window.location.assign(nextPath);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to verify the code.');
            setIsLoading(false);
        }
    };

    const confirmEnrollment = async (event: React.FormEvent) => {
        event.preventDefault();
        const normalizedCode = code.trim().replace(/\s+/g, '');
        if (normalizedCode.length < 6) {
            setError('Enter your authenticator code.');
            return;
        }

        setIsLoading(true);
        setError(null);
        try {
            const res = await fetchPublicApi('/auth/mfa/enrollment', {
                method: 'PUT',
                headers: csrfHeaders(),
                credentials: 'include',
                body: JSON.stringify({ code: normalizedCode }),
            });
            const data = await readJson(res);
            if (!res.ok) {
                throw new Error(readMessage(data, 'Unable to enable MFA.'));
            }
            const oneTimeCodes = readOneTimeRecoveryCodes(data);
            if (oneTimeCodes.length === 0) {
                throw new Error('MFA was enabled, but no recovery codes were returned. Contact your workspace administrator before continuing.');
            }
            setCode('');
            setSetup(null);
            setRecoveryCodes(oneTimeCodes);
            setRecoveryCodesAcknowledged(false);
            setCopyStatus(null);
            setMode('recovery-codes');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to enable MFA.');
            setIsLoading(false);
        }
    };

    const copyRecoveryCodes = async () => {
        setCopyStatus(null);
        try {
            if (!navigator.clipboard?.writeText) {
                throw new Error('Clipboard access is unavailable.');
            }
            await navigator.clipboard.writeText(recoveryCodesAsText(recoveryCodes));
            setCopyStatus('Recovery codes copied.');
        } catch (err) {
            setCopyStatus(err instanceof Error ? err.message : 'Unable to copy recovery codes.');
        }
    };

    const continueAfterRecoveryCodes = () => {
        if (!recoveryCodesAcknowledged) return;
        setRecoveryCodes([]);
        setCopyStatus(null);
        window.location.assign(nextPath);
    };

    if (!isHydrated) return <MfaLoadingFallback />;

    return (
        <main className="mfa-shell">
            <header className="mfa-header">
                <Link href="/" className="mfa-brand">
                    <LunchLineupMark size={34} />
                    <span>LunchLineup</span>
                </Link>
            </header>

            <section className="mfa-card surface-card">
                {mode === 'checking' ? (
                    <>
                        <h1>Checking your sign-in</h1>
                        <p>Loading your MFA session.</p>
                    </>
                ) : null}

                {mode === 'verify' ? (
                    <>
                        <h1>Verify your sign-in</h1>
                        <p>Enter your authenticator app code or a backup code.</p>

                        <form onSubmit={verifyCode} className="mfa-form">
                            <label className="form-group">
                                <span className="form-label">Authentication code</span>
                                <input
                                    type="text"
                                    className="form-input"
                                    inputMode="text"
                                    autoComplete="one-time-code"
                                    value={code}
                                    onChange={(event) => setCode(event.target.value)}
                                    autoFocus
                                    required
                                />
                            </label>

                            <MfaError message={error} />

                            <button type="submit" className="btn btn-primary" disabled={isLoading}>
                                {isLoading ? 'Verifying...' : 'Verify and continue'}
                            </button>
                        </form>
                        <PrivilegedAccountRecovery />
                    </>
                ) : null}

                {mode === 'setup' ? (
                    <>
                        <h1>Set up multi-factor authentication</h1>
                        <p>Scan the QR code or enter the setup key, then confirm the authenticator code.</p>

                        {setup?.qrCodeDataUrl ? (
                            <img className="mfa-qr" src={setup.qrCodeDataUrl} alt="MFA setup QR code" />
                        ) : null}

                        <label className="form-group">
                            <span className="form-label">Manual setup key</span>
                            <input
                                type="text"
                                className="form-input mfa-key"
                                value={setup?.manualEntryKey ?? setup?.otpauthUrl ?? ''}
                                readOnly
                            />
                        </label>

                        <form onSubmit={confirmEnrollment} className="mfa-form">
                            <label className="form-group">
                                <span className="form-label">Authenticator code</span>
                                <input
                                    type="text"
                                    className="form-input"
                                    inputMode="text"
                                    autoComplete="one-time-code"
                                    value={code}
                                    onChange={(event) => setCode(event.target.value)}
                                    autoFocus
                                    required
                                />
                            </label>

                            <MfaError message={error} />

                            <button type="submit" className="btn btn-primary" disabled={isLoading}>
                                {isLoading ? 'Enabling...' : 'Enable MFA and continue'}
                            </button>
                        </form>
                    </>
                ) : null}

                {mode === 'recovery-codes' ? (
                    <section className="mfa-recovery" aria-labelledby="mfa-recovery-title">
                        <h1 id="mfa-recovery-title">Save your recovery codes</h1>
                        <p>
                            These one-time codes are shown only now. Store them somewhere private before continuing.
                        </p>

                        <ul className="mfa-recovery-grid" aria-label="One-time MFA recovery codes">
                            {recoveryCodes.map((recoveryCode) => (
                                <li key={recoveryCode}>
                                    <code>{recoveryCode}</code>
                                </li>
                            ))}
                        </ul>

                        <div className="mfa-recovery-actions" role="group" aria-label="Recovery code actions">
                            <button type="button" className="btn btn-secondary" onClick={() => void copyRecoveryCodes()}>
                                <Copy size={16} aria-hidden="true" />
                                Copy codes
                            </button>
                            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
                                <Printer size={16} aria-hidden="true" />
                                Print codes
                            </button>
                        </div>

                        <div className="mfa-copy-status" role="status" aria-live="polite">
                            {copyStatus}
                        </div>

                        <label className="mfa-acknowledgment">
                            <input
                                type="checkbox"
                                checked={recoveryCodesAcknowledged}
                                onChange={(event) => setRecoveryCodesAcknowledged(event.target.checked)}
                            />
                            <span>I saved these recovery codes in a secure place.</span>
                        </label>

                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={!recoveryCodesAcknowledged}
                            onClick={continueAfterRecoveryCodes}
                        >
                            Continue to LunchLineup
                        </button>
                    </section>
                ) : null}

                {mode === 'recovery' ? (
                    <>
                        <h1>MFA setup needs help</h1>
                        <p>{recoveryMessage}</p>
                        <PrivilegedAccountRecovery />
                    </>
                ) : null}

                <Link href="/auth/login" className="mfa-link">Use a different account</Link>
            </section>

            <style jsx>{`
                .mfa-shell {
                    min-height: 100vh;
                    display: grid;
                    grid-template-rows: auto 1fr;
                    padding: 1.1rem;
                    background:
                        linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(15, 118, 110, 0.06) 44%, transparent 72%),
                        var(--bg);
                }

                .mfa-header {
                    display: flex;
                    align-items: center;
                    min-height: 42px;
                }

                .mfa-brand {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.55rem;
                    font-weight: 800;
                    color: var(--text-primary);
                }

                .mfa-card {
                    width: min(100%, 420px);
                    align-self: center;
                    justify-self: center;
                    padding: 1.25rem;
                    display: grid;
                    gap: 0.85rem;
                }

                .mfa-card h1 {
                    margin: 0;
                    font-size: 1.35rem;
                    line-height: 1.15;
                    color: var(--text-primary);
                }

                .mfa-card p {
                    margin: 0;
                    color: var(--text-secondary);
                    font-size: 0.92rem;
                }

                .mfa-form {
                    display: grid;
                    gap: 0.7rem;
                }

                .mfa-form button {
                    width: 100%;
                }

                .mfa-qr {
                    width: min(100%, 180px);
                    aspect-ratio: 1;
                    justify-self: center;
                    border-radius: 8px;
                    border: 1px solid var(--border);
                    background: #fff;
                }

                .mfa-key {
                    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                    font-size: 0.86rem;
                }

                .mfa-error {
                    padding: 0.62rem 0.7rem;
                    border-radius: 8px;
                    border: 1px solid #ffd0da;
                    background: #fff1f4;
                    color: #cb3653;
                    font-size: 0.8rem;
                    font-weight: 600;
                }

                .mfa-support {
                    display: grid;
                    gap: 0.55rem;
                    padding: 0.75rem;
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    background: var(--surface-muted);
                }

                .mfa-support strong {
                    color: var(--text-primary);
                    font-size: 0.9rem;
                }

                .mfa-support .btn {
                    justify-self: start;
                }

                .mfa-recovery {
                    display: grid;
                    gap: 0.8rem;
                }

                .mfa-recovery-grid {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 0.45rem;
                    margin: 0;
                    padding: 0;
                    list-style: none;
                }

                .mfa-recovery-grid li {
                    min-width: 0;
                    padding: 0.5rem 0.55rem;
                    border: 1px solid var(--border);
                    border-radius: 6px;
                    background: var(--surface-muted);
                    text-align: center;
                }

                .mfa-recovery-grid code {
                    overflow-wrap: anywhere;
                    color: var(--text-primary);
                    font-size: 0.78rem;
                    font-weight: 700;
                }

                .mfa-recovery-actions {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 0.55rem;
                }

                .mfa-recovery-actions button {
                    justify-content: center;
                }

                .mfa-recovery > .btn:disabled {
                    cursor: not-allowed;
                    opacity: 0.5;
                }

                .mfa-copy-status {
                    min-height: 1.1rem;
                    color: var(--text-secondary);
                    font-size: 0.78rem;
                }

                .mfa-acknowledgment {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.55rem;
                    color: var(--text-primary);
                    font-size: 0.84rem;
                    font-weight: 650;
                }

                .mfa-acknowledgment input {
                    width: 1rem;
                    height: 1rem;
                    margin-top: 0.08rem;
                }

                .mfa-link {
                    justify-self: center;
                    color: var(--brand);
                    font-weight: 700;
                    font-size: 0.88rem;
                }

                @media (max-width: 380px) {
                    .mfa-recovery-grid,
                    .mfa-recovery-actions {
                        grid-template-columns: 1fr;
                    }
                }

                @media print {
                    .mfa-shell {
                        display: block;
                        min-height: 0;
                        padding: 0;
                        background: #ffffff;
                    }

                    .mfa-header,
                    .mfa-recovery-actions,
                    .mfa-copy-status,
                    .mfa-acknowledgment,
                    .mfa-recovery > .btn,
                    .mfa-link {
                        display: none;
                    }

                    .mfa-card {
                        width: 100%;
                        border: 0;
                        box-shadow: none;
                    }
                }
            `}</style>
        </main>
    );
}

function MfaLoadingFallback() {
    return (
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f6f8fc', color: '#12213a' }}>
            <div role="status" aria-live="polite" style={{ display: 'grid', justifyItems: 'center', gap: 12, fontWeight: 800 }}>
                <LunchLineupMark size={42} />
                <span style={{ fontSize: 20 }}>LunchLineup</span>
                <span style={{ color: '#58708f', fontSize: 14 }}>Loading secure verification...</span>
            </div>
        </main>
    );
}

export default function MfaPage() {
    return (
        <Suspense fallback={<MfaLoadingFallback />}>
            <MfaContent />
        </Suspense>
    );
}
