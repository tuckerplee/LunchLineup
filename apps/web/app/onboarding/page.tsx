'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const STEPS = [
    { id: 1, label: 'Organization', icon: '🏢' },
    { id: 2, label: 'Location', icon: '📍' },
    { id: 3, label: 'Ready!', icon: '🚀' },
];

export default function OnboardingPage() {
    const router = useRouter();
    const [step, setStep] = useState(1);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [formData, setFormData] = useState({
        tenantName: '',
        firstLocationName: '',
    });

    const validate = () => {
        if (step === 1 && !formData.tenantName.trim()) {
            setError('Organization name is required.');
            return false;
        }
        if (step === 2 && !formData.firstLocationName.trim()) {
            setError('Location name is required.');
            return false;
        }
        return true;
    };

    const nextStep = () => {
        if (!validate()) return;
        setError(null);
        setStep(s => Math.min(s + 1, 3));
    };

    const prevStep = () => {
        setError(null);
        setStep(s => Math.max(s - 1, 1));
    };

    const handleComplete = async () => {
        try {
            setIsSubmitting(true);
            setError(null);

            const res = await fetch('/api/v1/locations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: formData.firstLocationName,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || 'Failed to provision workspace. Please try again.');
            }

            router.push('/dashboard');
            router.refresh();
        } catch (err) {
            setError((err as Error).message);
            setIsSubmitting(false);
            setStep(2);
        }
    };

    return (
        <div style={{
            minHeight: '100vh',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: '2rem', background: 'var(--bg)',
            position: 'relative', overflow: 'hidden',
        }}>
            {/* Background orbs */}
            <div style={{
                position: 'fixed', top: '5%', right: '10%',
                width: 400, height: 400, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(92,124,250,0.1), transparent 70%)',
                pointerEvents: 'none',
            }} />
            <div style={{
                position: 'fixed', bottom: '10%', left: '5%',
                width: 300, height: 300, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(16,185,129,0.08), transparent 70%)',
                pointerEvents: 'none',
            }} />

            {/* Logo */}
            <Link href="/" style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                marginBottom: '2.5rem', position: 'relative', zIndex: 1,
                textDecoration: 'none',
            }}>
                <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: 'linear-gradient(135deg, #5c7cfa, #748ffc)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1rem', boxShadow: '0 4px 16px rgba(92,124,250,0.3)',
                }}>🍱</div>
                <span style={{ fontWeight: 800, fontSize: '1.125rem', color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                    LunchLineup
                </span>
            </Link>

            {/* Step Progress */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: 0,
                marginBottom: '2.5rem', position: 'relative', zIndex: 1,
            }}>
                {STEPS.map((s, i) => (
                    <React.Fragment key={s.id}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.375rem' }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: '50%',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: step > s.id ? '1rem' : '0.875rem',
                                fontWeight: 700,
                                background: step > s.id
                                    ? 'linear-gradient(135deg, #10b981, #6ee7b7)'
                                    : step === s.id
                                        ? 'linear-gradient(135deg, #5c7cfa, #748ffc)'
                                        : 'rgba(255,255,255,0.05)',
                                border: step === s.id
                                    ? '2px solid rgba(92,124,250,0.5)'
                                    : '2px solid rgba(255,255,255,0.08)',
                                boxShadow: step === s.id ? '0 0 20px rgba(92,124,250,0.4)' : 'none',
                                color: step >= s.id ? 'white' : 'var(--text-muted)',
                                transition: 'all 350ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                                animation: step === s.id ? 'pulse-ring 2s ease-out infinite' : 'none',
                            }}>
                                {step > s.id ? '✓' : s.icon}
                            </div>
                            <span style={{
                                fontSize: '0.75rem', fontWeight: step === s.id ? 600 : 400,
                                color: step >= s.id ? 'var(--text-secondary)' : 'var(--text-muted)',
                                transition: 'color 250ms',
                            }}>{s.label}</span>
                        </div>
                        {i < STEPS.length - 1 && (
                            <div style={{
                                width: 64, height: 2, marginBottom: 24,
                                background: step > s.id
                                    ? 'linear-gradient(90deg, #10b981, #5c7cfa)'
                                    : 'rgba(255,255,255,0.08)',
                                transition: 'background 400ms var(--ease-out)',
                            }} />
                        )}
                    </React.Fragment>
                ))}
            </div>

            {/* Card */}
            <div style={{
                width: '100%', maxWidth: 460,
                background: 'rgba(15, 22, 41, 0.7)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 20,
                backdropFilter: 'blur(24px)',
                padding: '2.5rem',
                boxShadow: '0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)',
                position: 'relative', zIndex: 1,
                animation: 'fade-up 400ms cubic-bezier(0.16, 1, 0.3, 1) both',
            }}>
                {/* Error Banner */}
                {error && (
                    <div style={{
                        background: 'rgba(244, 63, 94, 0.12)',
                        border: '1px solid rgba(244, 63, 94, 0.3)',
                        borderRadius: 10, padding: '0.75rem 1rem',
                        marginBottom: '1.5rem',
                        display: 'flex', alignItems: 'center', gap: '0.5rem',
                        animation: 'slide-up 200ms var(--ease-out)',
                    }}>
                        <span style={{ fontSize: '1rem' }}>⚠️</span>
                        <span style={{ color: '#fb7185', fontSize: '0.875rem' }}>{error}</span>
                    </div>
                )}

                {/* Step 1: Organization */}
                {step === 1 && (
                    <div key="step1" style={{ animation: 'fade-up 300ms var(--ease-out)' }}>
                        <h1 style={{ fontSize: '1.625rem', fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--text-primary)', marginBottom: '0.375rem' }}>
                            Name your organization
                        </h1>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', marginBottom: '2rem', lineHeight: 1.6 }}>
                            This is how your team will identify your workspace.
                        </p>
                        <div className="form-group" style={{ marginBottom: '1.75rem' }}>
                            <label className="form-label" htmlFor="tenantName">Organization name</label>
                            <input
                                id="tenantName"
                                type="text"
                                className="form-input"
                                value={formData.tenantName}
                                onChange={e => setFormData({ ...formData, tenantName: e.target.value })}
                                placeholder="e.g. Harbour View Group"
                                autoFocus
                                onKeyDown={e => e.key === 'Enter' && nextStep()}
                            />
                        </div>
                        <button onClick={nextStep} className="btn btn-primary" style={{ width: '100%', padding: '0.875rem', fontSize: '0.9375rem' }}>
                            Continue
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                        </button>
                    </div>
                )}

                {/* Step 2: Location */}
                {step === 2 && (
                    <div key="step2" style={{ animation: 'fade-up 300ms var(--ease-out)' }}>
                        <h1 style={{ fontSize: '1.625rem', fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--text-primary)', marginBottom: '0.375rem' }}>
                            Add your first location
                        </h1>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', marginBottom: '2rem', lineHeight: 1.6 }}>
                            You can add more locations anytime from your dashboard.
                        </p>
                        <div className="form-group" style={{ marginBottom: '1.75rem' }}>
                            <label className="form-label" htmlFor="locationName">Location name</label>
                            <input
                                id="locationName"
                                type="text"
                                className="form-input"
                                value={formData.firstLocationName}
                                onChange={e => setFormData({ ...formData, firstLocationName: e.target.value })}
                                placeholder="e.g. Downtown Bistro"
                                autoFocus
                                onKeyDown={e => e.key === 'Enter' && nextStep()}
                            />
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem' }}>
                            <button onClick={prevStep} className="btn btn-secondary" style={{ padding: '0.875rem 1.25rem' }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M19 12H5M12 19l-7-7 7-7" />
                                </svg>
                                Back
                            </button>
                            <button onClick={nextStep} className="btn btn-primary" style={{ flex: 1, padding: '0.875rem', fontSize: '0.9375rem' }}>
                                Continue
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M5 12h14M12 5l7 7-7 7" />
                                </svg>
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 3: Confirm */}
                {step === 3 && (
                    <div key="step3" style={{ textAlign: 'center', animation: 'scale-in 350ms cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
                        {/* Check icon */}
                        <div style={{
                            width: 72, height: 72, borderRadius: '50%',
                            background: 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05))',
                            border: '2px solid rgba(16,185,129,0.3)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            margin: '0 auto 1.5rem',
                            boxShadow: '0 0 40px rgba(16,185,129,0.2)',
                        }}>
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                        </div>

                        <h1 style={{ fontSize: '1.625rem', fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                            You're all set, {formData.tenantName.split(' ')[0]}!
                        </h1>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', marginBottom: '2rem', lineHeight: 1.6 }}>
                            We'll provision <strong style={{ color: 'var(--text-primary)' }}>{formData.firstLocationName}</strong> and get your workspace ready.
                        </p>

                        {/* Summary Card */}
                        <div style={{
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid rgba(255,255,255,0.06)',
                            borderRadius: 12, padding: '1rem 1.25rem',
                            marginBottom: '1.75rem', textAlign: 'left',
                        }}>
                            {[
                                ['Organization', formData.tenantName, '🏢'],
                                ['First Location', formData.firstLocationName, '📍'],
                                ['Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone, '🕐'],
                            ].map(([label, value, icon]) => (
                                <div key={label} style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '0.5rem 0',
                                    borderBottom: label !== 'Timezone' ? '1px solid rgba(255,255,255,0.05)' : 'none',
                                }}>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{icon} {label}</span>
                                    <span style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 500 }}>{value}</span>
                                </div>
                            ))}
                        </div>

                        <button
                            onClick={handleComplete}
                            disabled={isSubmitting}
                            style={{
                                width: '100%', padding: '0.9375rem',
                                borderRadius: 'var(--radius-md)', border: 'none',
                                background: isSubmitting
                                    ? 'rgba(16, 185, 129, 0.4)'
                                    : 'linear-gradient(135deg, #10b981, #059669)',
                                color: 'white', fontWeight: 700, fontSize: '0.9375rem',
                                fontFamily: 'var(--font-sans)',
                                cursor: isSubmitting ? 'default' : 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.625rem',
                                boxShadow: isSubmitting ? 'none' : '0 4px 24px rgba(16,185,129,0.35)',
                                transition: 'all 250ms var(--ease-out)',
                                marginBottom: '0.875rem',
                            }}
                        >
                            {isSubmitting ? (
                                <>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                    </svg>
                                    Setting up your workspace…
                                </>
                            ) : (
                                <>
                                    Launch Dashboard
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M5 12h14M12 5l7 7-7 7" />
                                    </svg>
                                </>
                            )}
                        </button>
                        <button onClick={prevStep} style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--text-muted)', fontSize: '0.875rem',
                            fontFamily: 'var(--font-sans)', transition: 'color 150ms',
                        }}
                            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                            disabled={isSubmitting}
                        >
                            ← Change something
                        </button>
                    </div>
                )}
            </div>

            {/* Sign-in link */}
            <p style={{ marginTop: '1.5rem', color: 'var(--text-muted)', fontSize: '0.875rem', position: 'relative', zIndex: 1 }}>
                Already have an account?{' '}
                <Link href="/auth/login" style={{ color: 'var(--brand)', fontWeight: 600 }}>
                    Sign in
                </Link>
            </p>

            <style>{`
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                @keyframes fade-up { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes scale-in { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
                @keyframes slide-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes float-slow { 0%, 100% { transform: translate(0,0) scale(1); } 33% { transform: translate(30px,-20px) scale(1.05); } 66% { transform: translate(-15px,15px) scale(0.98); } }
                @keyframes float-med { 0%, 100% { transform: translate(0,0); } 50% { transform: translate(-25px,25px); } }
                @keyframes pulse-ring { 0% { box-shadow: 0 0 0 0 rgba(92,124,250,0.4); } 70% { box-shadow: 0 0 0 10px rgba(92,124,250,0); } 100% { box-shadow: 0 0 0 0 rgba(92,124,250,0); } }
            `}</style>
        </div>
    );
}
