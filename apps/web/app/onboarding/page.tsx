'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const API = '/api/v1';

const STEPS = [
    { id: 1, label: 'Account', icon: '✉️' },
    { id: 2, label: 'Organization', icon: '🏢' },
    { id: 3, label: 'Location', icon: '📍' },
    { id: 4, label: 'Verify', icon: '🔐' },
];

function getCsrfTokenFromCookie(): string {
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}

function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function OnboardingPage() {
    const router = useRouter();
    const [step, setStep] = useState(1);
    const [isSendingOtp, setIsSendingOtp] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [resendCountdown, setResendCountdown] = useState(0);
    const [otpSent, setOtpSent] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [formData, setFormData] = useState({
        email: '',
        tenantName: '',
        firstLocationName: '',
    });
    const [otp, setOtp] = useState('');

    useEffect(() => {
        if (resendCountdown <= 0) return;
        const t = setTimeout(() => setResendCountdown((c) => c - 1), 1000);
        return () => clearTimeout(t);
    }, [resendCountdown]);

    const sendOtp = async () => {
        setIsSendingOtp(true);
        setError(null);
        try {
            const res = await fetch(`${API}/auth/email/send-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ email: formData.email.trim().toLowerCase() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Failed to send verification code.');
            }
            setOtpSent(true);
            setResendCountdown(60);
            return true;
        } catch (err) {
            setError((err as Error).message);
            return false;
        } finally {
            setIsSendingOtp(false);
        }
    };

    useEffect(() => {
        if (step === 4 && !otpSent && isValidEmail(formData.email.trim())) {
            void sendOtp();
        }
    }, [step, otpSent, formData.email]);

    const nextStep = () => {
        setError(null);

        if (step === 1 && !isValidEmail(formData.email.trim())) {
            setError('Please enter a valid email address.');
            return;
        }
        if (step === 2 && !formData.tenantName.trim()) {
            setError('Organization name is required.');
            return;
        }
        if (step === 3 && !formData.firstLocationName.trim()) {
            setError('Location name is required.');
            return;
        }

        setStep((s) => Math.min(s + 1, 4));
    };

    const prevStep = () => {
        setError(null);
        setStep((s) => Math.max(s - 1, 1));
    };

    const handleComplete = async () => {
        const cleanOtp = otp.trim();
        if (!/^\d{6}$/.test(cleanOtp)) {
            setError('Enter a valid 6-digit code.');
            return;
        }

        try {
            setIsSubmitting(true);
            setError(null);

            const verifyRes = await fetch(`${API}/auth/email/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    email: formData.email.trim().toLowerCase(),
                    code: cleanOtp,
                }),
            });
            const verifyData = await verifyRes.json().catch(() => ({}));
            if (!verifyRes.ok || !verifyData.success) {
                throw new Error(verifyData.message || verifyData.error || 'Invalid or expired verification code.');
            }

            const csrfToken = getCsrfTokenFromCookie();
            const provisionRes = await fetch(`${API}/locations`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
                },
                credentials: 'include',
                body: JSON.stringify({
                    name: formData.firstLocationName,
                    tenantName: formData.tenantName,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                }),
            });
            if (!provisionRes.ok) {
                const data = await provisionRes.json().catch(() => ({}));
                throw new Error(data.message || 'Failed to provision workspace. Please try again.');
            }

            router.push('/dashboard');
            router.refresh();
        } catch (err) {
            setError((err as Error).message);
            setIsSubmitting(false);
        }
    };

    return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '1rem' }}>
            <div className="surface-card" style={{ width: '100%', maxWidth: 760, padding: '1.2rem' }}>
                <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
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

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                    {STEPS.map((s, i) => (
                        <React.Fragment key={s.id}>
                            <div
                                className="surface-muted"
                                style={{
                                    padding: '0.35rem 0.55rem',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.35rem',
                                    borderColor: step >= s.id ? '#c9d9ff' : 'var(--border)',
                                    background: step >= s.id ? '#edf3ff' : '#f8faff',
                                }}
                            >
                                <span>{step > s.id ? '✓' : s.icon}</span>
                                <span style={{ fontSize: '0.74rem', color: step >= s.id ? '#2f63ff' : 'var(--text-muted)', fontWeight: 700 }}>{s.label}</span>
                            </div>
                            {i < STEPS.length - 1 ? <span style={{ color: 'var(--text-muted)' }}>→</span> : null}
                        </React.Fragment>
                    ))}
                </div>

                {error ? (
                    <div style={{ marginBottom: '0.8rem', padding: '0.6rem 0.7rem', borderRadius: 10, border: '1px solid #ffd0da', background: '#fff1f4', color: '#cb3653', fontSize: '0.82rem', fontWeight: 600 }}>
                        {error}
                    </div>
                ) : null}

                {step === 1 && (
                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                        <h1 style={{ fontSize: '1.45rem', color: 'var(--text-primary)' }}>Create your account</h1>
                        <p className="workspace-subtitle">Enter your email to start signup.</p>
                        <label className="form-group">
                            <span className="form-label">Email</span>
                            <input className="form-input" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} placeholder="you@company.com" autoComplete="email" autoFocus />
                        </label>
                        <button onClick={nextStep} className="btn btn-primary" style={{ width: '100%' }}>
                            Continue
                        </button>
                    </div>
                )}

                {step === 2 && (
                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                        <h1 style={{ fontSize: '1.45rem', color: 'var(--text-primary)' }}>Name your organization</h1>
                        <p className="workspace-subtitle">Set your workspace name.</p>
                        <label className="form-group">
                            <span className="form-label">Organization name</span>
                            <input className="form-input" value={formData.tenantName} onChange={(e) => setFormData({ ...formData, tenantName: e.target.value })} placeholder="e.g. Harbor View Group" autoFocus />
                        </label>
                        <div style={{ display: 'flex', gap: '0.55rem' }}>
                            <button onClick={prevStep} className="btn btn-secondary" style={{ minWidth: 120 }}>
                                Back
                            </button>
                            <button onClick={nextStep} className="btn btn-primary" style={{ flex: 1 }}>
                                Continue
                            </button>
                        </div>
                    </div>
                )}

                {step === 3 && (
                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                        <h1 style={{ fontSize: '1.45rem', color: 'var(--text-primary)' }}>Add your first location</h1>
                        <p className="workspace-subtitle">You can add more later.</p>
                        <label className="form-group">
                            <span className="form-label">Location name</span>
                            <input className="form-input" value={formData.firstLocationName} onChange={(e) => setFormData({ ...formData, firstLocationName: e.target.value })} placeholder="e.g. Downtown Bistro" autoFocus />
                        </label>
                        <div style={{ display: 'flex', gap: '0.55rem' }}>
                            <button onClick={prevStep} className="btn btn-secondary" style={{ minWidth: 120 }}>
                                Back
                            </button>
                            <button onClick={nextStep} className="btn btn-primary" style={{ flex: 1 }}>
                                Continue
                            </button>
                        </div>
                    </div>
                )}

                {step === 4 && (
                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                        <h1 style={{ fontSize: '1.45rem', color: 'var(--text-primary)' }}>Verify and launch</h1>
                        <p className="workspace-subtitle">Enter the 6-digit code sent to {formData.email}.</p>

                        <div className="surface-muted" style={{ padding: '0.7rem' }}>
                            <div style={{ fontSize: '0.8rem', marginBottom: 4 }}><strong>Email:</strong> {formData.email}</div>
                            <div style={{ fontSize: '0.8rem', marginBottom: 4 }}><strong>Organization:</strong> {formData.tenantName}</div>
                            <div style={{ fontSize: '0.8rem', marginBottom: 4 }}><strong>Location:</strong> {formData.firstLocationName}</div>
                            <div style={{ fontSize: '0.8rem' }}><strong>Timezone:</strong> {Intl.DateTimeFormat().resolvedOptions().timeZone}</div>
                        </div>

                        <label className="form-group">
                            <span className="form-label">Verification code</span>
                            <input className="form-input" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" inputMode="numeric" autoFocus />
                        </label>

                        <div style={{ display: 'flex', gap: '0.55rem' }}>
                            <button onClick={prevStep} className="btn btn-secondary" style={{ minWidth: 120 }} disabled={isSubmitting}>
                                Back
                            </button>
                            <button onClick={handleComplete} className="btn btn-primary" style={{ flex: 1 }} disabled={isSubmitting}>
                                {isSubmitting ? 'Finalizing...' : 'Verify code and launch'}
                            </button>
                        </div>

                        <button type="button" onClick={() => { void sendOtp(); }} disabled={isSendingOtp || resendCountdown > 0 || isSubmitting} className="btn btn-ghost btn-sm" style={{ width: 'fit-content' }}>
                            {isSendingOtp ? 'Sending...' : resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
                        </button>
                    </div>
                )}
            </div>

            <p style={{ marginTop: '0.75rem', color: 'var(--text-muted)', fontSize: '0.86rem' }}>
                Already have an account?{' '}
                <Link href="/auth/login" style={{ color: 'var(--brand)', fontWeight: 700 }}>
                    Sign in
                </Link>
            </p>
        </div>
    );
}
