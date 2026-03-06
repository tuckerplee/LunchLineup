'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
const OIDC_ENABLED = (process.env.NEXT_PUBLIC_OIDC_ENABLED ?? '').toLowerCase() === 'true';

type Step = 'email' | 'otp';

function LoginContent() {
    const searchParams = useSearchParams();
    const prefillEmail = searchParams.get('email') ?? '';
    const stepParam = searchParams.get('step');
    const errorParam = searchParams.get('error');
    const nextPath = searchParams.get('next') ?? '/dashboard';

    const [step, setStep] = useState<Step>('email');
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState(['', '', '', '', '', '']);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resendCountdown, setResendCountdown] = useState(0);

    const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
    const verifyInFlightRef = useRef(false);

    useEffect(() => {
        if (prefillEmail) setEmail(prefillEmail);
        if (stepParam === 'otp') setStep('otp');
        if (errorParam === 'invalid') setError('Invalid or expired code. Please try again.');
    }, [prefillEmail, stepParam, errorParam]);

    useEffect(() => {
        if (resendCountdown <= 0) return;
        const t = setTimeout(() => setResendCountdown((c) => c - 1), 1000);
        return () => clearTimeout(t);
    }, [resendCountdown]);

    const handleSendOtp = async (e?: React.FormEvent) => {
        e?.preventDefault();
        setError(null);

        const normalizedEmail = email.trim().toLowerCase();
        if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            setError('Enter a valid email address.');
            return;
        }

        setIsLoading(true);
        try {
            const res = await fetch(`${API}/auth/email/send-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: normalizedEmail }),
                credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setError(data.error ?? 'Failed to send code. Please try again.');
            } else {
                setEmail(normalizedEmail);
                setStep('otp');
                setResendCountdown(60);
                setTimeout(() => otpRefs.current[0]?.focus(), 100);
            }
        } catch {
            setError('Network error. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleOtpInput = (index: number, value: string) => {
        if (value.length === 6 && /^\d{6}$/.test(value)) {
            const digits = value.split('');
            setOtp(digits);
            otpRefs.current[5]?.focus();
            return;
        }

        const digit = value.replace(/\D/g, '').slice(-1);
        const next = [...otp];
        next[index] = digit;
        setOtp(next);

        if (digit && index < 5) otpRefs.current[index + 1]?.focus();
    };

    const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && !otp[index] && index > 0) {
            otpRefs.current[index - 1]?.focus();
        }
    };

    const handleVerifyOtp = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (verifyInFlightRef.current) return;

        const code = otp.join('');
        if (code.length !== 6) {
            setError('Enter all 6 digits.');
            return;
        }

        setError(null);
        verifyInFlightRef.current = true;
        setIsLoading(true);

        const safeNext = nextPath.startsWith('/') ? nextPath : '/dashboard';
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = `${API}/auth/email/verify-otp?redirect=1&next=${encodeURIComponent(safeNext)}`;
        form.style.display = 'none';

        const emailInput = document.createElement('input');
        emailInput.name = 'email';
        emailInput.value = email.trim().toLowerCase();
        form.appendChild(emailInput);

        const codeInput = document.createElement('input');
        codeInput.name = 'code';
        codeInput.value = code;
        form.appendChild(codeInput);

        document.body.appendChild(form);
        form.submit();
    };

    const handleOidcLogin = () => {
        window.location.href = `${API}/auth/login`;
    };

    return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '1rem' }}>
            <div
                className="surface-card"
                style={{
                    width: '100%',
                    maxWidth: 920,
                    overflow: 'hidden',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    background:
                        'radial-gradient(30rem 16rem at 0% 0%, rgba(79,121,255,0.16), transparent 62%), radial-gradient(24rem 14rem at 100% 100%, rgba(34,184,207,0.12), transparent 64%), #ffffff',
                }}
            >
                <aside style={{ padding: '1.3rem', borderRight: '1px solid var(--border)' }}>
                    <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.55rem', marginBottom: '1rem' }}>
                        <div
                            style={{
                                width: 34,
                                height: 34,
                                borderRadius: 10,
                                background: 'linear-gradient(135deg, #4171ff, #2f63ff 60%, #22b8cf)',
                                color: '#ffffff',
                                display: 'grid',
                                placeItems: 'center',
                            }}
                        >
                            🍱
                        </div>
                        <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>LunchLineup</span>
                    </Link>

                    <h1 style={{ fontSize: '1.9rem', lineHeight: 1.08, letterSpacing: '-0.03em', color: 'var(--text-primary)', marginBottom: '0.6rem' }}>
                        Smart scheduling for fast-moving teams.
                    </h1>
                    <p className="workspace-subtitle" style={{ marginBottom: '1rem' }}>
                        One place for shift planning, break coverage, and daily staffing decisions.
                    </p>

                    <div className="surface-muted" style={{ padding: '0.9rem' }}>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 6 }}>
                            Secure sign-in with email OTP
                        </div>
                        <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                            No password resets, no lockout loops, and quick verification.
                        </div>
                    </div>
                </aside>

                <section style={{ padding: '1.3rem' }}>
                    <h2 style={{ fontSize: '1.3rem', color: 'var(--text-primary)', marginBottom: 4 }}>{step === 'email' ? 'Sign in' : 'Check your email'}</h2>
                    <p className="workspace-subtitle" style={{ marginBottom: '0.9rem' }}>
                        {step === 'email' ? 'Enter your email to receive a login code.' : `Enter the 6-digit code sent to ${email}.`}
                    </p>

                    {step === 'email' ? (
                        <>
                            {OIDC_ENABLED ? (
                                <button type="button" onClick={handleOidcLogin} className="btn btn-secondary" style={{ width: '100%', marginBottom: '0.65rem' }}>
                                    Continue with SSO / OIDC
                                </button>
                            ) : null}

                            <form onSubmit={handleSendOtp} style={{ display: 'grid', gap: '0.62rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Email address</span>
                                    <input
                                        type="email"
                                        className="form-input"
                                        placeholder="you@company.com"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        autoComplete="email"
                                        required
                                    />
                                </label>

                                {error ? (
                                    <div style={{ padding: '0.62rem 0.7rem', borderRadius: 10, border: '1px solid #ffd0da', background: '#fff1f4', color: '#cb3653', fontSize: '0.8rem', fontWeight: 600 }}>
                                        {error}
                                    </div>
                                ) : null}

                                <button type="submit" className="btn btn-primary" disabled={isLoading} style={{ width: '100%' }}>
                                    {isLoading ? 'Sending...' : 'Continue'}
                                </button>
                            </form>
                        </>
                    ) : (
                        <form onSubmit={handleVerifyOtp} style={{ display: 'grid', gap: '0.62rem' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '0.35rem' }}>
                                {otp.map((digit, i) => (
                                    <input
                                        key={i}
                                        ref={(el) => {
                                            otpRefs.current[i] = el;
                                        }}
                                        type="text"
                                        inputMode="numeric"
                                        maxLength={6}
                                        value={digit}
                                        onChange={(e) => handleOtpInput(i, e.target.value)}
                                        onKeyDown={(e) => handleOtpKeyDown(i, e)}
                                        aria-label={`Digit ${i + 1}`}
                                        className="form-input"
                                        style={{ textAlign: 'center', fontWeight: 700, fontSize: '1rem' }}
                                    />
                                ))}
                            </div>

                            {error ? (
                                <div style={{ padding: '0.62rem 0.7rem', borderRadius: 10, border: '1px solid #ffd0da', background: '#fff1f4', color: '#cb3653', fontSize: '0.8rem', fontWeight: 600 }}>
                                    {error}
                                </div>
                            ) : null}

                            <button type="submit" className="btn btn-primary" disabled={isLoading || otp.join('').length !== 6} style={{ width: '100%' }}>
                                {isLoading ? 'Verifying...' : 'Verify and continue'}
                            </button>

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                {resendCountdown > 0 ? (
                                    <span className="text-sm text-muted">Resend in {resendCountdown}s</span>
                                ) : (
                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleSendOtp()}>
                                        Resend code
                                    </button>
                                )}

                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                        setStep('email');
                                        setOtp(['', '', '', '', '', '']);
                                        setError(null);
                                        verifyInFlightRef.current = false;
                                        setIsLoading(false);
                                    }}
                                >
                                    Use different email
                                </button>
                            </div>
                        </form>
                    )}

                    <div className="divider" style={{ marginTop: '0.9rem', marginBottom: '0.75rem' }} />
                    <p className="text-sm text-secondary" style={{ textAlign: 'center' }}>
                        New here?{' '}
                        <Link href="/onboarding" style={{ color: 'var(--brand)', fontWeight: 700 }}>
                            Create an account
                        </Link>
                    </p>
                </section>
            </div>

            <style jsx>{`
                @media (max-width: 900px) {
                    div[style*='max-width: 920px'] {
                        grid-template-columns: 1fr !important;
                    }

                    aside {
                        border-right: none !important;
                        border-bottom: 1px solid var(--border);
                    }
                }
            `}</style>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<div style={{ minHeight: '100vh' }} />}>
            <LoginContent />
        </Suspense>
    );
}
