'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { fetchPublicApi } from '@/lib/client-api';
const GENERIC_REQUEST_MESSAGE = 'If a matching account exists, a password reset email will be sent shortly.';
const RESET_TOKEN_COOKIE = 'll_password_reset_token';

function normalizeWorkspaceSlug(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function readResetTokenCookie(): string {
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith(`${RESET_TOKEN_COOKIE}=`));
    if (!pair) return '';
    try {
        return decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
    } catch {
        return '';
    }
}

function clearResetTokenCookie() {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${RESET_TOKEN_COOKIE}=; Path=/auth/reset-password; Max-Age=0; SameSite=Strict${secure}`;
}

export function resetConfirmationErrorMessage(status: number): string {
    if (status === 429) return 'Too many reset attempts. Wait a moment, then try again.';
    if (status >= 500) return 'Password reset is temporarily unavailable. Please try again.';
    if (status >= 400 && status < 500) return 'Reset link is invalid or expired.';
    return 'Unable to reset password. Please try again.';
}

function ResetPasswordContent() {
    const searchParams = useSearchParams();
    const [token, setToken] = useState<string | null>(null);
    const [workspaceSlug, setWorkspaceSlug] = useState(normalizeWorkspaceSlug(searchParams.get('tenantSlug') ?? ''));
    const [identifier, setIdentifier] = useState(searchParams.get('identifier') ?? '');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const feedbackRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const tokenFromUrl = searchParams.get('token') ?? '';
        const cookieToken = readResetTokenCookie();

        if (tokenFromUrl) {
            const cleanUrl = new URL(window.location.href);
            cleanUrl.searchParams.delete('token');
            window.history.replaceState(
                window.history.state,
                '',
                `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
            );
        }
        if (cookieToken) clearResetTokenCookie();
        setToken(cookieToken || tokenFromUrl);
    }, [searchParams]);

    useEffect(() => {
        if (error || message) feedbackRef.current?.focus();
    }, [error, message]);

    const requestReset = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        setMessage(null);

        const normalizedWorkspace = normalizeWorkspaceSlug(workspaceSlug);
        const normalizedIdentifier = identifier.trim().toLowerCase();
        if (!normalizedWorkspace || !normalizedIdentifier) {
            setError('Enter your workspace and username or email.');
            return;
        }

        setWorkspaceSlug(normalizedWorkspace);
        setIsLoading(true);
        try {
            await fetchPublicApi('/auth/password/reset/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    tenantSlug: normalizedWorkspace,
                    identifier: normalizedIdentifier,
                }),
            });
            setMessage(GENERIC_REQUEST_MESSAGE);
        } catch {
            setMessage(GENERIC_REQUEST_MESSAGE);
        } finally {
            setIsLoading(false);
        }
    };

    const confirmReset = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        setMessage(null);

        if (!password || password.length < 8) {
            setError('Use at least 8 characters.');
            return;
        }
        if (password !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }

        setIsLoading(true);
        try {
            const response = await fetchPublicApi('/auth/password/reset/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ token, password }),
            });
            if (!response.ok) {
                setError(resetConfirmationErrorMessage(response.status));
                return;
            }
            setPassword('');
            setConfirmPassword('');
            setMessage('Password updated. Sign in with your new password.');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to reset password.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <main className="reset-shell">
            <section className="reset-panel" aria-labelledby="reset-title">
                <div className="reset-brand">
                    <LunchLineupMark size={38} />
                    <span>LunchLineup</span>
                </div>
                <h1 id="reset-title">{token ? 'Set new password' : token === null ? 'Password recovery' : 'Reset password'}</h1>
                <p className="reset-subtitle">
                    {token
                        ? 'Choose a new password for your migrated LunchLineup account.'
                        : token === null
                            ? 'Preparing the secure password recovery form.'
                            : 'Enter your workspace and username or email.'}
                </p>

                {token === null ? (
                    <p role="status" aria-live="polite" className="reset-loading">Loading password recovery...</p>
                ) : token ? (
                    <form onSubmit={confirmReset} className="reset-form">
                        <label className="reset-field">
                            <span>New password</span>
                            <input
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                autoComplete="new-password"
                                minLength={8}
                                required
                            />
                        </label>
                        <label className="reset-field">
                            <span>Confirm password</span>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(event) => setConfirmPassword(event.target.value)}
                                autoComplete="new-password"
                                minLength={8}
                                required
                            />
                        </label>
                        {error ? <div ref={feedbackRef} className="reset-error" role="alert" tabIndex={-1}>{error}</div> : null}
                        {message ? <div ref={feedbackRef} className="reset-success" role="status" tabIndex={-1}>{message}</div> : null}
                        <button type="submit" disabled={isLoading || !password || !confirmPassword}>
                            {isLoading ? 'Updating...' : 'Update password'}
                        </button>
                    </form>
                ) : (
                    <form onSubmit={requestReset} className="reset-form">
                        <label className="reset-field">
                            <span>Workspace slug</span>
                            <input
                                type="text"
                                value={workspaceSlug}
                                onChange={(event) => setWorkspaceSlug(normalizeWorkspaceSlug(event.target.value))}
                                autoComplete="organization"
                                required
                            />
                        </label>
                        <label className="reset-field">
                            <span>Username or email</span>
                            <input
                                type="text"
                                value={identifier}
                                onChange={(event) => setIdentifier(event.target.value)}
                                autoComplete="username"
                                required
                            />
                        </label>
                        {error ? <div ref={feedbackRef} className="reset-error" role="alert" tabIndex={-1}>{error}</div> : null}
                        {message ? <div ref={feedbackRef} className="reset-success" role="status" tabIndex={-1}>{message}</div> : null}
                        <button type="submit" disabled={isLoading || !workspaceSlug || !identifier}>
                            {isLoading ? 'Sending...' : 'Send reset link'}
                        </button>
                    </form>
                )}

                <Link className="reset-link" href="/auth/login">
                    Back to sign in
                </Link>
            </section>

            <style>{`
                .reset-shell {
                    min-height: 100vh;
                    display: grid;
                    place-items: center;
                    padding: 24px;
                    background: #08111f;
                    color: #f8fafc;
                }

                .reset-panel {
                    width: min(100%, 420px);
                    display: grid;
                    gap: 18px;
                    padding: 32px;
                    border: 1px solid rgba(148, 163, 184, 0.24);
                    border-radius: 8px;
                    background: rgba(15, 23, 42, 0.88);
                    box-shadow: 0 24px 80px rgba(2, 6, 23, 0.42);
                }

                .reset-brand {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    font-size: 20px;
                    font-weight: 900;
                }

                .reset-panel h1 {
                    margin: 0;
                    font-size: 26px;
                    line-height: 1.15;
                }

                .reset-subtitle {
                    margin: 0;
                    color: #94a3b8;
                    font-size: 14px;
                    line-height: 1.55;
                }

                .reset-loading {
                    margin: 0;
                    color: #bae6fd;
                    font-size: 14px;
                    font-weight: 800;
                }

                .reset-form {
                    display: grid;
                    gap: 14px;
                }

                .reset-field {
                    display: grid;
                    gap: 7px;
                    color: #cbd5e1;
                    font-size: 13px;
                    font-weight: 700;
                }

                .reset-field input {
                    width: 100%;
                    min-height: 46px;
                    border: 1px solid rgba(148, 163, 184, 0.28);
                    border-radius: 8px;
                    background: rgba(15, 23, 42, 0.95);
                    color: #f8fafc;
                    font-size: 15px;
                    padding: 0 12px;
                    outline: none;
                }

                .reset-field input:focus {
                    border-color: #7dd3fc;
                    box-shadow: 0 0 0 3px rgba(125, 211, 252, 0.18);
                }

                .reset-error,
                .reset-success {
                    border-radius: 8px;
                    padding: 10px 12px;
                    font-size: 13px;
                    line-height: 1.45;
                }

                .reset-error {
                    color: #fecaca;
                    background: rgba(127, 29, 29, 0.36);
                    border: 1px solid rgba(248, 113, 113, 0.3);
                }

                .reset-success {
                    color: #bbf7d0;
                    background: rgba(20, 83, 45, 0.34);
                    border: 1px solid rgba(74, 222, 128, 0.28);
                }

                .reset-form button {
                    min-height: 46px;
                    border: 0;
                    border-radius: 8px;
                    background: #7dd3fc;
                    color: #06111e;
                    font-weight: 900;
                    cursor: pointer;
                }

                .reset-form button:disabled {
                    opacity: 0.55;
                    cursor: not-allowed;
                }

                .reset-link {
                    color: #bae6fd;
                    font-size: 14px;
                    font-weight: 800;
                    text-decoration: none;
                    justify-self: start;
                }

                @media (max-width: 520px) {
                    .reset-shell {
                        padding: 16px;
                        place-items: stretch;
                    }

                    .reset-panel {
                        align-self: center;
                        padding: 24px;
                    }
                }
            `}</style>
        </main>
    );
}

export default function ResetPasswordPage() {
    return (
        <Suspense fallback={(
            <main
                style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#08111f', color: '#f8fafc' }}
            >
                <div role="status" aria-live="polite" style={{ display: 'grid', justifyItems: 'center', gap: 12, fontWeight: 800 }}>
                    <LunchLineupMark size={42} />
                    <span style={{ fontSize: 20 }}>LunchLineup</span>
                    <span>Loading password recovery...</span>
                </div>
            </main>
        )}>
            <ResetPasswordContent />
        </Suspense>
    );
}
