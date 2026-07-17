'use client';

import Link from 'next/link';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { fetchPublicApi } from '@/lib/client-api';

function getCsrfToken(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}


function readMessage(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== 'object') return fallback;
    const record = payload as Record<string, unknown>;
    return typeof record.message === 'string' && record.message.trim() ? record.message : fallback;
}

function ResetPinContent() {
    const [currentPin, setCurrentPin] = useState('');
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const rotatePin = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);

        if (!/^\d{4,8}$/.test(currentPin) || !/^\d{4,8}$/.test(newPin)) {
            setError('PINs must be 4 to 8 digits.');
            return;
        }
        if (currentPin === newPin) {
            setError('Choose a PIN different from the temporary PIN.');
            return;
        }
        if (newPin !== confirmPin) {
            setError('New PINs do not match.');
            return;
        }

        setIsLoading(true);
        try {
            const csrfToken = getCsrfToken();
            const rotateResponse = await fetchPublicApi('/users/me/pin', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
                },
                credentials: 'include',
                body: JSON.stringify({ currentPin, newPin }),
            });
            const rotatePayload = await rotateResponse.json().catch(() => ({}));
            if (!rotateResponse.ok) {
                throw new Error(readMessage(rotatePayload, 'Unable to update PIN.'));
            }

            window.location.assign('/auth/logout');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to update PIN.');
            setIsLoading(false);
        }
    };

    return (
        <main className="pin-reset-shell">
            <header className="pin-reset-header">
                <Link href="/" className="pin-reset-brand">
                    <LunchLineupMark size={34} />
                    <span>LunchLineup</span>
                </Link>
            </header>

            <section className="pin-reset-panel" aria-labelledby="pin-reset-title">
                <div className="pin-reset-icon" aria-hidden="true"><KeyRound size={22} /></div>
                <h1 id="pin-reset-title">Set a new PIN</h1>
                <p>Replace your temporary PIN before continuing.</p>

                <form onSubmit={rotatePin} className="pin-reset-form">
                    <label>
                        <span>Temporary PIN</span>
                        <input
                            type="password"
                            inputMode="numeric"
                            autoComplete="current-password"
                            value={currentPin}
                            onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                            required
                        />
                    </label>
                    <label>
                        <span>New PIN</span>
                        <input
                            type="password"
                            inputMode="numeric"
                            autoComplete="new-password"
                            value={newPin}
                            onChange={(event) => setNewPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                            required
                        />
                    </label>
                    <label>
                        <span>Confirm new PIN</span>
                        <input
                            type="password"
                            inputMode="numeric"
                            autoComplete="new-password"
                            value={confirmPin}
                            onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                            required
                        />
                    </label>

                    {error ? <div className="pin-reset-error" role="alert">{error}</div> : null}

                    <button type="submit" className="btn btn-primary" disabled={isLoading}>
                        <KeyRound size={16} aria-hidden="true" />
                        {isLoading ? 'Updating...' : 'Update PIN'}
                    </button>
                </form>

                <Link href="/auth/logout" className="pin-reset-link">Sign out</Link>
            </section>

            <style>{`
                .pin-reset-shell {
                    min-height: 100vh;
                    display: grid;
                    grid-template-rows: auto 1fr;
                    background: #0b1620;
                    color: #f8fafc;
                }
                .pin-reset-header {
                    padding: 22px clamp(18px, 4vw, 48px);
                }
                .pin-reset-brand {
                    display: inline-flex;
                    align-items: center;
                    gap: 10px;
                    color: inherit;
                    text-decoration: none;
                    font-size: 18px;
                    font-weight: 900;
                }
                .pin-reset-panel {
                    width: min(calc(100% - 32px), 430px);
                    align-self: center;
                    justify-self: center;
                    display: grid;
                    gap: 16px;
                    padding: 30px;
                    border: 1px solid rgba(148, 163, 184, 0.28);
                    border-radius: 8px;
                    background: #13232b;
                    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
                }
                .pin-reset-icon {
                    width: 42px;
                    height: 42px;
                    display: grid;
                    place-items: center;
                    border-radius: 8px;
                    background: #facc15;
                    color: #17202a;
                }
                .pin-reset-panel h1 {
                    margin: 0;
                    font-size: 26px;
                    line-height: 1.2;
                }
                .pin-reset-panel > p {
                    margin: 0;
                    color: #cbd5e1;
                    font-size: 14px;
                }
                .pin-reset-form,
                .pin-reset-form label {
                    display: grid;
                    gap: 8px;
                }
                .pin-reset-form {
                    gap: 14px;
                }
                .pin-reset-form label span {
                    color: #dce7eb;
                    font-size: 13px;
                    font-weight: 800;
                }
                .pin-reset-form input {
                    width: 100%;
                    min-height: 46px;
                    border: 1px solid #52666d;
                    border-radius: 8px;
                    background: #091218;
                    color: #f8fafc;
                    padding: 0 12px;
                    font-size: 16px;
                }
                .pin-reset-form input:focus {
                    outline: 3px solid rgba(250, 204, 21, 0.24);
                    border-color: #facc15;
                }
                .pin-reset-form button {
                    min-height: 46px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                }
                .pin-reset-error {
                    padding: 10px 12px;
                    border: 1px solid #ef4444;
                    border-radius: 8px;
                    background: #451a1a;
                    color: #fecaca;
                    font-size: 13px;
                }
                .pin-reset-link {
                    color: #fde68a;
                    font-size: 14px;
                    font-weight: 800;
                    text-decoration: none;
                    justify-self: start;
                }
                @media (max-width: 520px) {
                    .pin-reset-panel {
                        padding: 24px;
                    }
                }
            `}</style>
        </main>
    );
}

export default function ResetPinPage() {
    return <ResetPinContent />;
}
