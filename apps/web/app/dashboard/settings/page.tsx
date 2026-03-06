'use client';

import { useEffect, useState } from 'react';
import { fetchJsonWithSession } from '@/lib/client-api';

const TABS = ['General', 'Team', 'Billing', 'Security'] as const;
type Tab = typeof TABS[number];

type FeatureMatrixResponse = {
    usageCredits?: number;
};

export default function SettingsPage() {
    // NOTE: requireRole is called server-side in middleware.ts for /dashboard/settings
    // This page is client-side for tab interactivity, but is only reachable by ADMIN+
    const [activeTab, setActiveTab] = useState<Tab>('General');
    const [usageCredits, setUsageCredits] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        const loadCredits = async () => {
            try {
                const payload = await fetchJsonWithSession<FeatureMatrixResponse>('/billing/features');
                if (cancelled) return;
                setUsageCredits(typeof payload.usageCredits === 'number' ? payload.usageCredits : 0);
            } catch {
                if (!cancelled) setUsageCredits(0);
            }
        };

        void loadCredits();
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 860 }}>
            <div>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>Settings</h1>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Downtown Bistro · Organization settings</p>
            </div>

            {/* Tab bar */}
            <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--border)', paddingBottom: -1 }}>
                {TABS.map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        style={{
                            padding: '0.5rem 1rem', background: 'none', border: 'none',
                            borderBottom: activeTab === tab ? '2px solid var(--brand)' : '2px solid transparent',
                            cursor: 'pointer', fontFamily: 'var(--font-sans)',
                            fontSize: '0.875rem', fontWeight: activeTab === tab ? 600 : 400,
                            color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-muted)',
                            transition: 'all 150ms', marginBottom: -1,
                        }}
                    >
                        {tab}
                    </button>
                ))}
            </div>

            {/* Tab content */}
            <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border)', borderRadius: 14, padding: '1.75rem' }}>
                {activeTab === 'General' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                        <h2 style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)', marginBottom: '0.25rem' }}>Organization</h2>
                        {[
                            { label: 'Organization Name', value: 'Downtown Bistro', type: 'text' },
                            { label: 'Slug / Subdomain', value: 'downtown-bistro', type: 'text' },
                        ].map(f => (
                            <div key={f.label}>
                                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}>{f.label}</label>
                                <input defaultValue={f.value} style={{ width: '100%', padding: '0.5625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.875rem', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                            </div>
                        ))}
                        <div>
                            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}>Timezone</label>
                            <select style={{ width: '100%', padding: '0.5625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.875rem', fontFamily: 'inherit' }}>
                                <option value="America/Los_Angeles" style={{ background: '#1e1e2a' }}>Pacific Time (US & Canada)</option>
                                <option value="America/Chicago" style={{ background: '#1e1e2a' }}>Central Time (US & Canada)</option>
                                <option value="America/New_York" style={{ background: '#1e1e2a' }}>Eastern Time (US & Canada)</option>
                            </select>
                        </div>
                        <div style={{ paddingTop: '0.5rem' }}>
                            <button style={{ padding: '0.5625rem 1.25rem', borderRadius: 8, background: 'linear-gradient(135deg, #5c7cfa, #748ffc)', color: 'white', border: 'none', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                                Save Changes
                            </button>
                        </div>
                    </div>
                )}

                {activeTab === 'Team' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                        <h2 style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>Team Defaults</h2>
                        <div>
                            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}>Default role for new invites</label>
                            <select style={{ width: '100%', padding: '0.5625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.875rem', fontFamily: 'inherit' }}>
                                <option value="STAFF" style={{ background: '#1e1e2a' }}>Staff</option>
                                <option value="MANAGER" style={{ background: '#1e1e2a' }}>Manager</option>
                            </select>
                        </div>
                        <div>
                            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Shift approval policy</label>
                            {['Auto-approve all shifts', 'Require manager approval', 'Require admin approval'].map(opt => (
                                <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.5rem', cursor: 'pointer' }}>
                                    <input type="radio" name="approval" defaultChecked={opt === 'Require manager approval'} />
                                    <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{opt}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                )}

                {activeTab === 'Billing' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                        <h2 style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>Billing</h2>
                        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: 200, padding: '1.25rem', background: 'rgba(92,124,250,0.08)', border: '1px solid rgba(92,124,250,0.2)', borderRadius: 12 }}>
                                <div style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#748ffc', marginBottom: '0.5rem' }}>Current Plan</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>Starter</div>
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Up to 15 staff · 2 locations</div>
                            </div>
                            <div style={{ flex: 1, minWidth: 200, padding: '1.25rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 12 }}>
                                <div style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#fbbf24', marginBottom: '0.5rem' }}>Usage Credits</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fbbf24', marginBottom: '0.25rem' }}>
                                    {usageCredits === null ? '...' : usageCredits.toLocaleString()}
                                </div>
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Live balance</div>
                            </div>
                        </div>
                        <button style={{ padding: '0.5625rem 1.125rem', width: 'fit-content', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                            Manage Billing →
                        </button>
                    </div>
                )}

                {activeTab === 'Security' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                        <h2 style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>Security</h2>
                        {[
                            { label: 'Require MFA for all users', enabled: false },
                            { label: 'Session timeout (inactivity)', enabled: true },
                            { label: 'SSO / OIDC login only', enabled: false },
                        ].map((setting, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.875rem 1rem', background: 'rgba(255,255,255,0.02)', borderRadius: 10, border: '1px solid var(--border)' }}>
                                <div>
                                    <div style={{ fontWeight: 500, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{setting.label}</div>
                                </div>
                                <div style={{
                                    width: 40, height: 22, borderRadius: 999,
                                    background: setting.enabled ? 'var(--brand)' : 'rgba(255,255,255,0.1)',
                                    position: 'relative', cursor: 'pointer',
                                    transition: 'background 200ms',
                                }}>
                                    <div style={{
                                        width: 16, height: 16, borderRadius: '50%', background: 'white',
                                        position: 'absolute', top: 3,
                                        left: setting.enabled ? 21 : 3,
                                        transition: 'left 200ms',
                                        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                                    }} />
                                </div>
                            </div>
                        ))}
                        <div>
                            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}>OIDC Issuer URL</label>
                            <input readOnly defaultValue="https://accounts.google.com" style={{ width: '100%', padding: '0.5625rem 0.875rem', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: '0.875rem', fontFamily: 'monospace', boxSizing: 'border-box' }} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
