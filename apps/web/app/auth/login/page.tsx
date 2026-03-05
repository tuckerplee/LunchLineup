'use client';

import Link from 'next/link';
import { useState, useRef, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

type Step = 'email' | 'otp';

function LoginContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const nextPath = searchParams.get('next') ?? '/dashboard';

    const [step, setStep] = useState<Step>('email');
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState(['', '', '', '', '', '']);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resendCountdown, setResendCountdown] = useState(0);

    const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

    // Countdown timer for resend
    useEffect(() => {
        if (resendCountdown <= 0) return;
        const t = setTimeout(() => setResendCountdown(c => c - 1), 1000);
        return () => clearTimeout(t);
    }, [resendCountdown]);

    const handleSendOtp = async (e?: React.FormEvent) => {
        e?.preventDefault();
        setError(null);
        setIsLoading(true);
        try {
            const res = await fetch(`${API}/auth/email/send-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setError(data.error ?? 'Failed to send code. Please try again.');
            } else {
                setStep('otp');
                setResendCountdown(60);
                setTimeout(() => otpRefs.current[0]?.focus(), 100);
            }
        } catch {
            setError('Network error. Is the API running?');
        } finally {
            setIsLoading(false);
        }
    };

    const handleOtpInput = (index: number, value: string) => {
        // Accept paste of full code
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

    const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
        if (e.key === 'Backspace' && !otp[index] && index > 0) {
            otpRefs.current[index - 1]?.focus();
        }
    };

    const handleVerifyOtp = async (e?: React.FormEvent) => {
        e?.preventDefault();
        const code = otp.join('');
        if (code.length !== 6) { setError('Enter all 6 digits'); return; }
        setError(null);
        setIsLoading(true);
        try {
            const res = await fetch(`${API}/auth/email/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, code }),
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setError('Invalid or expired code. Please try again.');
                setOtp(['', '', '', '', '', '']);
                otpRefs.current[0]?.focus();
            } else {
                // Use redirectTo from API (role-aware) or fall back to next param
                router.push(data.redirectTo ?? nextPath);
            }
        } catch {
            setError('Network error. Is the API running?');
        } finally {
            setIsLoading(false);
        }
    };

    // Auto-submit when all 6 digits entered
    useEffect(() => {
        if (step === 'otp' && otp.join('').length === 6) {
            handleVerifyOtp();
        }
    }, [otp]);

    const handleOidcLogin = () => {
        setIsLoading(true);
        window.location.href = `${API}/auth/login`;
    };

    return (
        <div className="login-grid" style={{
            minHeight: '100vh', display: 'grid',
            gridTemplateColumns: '1fr 1fr', background: 'var(--bg)',
        }}>
            {/* ── Left: Branding Panel ── */}
            <div className="login-branding" style={{
                position: 'relative', padding: '3rem',
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                background: 'linear-gradient(135deg, rgba(92,124,250,0.08) 0%, rgba(16,185,129,0.04) 100%)',
                borderRight: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden',
            }}>
                <div style={{ position: 'absolute', top: -100, left: -100, width: 400, height: 400, borderRadius: '50%', background: 'radial-gradient(circle, rgba(92,124,250,0.12), transparent 70%)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', bottom: -80, right: -80, width: 320, height: 320, borderRadius: '50%', background: 'radial-gradient(circle, rgba(16,185,129,0.1), transparent 70%)', pointerEvents: 'none' }} />

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', position: 'relative', zIndex: 1 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #5c7cfa, #748ffc)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.125rem', boxShadow: '0 4px 16px rgba(92,124,250,0.4)' }}>🍱</div>
                    <span style={{ fontWeight: 800, fontSize: '1.25rem', color: '#f1f5f9', letterSpacing: '-0.02em' }}>LunchLineup</span>
                </div>

                <div style={{ position: 'relative', zIndex: 1 }}>
                    <h2 style={{ fontSize: 'clamp(2rem, 3vw, 2.75rem)', fontWeight: 900, lineHeight: 1.1, letterSpacing: '-0.03em', color: 'var(--text-primary)', marginBottom: '1.25rem' }}>
                        Schedules that just{' '}
                        <span style={{ background: 'linear-gradient(135deg, #5c7cfa, #10b981)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>work.</span>
                    </h2>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '1.0625rem', lineHeight: 1.65, maxWidth: 400 }}>
                        Real-time collaboration. Automated compliance. AI-powered optimization.
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', marginTop: '2rem' }}>
                        {[['🔒', 'Enterprise-grade security, role-based access'], ['⚡', 'Auto-schedule a full week in under 30 seconds'], ['🌍', 'Multi-location, one unified dashboard']].map(([emoji, text], i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                <span style={{ fontSize: '1.125rem' }}>{emoji}</span>
                                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem' }}>{text}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div style={{ position: 'relative', zIndex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '1.25rem 1.5rem' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '0.875rem', fontStyle: 'italic' }}>
                        "Everything we needed from a scheduling tool, nothing we didn't. Our coverage gaps went to zero."
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                        <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg, #5c7cfa, #10b981)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 700, color: 'white' }}>JL</div>
                        <div>
                            <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: 'var(--text-primary)' }}>Jamie L.</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Director of Ops, Mesa Collective</div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Right: Login Form ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem 2rem', position: 'relative' }}>
                <div style={{ width: '100%', maxWidth: 400, animation: 'fade-up 400ms cubic-bezier(0.16,1,0.3,1) both' }}>
                    {/* Header */}
                    <div style={{ marginBottom: '2rem', textAlign: 'center' }}>
                        <h1 style={{ fontSize: '1.875rem', fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                            {step === 'email' ? 'Welcome back' : 'Check your email'}
                        </h1>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem' }}>
                            {step === 'email'
                                ? 'Sign in to your LunchLineup workspace'
                                : `We sent a 6-digit code to ${email}`}
                        </p>
                    </div>

                    {step === 'email' ? (
                        <>
                            {/* SSO Button */}
                            <button onClick={handleOidcLogin} disabled={isLoading} style={{ width: '100%', padding: '0.875rem 1.5rem', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '0.9375rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', transition: 'all 200ms', marginBottom: '1.25rem' }}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" fill="#5c7cfa" /></svg>
                                Continue with SSO / OIDC
                            </button>

                            <div className="divider-label" style={{ marginBottom: '1.25rem' }}>or sign in with email</div>

                            {/* Email form */}
                            <form onSubmit={handleSendOtp} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                <div className="form-group">
                                    <label className="form-label" htmlFor="email">Work email</label>
                                    <input
                                        id="email" type="email" className="form-input"
                                        placeholder="you@company.com"
                                        value={email} onChange={e => setEmail(e.target.value)}
                                        autoComplete="email" required
                                    />
                                </div>
                                {error && <p style={{ fontSize: '0.875rem', color: '#fb7185', textAlign: 'center' }}>{error}</p>}
                                <button type="submit" className="btn btn-primary" disabled={isLoading} style={{ width: '100%', padding: '0.875rem', fontSize: '0.9375rem' }}>
                                    {isLoading ? (
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                    ) : 'Send login code →'}
                                </button>
                            </form>
                        </>
                    ) : (
                        /* OTP Step */
                        <form onSubmit={handleVerifyOtp} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                            {/* 6 OTP digit boxes */}
                            <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'center' }}>
                                {otp.map((digit, i) => (
                                    <input
                                        key={i}
                                        ref={el => { otpRefs.current[i] = el; }}
                                        type="text" inputMode="numeric" maxLength={6}
                                        value={digit}
                                        onChange={e => handleOtpInput(i, e.target.value)}
                                        onKeyDown={e => handleOtpKeyDown(i, e)}
                                        onPaste={e => {
                                            const text = e.clipboardData.getData('text');
                                            if (/^\d{6}$/.test(text)) {
                                                e.preventDefault();
                                                handleOtpInput(0, text);
                                            }
                                        }}
                                        style={{
                                            width: 48, height: 56, textAlign: 'center',
                                            fontSize: '1.5rem', fontWeight: 700, letterSpacing: 0,
                                            background: 'rgba(255,255,255,0.04)',
                                            border: digit ? '1px solid var(--brand)' : '1px solid rgba(255,255,255,0.12)',
                                            borderRadius: 10, color: digit ? 'var(--brand-bright)' : 'var(--text-primary)',
                                            outline: 'none', transition: 'all 150ms',
                                            fontFamily: 'var(--font-sans)',
                                            caretColor: 'transparent',
                                        }}
                                    />
                                ))}
                            </div>

                            {error && <p style={{ fontSize: '0.875rem', color: '#fb7185', textAlign: 'center', margin: 0 }}>{error}</p>}

                            <button type="submit" className="btn btn-primary" disabled={isLoading || otp.join('').length !== 6} style={{ width: '100%', padding: '0.875rem', fontSize: '0.9375rem' }}>
                                {isLoading ? (
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                ) : 'Verify code'}
                            </button>

                            <div style={{ textAlign: 'center' }}>
                                {resendCountdown > 0 ? (
                                    <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Resend in {resendCountdown}s</span>
                                ) : (
                                    <button type="button" onClick={() => handleSendOtp()} style={{ background: 'none', border: 'none', color: 'var(--brand)', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                                        Resend code
                                    </button>
                                )}
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}> · </span>
                                <button type="button" onClick={() => { setStep('email'); setOtp(['', '', '', '', '', '']); setError(null); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.875rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                                    Change email
                                </button>
                            </div>
                        </form>
                    )}

                    <p style={{ marginTop: '1.75rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                        Don't have an account?{' '}
                        <Link href="/onboarding" style={{ color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>Create one free</Link>
                    </p>

                    <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '2.5rem', paddingTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                        {['🔒 SOC 2 Type II', '🌐 GDPR compliant', '⚡ 99.9% uptime'].map((t, i) => (
                            <span key={i} style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t}</span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid rgba(92,124,250,0.3)', borderTopColor: '#748ffc', animation: 'spin 0.8s linear infinite' }} />
            </div>
        }>
            <LoginContent />
        </Suspense>
    );
}

