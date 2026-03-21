'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';

const API = '/api/v1';

const STEPS = [
    { id: 1, label: 'Account' },
    { id: 2, label: 'Organization' },
    { id: 3, label: 'Location' },
    { id: 4, label: 'Verify' },
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
        <div className="onb-shell">
            <div className="onb-orb onb-orb--left" aria-hidden="true" />
            <div className="onb-orb onb-orb--right" aria-hidden="true" />

            <header className="onb-header">
                <Link href="/" className="onb-brand">
                    <div className="onb-brand__icon"><LunchLineupMark size={40} /></div>
                    <div className="onb-brand__wordmark">LunchLineup</div>
                </Link>
            </header>

            <div className="onb-layout">
                <aside className="onb-context">
                    <h1 className="onb-context__title">Break-aware scheduling for modern teams.</h1>
                    <p className="onb-context__copy">
                        LunchLineup automatically builds schedules with lunches, breaks, and coverage already placed.
                    </p>
                    <ul className="onb-context__list">
                        <li>Break compliance built in</li>
                        <li>Coverage protection</li>
                        <li>Publish-ready schedules before manager edits</li>
                    </ul>
                    <div className="onb-preview" aria-hidden="true">
                        <div className="onb-preview__chrome">
                            <div className="onb-preview__dots">
                                <span />
                                <span />
                                <span />
                            </div>
                            <div className="onb-preview__tab">Auto-built schedule preview</div>
                        </div>

                        <div className="onb-preview__body">
                            <div className="onb-preview__toolbar">
                                <div>
                                    <div className="onb-preview__title">Frontline lunch schedule</div>
                                    <div className="onb-preview__meta">Drag break cards to rebalance coverage</div>
                                </div>
                                <div className="onb-preview__coverage">
                                    <span>Coverage</span>
                                    <strong>84%</strong>
                                    <div className="onb-preview__bar">
                                        <div className="onb-preview__fill" />
                                    </div>
                                </div>
                            </div>

                            <div className="onb-preview__legend">
                                <span><i className="onb-dot onb-dot--shift" /> Shift</span>
                                <span><i className="onb-dot onb-dot--lunch" /> Lunch</span>
                                <span><i className="onb-dot onb-dot--break" /> Break</span>
                            </div>

                            <div className="onb-preview__timeline">
                                <div className="onb-preview__ticks">
                                    <span>11:00</span>
                                    <span>12:00</span>
                                    <span>1:00</span>
                                    <span>2:00</span>
                                </div>

                                <div className="onb-lane">
                                    <div className="onb-lane__name">Alex R.</div>
                                    <div className="onb-lane__blocks">
                                        <span className="onb-block onb-block--shift">Shift</span>
                                        <span className="onb-block onb-block--lunch">Lunch 12:10</span>
                                        <span className="onb-block onb-block--break">Break 2:35</span>
                                    </div>
                                </div>

                                <div className="onb-lane">
                                    <div className="onb-lane__name">Casey P.</div>
                                    <div className="onb-lane__blocks">
                                        <span className="onb-block onb-block--shift">Shift</span>
                                        <span className="onb-block onb-block--warn">Lunch overdue</span>
                                        <span className="onb-block onb-block--break">Break 3:10</span>
                                    </div>
                                </div>
                            </div>

                            <div className="onb-preview__alert">1 compliance warning · Floor coverage remains above 3 staff</div>
                        </div>
                    </div>
                </aside>

                <section className="onb-auth">
                    <div className="surface-card onb-card">
                        <div className="onb-steps" role="list" aria-label="Onboarding progress">
                            {STEPS.map((s) => (
                                <React.Fragment key={s.id}>
                                    <div className={`onb-step${step === s.id ? ' onb-step--active' : ''}${step > s.id ? ' onb-step--done' : ''}`} role="listitem">
                                        <span className="onb-step__num">{step > s.id ? '✓' : s.id}</span>
                                        <span className="onb-step__label">{s.label}</span>
                                    </div>
                                </React.Fragment>
                            ))}
                        </div>

                        {error ? (
                            <div className="onb-card__error">{error}</div>
                        ) : null}

                        {step === 1 && (
                            <div style={{ display: 'grid', gap: '0.65rem' }}>
                                <h2 className="onb-card__title">Start your LunchLineup workspace</h2>
                                <p className="onb-card__subtitle">Create your account in under a minute.</p>
                                <label className="form-group">
                                    <span className="form-label">Work email</span>
                                    <input className="form-input" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} placeholder="name@company.com" autoComplete="email" autoFocus />
                                </label>
                                <button onClick={nextStep} className="btn onb-btn-primary" style={{ width: '100%' }}>
                                    Continue setup
                                </button>
                                <p className="onb-card__trust">Secure email verification · No passwords required</p>
                            </div>
                        )}

                        {step === 2 && (
                            <div style={{ display: 'grid', gap: '0.65rem' }}>
                                <h2 className="onb-card__title">Name your organization</h2>
                                <p className="onb-card__subtitle">Set your workspace name.</p>
                                <label className="form-group">
                                    <span className="form-label">Organization name</span>
                                    <input className="form-input" value={formData.tenantName} onChange={(e) => setFormData({ ...formData, tenantName: e.target.value })} placeholder="e.g. Harbor View Group" autoFocus />
                                </label>
                                <div style={{ display: 'flex', gap: '0.55rem' }}>
                                    <button onClick={prevStep} className="btn btn-secondary" style={{ minWidth: 120 }}>
                                        Back
                                    </button>
                                    <button onClick={nextStep} className="btn onb-btn-primary" style={{ flex: 1 }}>
                                        Continue
                                    </button>
                                </div>
                            </div>
                        )}

                        {step === 3 && (
                            <div style={{ display: 'grid', gap: '0.65rem' }}>
                                <h2 className="onb-card__title">Add your first location</h2>
                                <p className="onb-card__subtitle">You can add more later.</p>
                                <label className="form-group">
                                    <span className="form-label">Location name</span>
                                    <input className="form-input" value={formData.firstLocationName} onChange={(e) => setFormData({ ...formData, firstLocationName: e.target.value })} placeholder="e.g. Downtown Bistro" autoFocus />
                                </label>
                                <div style={{ display: 'flex', gap: '0.55rem' }}>
                                    <button onClick={prevStep} className="btn btn-secondary" style={{ minWidth: 120 }}>
                                        Back
                                    </button>
                                    <button onClick={nextStep} className="btn onb-btn-primary" style={{ flex: 1 }}>
                                        Continue
                                    </button>
                                </div>
                            </div>
                        )}

                        {step === 4 && (
                            <div style={{ display: 'grid', gap: '0.65rem' }}>
                                <h2 className="onb-card__title">Verify and launch</h2>
                                <p className="onb-card__subtitle">Enter the 6-digit code sent to {formData.email}.</p>

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
                                    <button onClick={handleComplete} className="btn onb-btn-primary" style={{ flex: 1 }} disabled={isSubmitting}>
                                        {isSubmitting ? 'Finalizing...' : 'Verify code and launch'}
                                    </button>
                                </div>

                                <button type="button" onClick={() => { void sendOtp(); }} disabled={isSendingOtp || resendCountdown > 0 || isSubmitting} className="btn btn-ghost btn-sm" style={{ width: 'fit-content' }}>
                                    {isSendingOtp ? 'Sending...' : resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
                                </button>
                            </div>
                        )}

                        <div className="onb-divider" />
                        <div className="onb-secondary-cta">
                            <span>Already have an account?</span>
                            <Link href="/auth/login">Sign in</Link>
                        </div>
                    </div>
                </section>
            </div>

            <style jsx>{`
                .onb-shell {
                    min-height: 100vh;
                    position: relative;
                    padding: 1.1rem;
                    display: grid;
                    grid-template-rows: auto 1fr;
                    align-content: normal;
                    align-items: stretch;
                    overflow: hidden;
                }

                .onb-header {
                    position: relative;
                    z-index: 2;
                    padding-left: 0.45rem;
                    padding-top: 0.25rem;
                }

                .onb-brand {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.66rem;
                    padding: 0.52rem 0.34rem;
                }

                .onb-brand__icon {
                    width: 40px;
                    height: 40px;
                    display: grid;
                    place-items: center;
                }

                .onb-brand__wordmark {
                    font-weight: 800;
                    font-size: 1.07rem;
                    color: var(--text-primary);
                    line-height: 1;
                }

                .onb-layout {
                    width: min(1140px, 100%);
                    margin: 0 auto;
                    display: grid;
                    grid-template-columns: 1.1fr minmax(340px, 440px);
                    align-items: center;
                    align-self: center;
                    gap: 2.2rem;
                    position: relative;
                    z-index: 1;
                }

                .onb-context {
                    display: grid;
                    align-content: start;
                    gap: 0.34rem;
                }

                .onb-context__title {
                    font-size: clamp(2rem, 5vw, 3.25rem);
                    line-height: 1.02;
                    letter-spacing: -0.035em;
                    color: var(--text-primary);
                    margin-bottom: 0.06rem;
                    max-width: 16ch;
                }

                .onb-context__copy {
                    color: var(--text-secondary);
                    font-size: 1rem;
                    max-width: 44ch;
                    margin-bottom: 0.04rem;
                }

                .onb-context__list {
                    list-style: none;
                    display: grid;
                    gap: 0.28rem;
                    color: var(--text-primary);
                    font-weight: 600;
                    font-size: 0.9rem;
                    margin: 0;
                }

                .onb-context__list li::before {
                    content: '•';
                    color: var(--brand);
                    margin-right: 0.4rem;
                }

                .onb-preview {
                    margin-top: 0;
                    border: 1px solid var(--border);
                    border-radius: 14px;
                    overflow: hidden;
                    max-width: 420px;
                    box-shadow: 0 8px 24px rgba(31, 42, 68, 0.08);
                    background:
                        radial-gradient(22rem 11rem at 100% 0%, rgba(79, 121, 255, 0.1), transparent 70%),
                        #ffffff;
                }

                .onb-preview__chrome {
                    display: flex;
                    align-items: center;
                    gap: 0.45rem;
                    padding: 0.46rem 0.6rem;
                    border-bottom: 1px solid #e8edf8;
                    background: #f7faff;
                }

                .onb-preview__dots {
                    display: inline-flex;
                    gap: 0.22rem;
                }

                .onb-preview__dots span {
                    width: 6px;
                    height: 6px;
                    border-radius: 999px;
                }

                .onb-preview__dots span:nth-child(1) { background: #ff8fa4; }
                .onb-preview__dots span:nth-child(2) { background: #ffd480; }
                .onb-preview__dots span:nth-child(3) { background: #8de8b8; }

                .onb-preview__tab {
                    font-size: 0.66rem;
                    font-weight: 700;
                    color: #5b6f95;
                    letter-spacing: 0.01em;
                }

                .onb-preview__body {
                    padding: 0.6rem;
                    display: grid;
                    gap: 0.46rem;
                }

                .onb-preview__toolbar {
                    display: flex;
                    justify-content: space-between;
                    gap: 0.6rem;
                    align-items: start;
                }

                .onb-preview__title {
                    font-size: 0.74rem;
                    font-weight: 750;
                    color: #253861;
                }

                .onb-preview__meta {
                    font-size: 0.65rem;
                    color: #6f83a8;
                }

                .onb-preview__coverage {
                    min-width: 85px;
                    display: grid;
                    gap: 0.08rem;
                    font-size: 0.62rem;
                    color: #6f83a8;
                }

                .onb-preview__coverage strong {
                    color: #17b26a;
                    font-size: 0.72rem;
                }

                .onb-preview__bar {
                    height: 4px;
                    border-radius: 999px;
                    background: #d8e0f0;
                    overflow: hidden;
                }

                .onb-preview__fill {
                    width: 84%;
                    height: 100%;
                    background: linear-gradient(90deg, #17b26a, #1ec989);
                }

                .onb-preview__legend {
                    display: flex;
                    gap: 0.42rem;
                    flex-wrap: wrap;
                    font-size: 0.62rem;
                    color: #6f83a8;
                }

                .onb-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 999px;
                    display: inline-block;
                    margin-right: 0.22rem;
                }

                .onb-dot--shift { background: #4f79ff; }
                .onb-dot--lunch { background: #6ac79a; }
                .onb-dot--break { background: #22b8cf; }

                .onb-preview__timeline {
                    border: 1px solid #e8edf8;
                    border-radius: 10px;
                    padding: 0.35rem;
                    background: #fbfdff;
                    display: grid;
                    gap: 0.3rem;
                }

                .onb-preview__ticks {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    font-size: 0.58rem;
                    color: #8393b0;
                    padding: 0 0.15rem;
                }

                .onb-lane {
                    display: grid;
                    grid-template-columns: 48px 1fr;
                    gap: 0.28rem;
                    align-items: center;
                }

                .onb-lane__name {
                    font-size: 0.6rem;
                    color: #5f7398;
                    font-weight: 700;
                }

                .onb-lane__blocks {
                    display: flex;
                    gap: 0.2rem;
                    min-width: 0;
                }

                .onb-block {
                    border-radius: 6px;
                    padding: 0.16rem 0.3rem;
                    font-size: 0.56rem;
                    font-weight: 750;
                    white-space: nowrap;
                }

                .onb-block--shift {
                    background: rgba(79, 121, 255, 0.14);
                    color: #2b57d8;
                }

                .onb-block--lunch {
                    background: rgba(106, 199, 154, 0.2);
                    color: #1c7f54;
                }

                .onb-block--break {
                    background: rgba(34, 184, 207, 0.16);
                    color: #187f92;
                }

                .onb-block--warn {
                    background: rgba(255, 188, 77, 0.22);
                    color: #975c00;
                }

                .onb-preview__alert {
                    border: 1px solid #f3d9a7;
                    background: #fff8ea;
                    color: #8f5a00;
                    border-radius: 8px;
                    padding: 0.25rem 0.34rem;
                    font-size: 0.6rem;
                    font-weight: 700;
                }

                .onb-card {
                    width: 100%;
                    max-width: 440px;
                    padding: 1.2rem;
                    border-radius: var(--radius-xl);
                    background:
                        radial-gradient(24rem 16rem at 0% 0%, rgba(79, 121, 255, 0.14), transparent 68%),
                        radial-gradient(22rem 13rem at 100% 100%, rgba(34, 184, 207, 0.1), transparent 66%),
                        #ffffff;
                }

                .onb-steps {
                    display: grid;
                    grid-template-columns: repeat(4, minmax(0, 1fr));
                    gap: 0.35rem;
                    margin-bottom: 0.9rem;
                }

                .onb-step {
                    border: 1px solid #e9eff9;
                    border-radius: 10px;
                    padding: 0.35rem;
                    display: grid;
                    justify-items: center;
                    gap: 0.2rem;
                    background: #f8faff;
                    cursor: default;
                    user-select: none;
                    pointer-events: none;
                }

                .onb-step--active,
                .onb-step--done {
                    border-color: #d8e4fb;
                    background: #f2f6ff;
                }

                .onb-step__num {
                    width: 20px;
                    height: 20px;
                    border-radius: 999px;
                    display: grid;
                    place-items: center;
                    font-size: 0.72rem;
                    font-weight: 800;
                    color: var(--text-muted);
                    border: 1px solid var(--border);
                    background: #fff;
                }

                .onb-step--active .onb-step__num,
                .onb-step--done .onb-step__num {
                    border-color: #2f63ff;
                    color: #2f63ff;
                }

                .onb-step__label {
                    font-size: 0.7rem;
                    font-weight: 700;
                    color: var(--text-muted);
                }

                .onb-step--active .onb-step__label,
                .onb-step--done .onb-step__label {
                    color: #456fcf;
                }

                .onb-card__title {
                    font-size: 1.32rem;
                    color: var(--text-primary);
                    margin-bottom: 0.18rem;
                    letter-spacing: -0.02em;
                }

                .onb-card__subtitle {
                    color: var(--text-secondary);
                    margin-bottom: 0.9rem;
                    font-size: 0.93rem;
                }

                .onb-card__trust {
                    text-align: center;
                    font-size: 0.76rem;
                    color: var(--text-muted);
                    margin-top: 0.1rem;
                }

                .onb-btn-primary {
                    color: #ffffff;
                    min-height: 42px;
                    background: linear-gradient(135deg, #4a78f6, #3f6ee8 62%, #3e8bcf 130%);
                    box-shadow: 0 8px 20px rgba(47, 99, 255, 0.24);
                }

                .onb-btn-primary:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 11px 24px rgba(47, 99, 255, 0.26);
                }

                .onb-card__error {
                    margin-bottom: 0.8rem;
                    padding: 0.6rem 0.7rem;
                    border-radius: 10px;
                    border: 1px solid #ffd0da;
                    background: #fff1f4;
                    color: #cb3653;
                    font-size: 0.82rem;
                    font-weight: 600;
                }

                .onb-secondary-cta {
                    display: grid;
                    justify-items: center;
                    gap: 0.1rem;
                    padding-top: 0.28rem;
                    color: var(--text-secondary);
                    font-size: 0.88rem;
                }

                .onb-divider {
                    margin-top: 1.1rem;
                    margin-bottom: 0.95rem;
                    border-top: 1px solid rgba(184, 199, 226, 0.34);
                }

                .onb-secondary-cta a {
                    color: var(--brand);
                    font-weight: 700;
                }

                .onb-orb {
                    position: absolute;
                    border-radius: 999px;
                    filter: blur(20px);
                    opacity: 0.5;
                    pointer-events: none;
                }

                .onb-orb--left {
                    width: 400px;
                    height: 400px;
                    left: -160px;
                    top: -160px;
                    background: radial-gradient(circle at center, rgba(79, 121, 255, 0.28), transparent 68%);
                }

                .onb-orb--right {
                    width: 440px;
                    height: 440px;
                    right: -180px;
                    bottom: -200px;
                    background: radial-gradient(circle at center, rgba(34, 184, 207, 0.24), transparent 66%);
                }

                @media (max-width: 980px) {
                    .onb-layout {
                        grid-template-columns: 1fr;
                        gap: 1.25rem;
                        align-content: start;
                        margin-top: 0.55rem;
                    }

                    .onb-context {
                        order: 1;
                    }

                    .onb-context__title {
                        font-size: clamp(1.7rem, 8vw, 2.2rem);
                        max-width: none;
                    }

                    .onb-auth {
                        order: 2;
                    }

                    .onb-card {
                        max-width: none;
                    }
                }
            `}</style>
        </div>
    );
}
