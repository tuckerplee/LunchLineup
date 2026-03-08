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
        if (e.key === 'Enter') {
            e.preventDefault();
            void handleVerifyOtp();
            return;
        }
        if (e.key === 'Backspace' && !otp[index] && index > 0) {
            otpRefs.current[index - 1]?.focus();
        }
    };

    const handleVerifyOtp = (e?: React.FormEvent, forcedCode?: string) => {
        e?.preventDefault();
        if (verifyInFlightRef.current) return;

        const code = forcedCode ?? otp.join('');
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

    useEffect(() => {
        if (step !== 'otp' || isLoading || verifyInFlightRef.current) return;
        const code = otp.join('');
        if (/^\d{6}$/.test(code)) {
            void handleVerifyOtp(undefined, code);
        }
    }, [otp, step, isLoading]);

    const handleOidcLogin = () => {
        window.location.href = `${API}/auth/login`;
    };

    return (
        <div className="login-shell">
            <div className="login-orb login-orb--left" aria-hidden="true" />
            <div className="login-orb login-orb--right" aria-hidden="true" />

            <header className="login-header">
                <Link href="/" className="login-brand">
                    <div className="login-brand__icon">🍱</div>
                    <div>
                        <div className="login-brand__wordmark">LunchLineup</div>
                    </div>
                </Link>
            </header>

            <div className="login-layout">
                <aside className="login-context">
                    <div className="login-context__badge">Built for shift-based teams</div>
                    <h1 className="login-context__title">Break-aware scheduling for modern teams.</h1>
                    <p className="login-context__copy">
                        LunchLineup builds employee schedules with lunches, breaks, and coverage already placed.
                    </p>

                    <ul className="login-context__list">
                        <li>Break compliance built in</li>
                        <li>Floor coverage stays protected</li>
                        <li>Generate schedules in seconds</li>
                    </ul>
                </aside>

                <section className="login-auth">
                    <div className="surface-card login-card">
                        <h2 className="login-card__title">{step === 'email' ? 'Sign in to LunchLineup' : 'Check your email'}</h2>
                        <p className="login-card__subtitle">
                            {step === 'email' ? 'Enter your email and we’ll send a login code.' : `Enter the 6-digit code sent to ${email}.`}
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
                                        <span className="form-label">Work email</span>
                                        <input
                                            type="email"
                                            className="form-input"
                                            placeholder="name@company.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    void handleSendOtp();
                                                }
                                            }}
                                            autoComplete="email"
                                            required
                                        />
                                    </label>

                                    {error ? (
                                        <div className="login-card__error">
                                            {error}
                                        </div>
                                    ) : null}

                                    <button type="submit" className="btn btn-primary" disabled={isLoading} style={{ width: '100%' }}>
                                        {isLoading ? 'Sending...' : 'Email login code'}
                                    </button>

                                    <p className="login-card__trust">Secure sign-in · No passwords stored</p>
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
                                    <div className="login-card__error">
                                        {error}
                                    </div>
                                ) : null}

                                <button type="submit" className="btn btn-primary" disabled={isLoading || otp.join('').length !== 6} style={{ width: '100%' }}>
                                    {isLoading ? 'Verifying...' : 'Verify and continue'}
                                </button>

                                <p className="login-card__trust">Secure sign-in · No passwords stored</p>

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
                        <div className="login-secondary-cta">
                            <span>New to LunchLineup?</span>
                            <Link href="/onboarding">Create your account →</Link>
                        </div>
                    </div>
                </section>
            </div>

            <style jsx>{`
                .login-shell {
                    min-height: 100vh;
                    position: relative;
                    padding: 1.1rem;
                    display: grid;
                    grid-template-rows: auto 1fr;
                    align-content: normal;
                    align-items: stretch;
                    overflow: hidden;
                }

                .login-header {
                    position: relative;
                    z-index: 2;
                }

                .login-brand {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.55rem;
                    padding: 0.25rem 0.1rem;
                }

                .login-brand__icon {
                    width: 34px;
                    height: 34px;
                    border-radius: 10px;
                    background: linear-gradient(135deg, #4171ff, #2f63ff 60%, #22b8cf);
                    color: #ffffff;
                    display: grid;
                    place-items: center;
                }

                .login-brand__wordmark {
                    font-weight: 800;
                    color: var(--text-primary);
                    line-height: 1;
                }

                .login-layout {
                    width: min(1140px, 100%);
                    margin: 0 auto;
                    display: grid;
                    grid-template-columns: 1.1fr minmax(340px, 420px);
                    align-items: center;
                    align-self: center;
                    gap: 2.2rem;
                    position: relative;
                    z-index: 1;
                }

                .login-context {
                    padding: 0.8rem 0.4rem;
                }

                .login-context__badge {
                    display: inline-flex;
                    border: 1px solid var(--border);
                    background: var(--bg-soft);
                    color: var(--text-secondary);
                    border-radius: 999px;
                    padding: 0.3rem 0.65rem;
                    font-size: 0.75rem;
                    font-weight: 600;
                    margin-bottom: 0.9rem;
                }

                .login-context__title {
                    font-size: clamp(2rem, 5vw, 3.25rem);
                    line-height: 1.02;
                    letter-spacing: -0.035em;
                    color: var(--text-primary);
                    margin-bottom: 0.75rem;
                    max-width: 16ch;
                }

                .login-context__copy {
                    color: var(--text-secondary);
                    font-size: 1rem;
                    max-width: 44ch;
                    margin-bottom: 1.1rem;
                }

                .login-context__list {
                    list-style: none;
                    display: grid;
                    gap: 0.45rem;
                    color: var(--text-primary);
                    font-weight: 600;
                    font-size: 0.9rem;
                }

                .login-context__list li::before {
                    content: '•';
                    color: var(--brand);
                    margin-right: 0.4rem;
                }

                .login-auth {
                    display: grid;
                    place-items: center;
                }

                .login-card {
                    width: 100%;
                    max-width: 420px;
                    padding: 1.2rem;
                    border-radius: var(--radius-xl);
                    background:
                        radial-gradient(24rem 16rem at 0% 0%, rgba(79, 121, 255, 0.14), transparent 68%),
                        radial-gradient(22rem 13rem at 100% 100%, rgba(34, 184, 207, 0.1), transparent 66%),
                        #ffffff;
                }

                .login-card__title {
                    font-size: 1.32rem;
                    color: var(--text-primary);
                    margin-bottom: 0.18rem;
                    letter-spacing: -0.02em;
                }

                .login-card__subtitle {
                    color: var(--text-secondary);
                    margin-bottom: 0.9rem;
                    font-size: 0.93rem;
                }

                .login-card__trust {
                    text-align: center;
                    font-size: 0.76rem;
                    color: var(--text-muted);
                    margin-top: 0.1rem;
                }

                .login-card__error {
                    padding: 0.62rem 0.7rem;
                    border-radius: 10px;
                    border: 1px solid #ffd0da;
                    background: #fff1f4;
                    color: #cb3653;
                    font-size: 0.8rem;
                    font-weight: 600;
                }

                .login-secondary-cta {
                    display: grid;
                    justify-items: center;
                    gap: 0.1rem;
                    color: var(--text-secondary);
                    font-size: 0.88rem;
                }

                .login-secondary-cta a {
                    color: var(--brand);
                    font-weight: 700;
                }

                .login-orb {
                    position: absolute;
                    border-radius: 999px;
                    filter: blur(20px);
                    opacity: 0.5;
                    pointer-events: none;
                }

                .login-orb--left {
                    width: 400px;
                    height: 400px;
                    left: -160px;
                    top: -160px;
                    background: radial-gradient(circle at center, rgba(79, 121, 255, 0.28), transparent 68%);
                }

                .login-orb--right {
                    width: 440px;
                    height: 440px;
                    right: -180px;
                    bottom: -200px;
                    background: radial-gradient(circle at center, rgba(34, 184, 207, 0.24), transparent 66%);
                }

                @media (max-width: 980px) {
                    .login-shell {
                        padding: 0.95rem;
                    }

                    .login-layout {
                        grid-template-columns: 1fr;
                        gap: 1.25rem;
                        align-content: start;
                        margin-top: 0.55rem;
                    }

                    .login-context {
                        order: 1;
                        padding: 0.3rem 0.1rem;
                    }

                    .login-context__title {
                        font-size: clamp(1.7rem, 8vw, 2.2rem);
                        max-width: none;
                    }

                    .login-auth {
                        order: 2;
                    }

                    .login-card {
                        max-width: none;
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
