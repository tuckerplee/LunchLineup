'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { apiPath, fetchPublicApi } from '@/lib/client-api';
import { safeInternalNavigationPath } from '@/lib/safe-navigation';
import { normalizeWorkspaceSlug, readRememberedWorkspaceSlug, rememberWorkspaceSlug } from '@/lib/workspace-slug';
import { isSelfServiceSignupAvailable } from '../../onboarding/challenge';

const OIDC_ENABLED = (process.env.NEXT_PUBLIC_OIDC_ENABLED ?? '').toLowerCase() === 'true';
const SELF_SERVICE_SIGNUP_AVAILABLE = isSelfServiceSignupAvailable(process.env.NEXT_PUBLIC_SIGNUP_MODE);

type Step = 'identifier' | 'otp' | 'pin' | 'password';

function LoginError({ message }: { message: string | null }) {
    if (!message) return null;

    return (
        <div className="login-card__error" role="alert" aria-live="assertive" aria-atomic="true">
            {message}
        </div>
    );
}

function LoginContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const prefillIdentifier = searchParams.get('identifier') ?? searchParams.get('email') ?? '';
    const prefillWorkspace = searchParams.get('tenantSlug') ?? searchParams.get('workspace') ?? '';
    const stepParam = searchParams.get('step');
    const errorParam = searchParams.get('error');
    const nextPath = safeInternalNavigationPath(searchParams.get('next'));

    const [step, setStep] = useState<Step>('identifier');
    const [identifier, setIdentifier] = useState('');
    const [workspaceSlug, setWorkspaceSlug] = useState('');
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [otp, setOtp] = useState(['', '', '', '', '', '']);
    const [pin, setPin] = useState('');
    const [password, setPassword] = useState('');
    const [isHydrated, setIsHydrated] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resendCountdown, setResendCountdown] = useState(0);

    const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
    const verifyInFlightRef = useRef(false);

    useEffect(() => {
        setIsHydrated(true);
    }, []);

    useEffect(() => {
        if (prefillIdentifier) {
            const normalized = prefillIdentifier.trim().toLowerCase();
            setIdentifier(normalized);
            if (normalized.includes('@')) {
                setEmail(normalized);
            } else {
                setUsername(normalized);
            }
        }
        const normalizedWorkspace = prefillWorkspace
            ? rememberWorkspaceSlug(window.localStorage, prefillWorkspace)
            : readRememberedWorkspaceSlug(window.localStorage);
        if (normalizedWorkspace) setWorkspaceSlug(normalizedWorkspace);
        if (stepParam === 'otp' || stepParam === 'pin' || stepParam === 'password') setStep(stepParam);
        if (errorParam === 'invalid') {
            if (stepParam === 'pin') {
                setError('Invalid username or PIN. Please try again.');
            } else if (stepParam === 'password') {
                setError('Invalid username or password. Please try again.');
            } else {
                setError('Invalid or expired code. Please try again.');
            }
        }
    }, [prefillIdentifier, prefillWorkspace, stepParam, errorParam]);

    useEffect(() => {
        if (resendCountdown <= 0) return;
        const t = setTimeout(() => setResendCountdown((c) => c - 1), 1000);
        return () => clearTimeout(t);
    }, [resendCountdown]);

    const sendOtpForEmail = async (normalizedEmail: string, normalizedWorkspaceSlug: string) => {
        const res = await fetchPublicApi('/auth/email/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: normalizedEmail, tenantSlug: normalizedWorkspaceSlug }),
            credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error ?? data.message ?? 'Failed to send code. Please try again.');
        }
    };

    const handleContinue = async (e?: React.FormEvent) => {
        e?.preventDefault();
        setError(null);

        const normalizedIdentifier = identifier.trim().toLowerCase();
        const normalizedWorkspaceSlug = normalizeWorkspaceSlug(workspaceSlug);
        if (!normalizedWorkspaceSlug) {
            setError('Enter your workspace slug.');
            return;
        }
        if (!normalizedIdentifier) {
            setError('Enter your work email or username.');
            return;
        }
        setWorkspaceSlug(normalizedWorkspaceSlug);
        rememberWorkspaceSlug(window.localStorage, normalizedWorkspaceSlug);

        setIsLoading(true);
        try {
            const res = await fetchPublicApi('/auth/login/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: normalizedIdentifier, tenantSlug: normalizedWorkspaceSlug }),
                credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setError(data.message ?? data.error ?? 'Unable to continue login.');
                return;
            }

            if (data.flow === 'EMAIL_OTP') {
                await sendOtpForEmail(data.identifier, normalizedWorkspaceSlug);
                setEmail(data.identifier);
                setStep('otp');
                setResendCountdown(60);
                setTimeout(() => otpRefs.current[0]?.focus(), 100);
                return;
            }

            if (data.flow === 'USERNAME_PASSWORD') {
                setUsername(data.identifier);
                setPassword('');
                setStep('password');
                return;
            }

            setUsername(data.identifier);
            setPin('');
            setStep('pin');
            if (data.pinResetRequired) {
                setError('Enter your temporary PIN to set a new PIN.');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleSendOtp = async () => {
        setError(null);
        const normalizedEmail = email.trim().toLowerCase();
        const normalizedWorkspaceSlug = normalizeWorkspaceSlug(workspaceSlug);
        if (!normalizedWorkspaceSlug) {
            setError('Enter your workspace slug.');
            return;
        }
        if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            setError('Enter a valid email address.');
            return;
        }
        setWorkspaceSlug(normalizedWorkspaceSlug);
        rememberWorkspaceSlug(window.localStorage, normalizedWorkspaceSlug);
        setIsLoading(true);
        try {
            await sendOtpForEmail(normalizedEmail, normalizedWorkspaceSlug);
            setResendCountdown(60);
        } catch (err) {
            setError((err as Error).message);
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

    const submitLoginVerification = async (
        endpoint: '/auth/email/verify-otp' | '/auth/pin/verify' | '/auth/password/verify',
        payload: Record<string, string>,
        fallbackError: string,
    ) => {
        if (verifyInFlightRef.current) return;

        const safeNext = safeInternalNavigationPath(nextPath);
        verifyInFlightRef.current = true;
        setIsLoading(true);
        setError(null);

        try {
            const response = await fetchPublicApi(`${endpoint}?next=${encodeURIComponent(safeNext)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = await response.json().catch(() => ({})) as {
                success?: unknown;
                redirectTo?: unknown;
                message?: unknown;
                error?: unknown;
            };
            if (!response.ok || data.success !== true) {
                const message = typeof data.message === 'string'
                    ? data.message
                    : typeof data.error === 'string'
                        ? data.error
                        : fallbackError;
                setError(message);
                return;
            }

            const redirectTo = safeInternalNavigationPath(
                typeof data.redirectTo === 'string' ? data.redirectTo : null,
                safeNext,
            );
            router.push(redirectTo);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to sign in. Please try again.');
        } finally {
            verifyInFlightRef.current = false;
            setIsLoading(false);
        }
    };

    const handleVerifyOtp = async (e?: React.FormEvent) => {
        e?.preventDefault();

        const code = otp.join('');
        if (code.length !== 6) {
            setError('Enter all 6 digits.');
            return;
        }

        await submitLoginVerification('/auth/email/verify-otp', {
            email: email.trim().toLowerCase(),
            tenantSlug: normalizeWorkspaceSlug(workspaceSlug),
            code,
        }, 'Invalid or expired code. Please try again.');
    };

    const handleVerifyPin = async (e?: React.FormEvent) => {
        e?.preventDefault();
        const normalizedPin = pin.replace(/\D/g, '');
        if (normalizedPin.length < 4 || normalizedPin.length > 8) {
            setError('PIN must be 4 to 8 digits.');
            return;
        }

        await submitLoginVerification('/auth/pin/verify', {
            identifier: username.trim().toLowerCase(),
            tenantSlug: normalizeWorkspaceSlug(workspaceSlug),
            pin: normalizedPin,
        }, 'Invalid username or PIN. Please try again.');
    };

    const handleVerifyPassword = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!password) {
            setError('Enter your password.');
            return;
        }

        await submitLoginVerification('/auth/password/verify', {
            identifier: username.trim().toLowerCase(),
            tenantSlug: normalizeWorkspaceSlug(workspaceSlug),
            password,
        }, 'Invalid username or password. Please try again.');
    };

    const handleOidcLogin = () => {
        const normalizedWorkspaceSlug = normalizeWorkspaceSlug(workspaceSlug);
        if (!normalizedWorkspaceSlug) {
            setError('Enter your workspace slug before continuing with SSO.');
            return;
        }
        setWorkspaceSlug(normalizedWorkspaceSlug);
        rememberWorkspaceSlug(window.localStorage, normalizedWorkspaceSlug);
        const params = new URLSearchParams({ tenantSlug: normalizedWorkspaceSlug, next: safeInternalNavigationPath(nextPath) });
        window.location.href = apiPath(`/auth/login?${params.toString()}`);
    };

    if (!isHydrated) return <LoginLoadingFallback />;

    return (
        <main className="login-shell">
            <div className="login-orb login-orb--left" aria-hidden="true" />
            <div className="login-orb login-orb--right" aria-hidden="true" />

            <header className="login-header">
                <Link href="/" className="login-brand">
                    <div className="login-brand__icon"><LunchLineupMark size={34} /></div>
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
                        <h2 className="login-card__title">
                            {step === 'identifier' ? 'Sign in to LunchLineup' : step === 'otp' ? 'Check your email' : step === 'password' ? 'Enter your password' : 'Enter your PIN'}
                        </h2>
                        <p className="login-card__subtitle">
                            {step === 'identifier'
                                ? 'Use your workspace slug plus work email or username.'
                                : step === 'otp'
                                    ? `Enter the 6-digit code sent to ${email}.`
                                    : `Sign in as ${username}.`}
                        </p>

                        {step === 'identifier' ? (
                            <>
                                {OIDC_ENABLED ? (
                                    <button type="button" onClick={handleOidcLogin} className="btn btn-secondary" style={{ width: '100%', marginBottom: '0.65rem' }}>
                                        Continue with SSO / OIDC
                                    </button>
                                ) : null}

                                <form onSubmit={handleContinue} style={{ display: 'grid', gap: '0.62rem' }}>
                                    <label className="form-group">
                                        <span className="form-label">Workspace slug</span>
                                        <input
                                            type="text"
                                            className="form-input"
                                            placeholder="your-workspace"
                                            value={workspaceSlug}
                                            onChange={(e) => setWorkspaceSlug(normalizeWorkspaceSlug(e.target.value))}
                                            autoComplete="organization"
                                            required
                                        />
                                    </label>

                                    <label className="form-group">
                                        <span className="form-label">Work email or username</span>
                                        <input
                                            type="text"
                                            className="form-input"
                                            placeholder="name@company.com or username"
                                            value={identifier}
                                            onChange={(e) => setIdentifier(e.target.value)}
                                            autoComplete="username"
                                            required
                                        />
                                    </label>

                                    <LoginError message={error} />

                                    <button type="submit" className="btn btn-primary" disabled={isLoading} style={{ width: '100%' }}>
                                        {isLoading ? 'Continuing...' : 'Continue'}
                                    </button>

                                    <p className="login-card__trust">Secure sign-in · Email OTP, migrated password, or PIN</p>
                                </form>
                            </>
                        ) : null}

                        {step === 'otp' ? (
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

                                <LoginError message={error} />

                                <button type="submit" className="btn btn-primary" disabled={isLoading || otp.join('').length !== 6} style={{ width: '100%' }}>
                                    {isLoading ? 'Verifying...' : 'Verify and continue'}
                                </button>

                                <p className="login-card__trust">Secure sign-in · One-time code expires quickly</p>

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
                                            setStep('identifier');
                                            setOtp(['', '', '', '', '', '']);
                                            setError(null);
                                            verifyInFlightRef.current = false;
                                            setIsLoading(false);
                                        }}
                                    >
                                        Use different login
                                    </button>
                                </div>
                            </form>
                        ) : null}

                        {step === 'pin' ? (
                            <form onSubmit={handleVerifyPin} style={{ display: 'grid', gap: '0.62rem' }}>
                                <label className="form-group">
                                    <span className="form-label">PIN</span>
                                    <input
                                        type="password"
                                        inputMode="numeric"
                                        className="form-input"
                                        placeholder="Enter 4-8 digit PIN"
                                        value={pin}
                                        onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                                        autoComplete="current-password"
                                        required
                                    />
                                </label>

                                <LoginError message={error} />

                                <button type="submit" className="btn btn-primary" disabled={isLoading || pin.length < 4} style={{ width: '100%' }}>
                                    {isLoading ? 'Signing in...' : 'Sign in with PIN'}
                                </button>

                                <p className="login-card__trust">Need PIN help? Contact your admin for a reset.</p>

                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                        setStep('identifier');
                                        setPin('');
                                        setError(null);
                                        setIsLoading(false);
                                    }}
                                >
                                    Use different login
                                </button>
                            </form>
                        ) : null}

                        {step === 'password' ? (
                            <form onSubmit={handleVerifyPassword} style={{ display: 'grid', gap: '0.62rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Password</span>
                                    <input
                                        type="password"
                                        className="form-input"
                                        placeholder="Enter password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        autoComplete="current-password"
                                        required
                                    />
                                </label>

                                <LoginError message={error} />

                                <button type="submit" className="btn btn-primary" disabled={isLoading || !password} style={{ width: '100%' }}>
                                    {isLoading ? 'Signing in...' : 'Sign in with password'}
                                </button>

                                <p className="login-card__trust">Uses the migrated LunchLineup password hash.</p>

                                <Link
                                    className="btn btn-ghost btn-sm"
                                    href={`/auth/reset-password?identifier=${encodeURIComponent(username)}&tenantSlug=${encodeURIComponent(normalizeWorkspaceSlug(workspaceSlug))}`}
                                >
                                    Forgot password?
                                </Link>

                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                        setStep('identifier');
                                        setPassword('');
                                        setError(null);
                                        setIsLoading(false);
                                    }}
                                >
                                    Use different login
                                </button>
                            </form>
                        ) : null}

                        {SELF_SERVICE_SIGNUP_AVAILABLE ? (
                            <>
                                <div className="divider" style={{ marginTop: '0.9rem', marginBottom: '0.75rem' }} />
                                <div className="login-secondary-cta">
                                    <span>New to LunchLineup?</span>
                                    <Link href="/onboarding">Create your account</Link>
                                </div>
                            </>
                        ) : null}
                    </div>
                </section>
            </div>

            <style>{`
                .login-shell {
                    min-height: 100vh;
                    position: relative;
                    padding: 1.1rem;
                    display: grid;
                    grid-template-rows: auto 1fr;
                    align-content: normal;
                    align-items: stretch;
                    overflow-x: hidden;
                    overflow-y: auto;
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
                    letter-spacing: 0;
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
                    letter-spacing: 0;
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
        </main>
    );
}

function LoginLoadingFallback() {
    return (
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f6f8fc', color: '#12213a' }}>
            <div role="status" aria-live="polite" style={{ display: 'grid', justifyItems: 'center', gap: 12, fontWeight: 800 }}>
                <LunchLineupMark size={42} />
                <span style={{ fontSize: 20 }}>LunchLineup</span>
                <span style={{ color: '#58708f', fontSize: 14 }}>Loading secure sign-in...</span>
            </div>
        </main>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<LoginLoadingFallback />}>
            <LoginContent />
        </Suspense>
    );
}
