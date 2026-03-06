'use client';

import { useEffect, useState } from 'react';
import { fetchJsonWithSession } from '@/lib/client-api';

const TABS = ['General', 'Team', 'Billing', 'Security'] as const;
type Tab = typeof TABS[number];

type FeatureMatrixResponse = {
    usageCredits?: number;
};

export default function SettingsPage() {
    const [activeTab, setActiveTab] = useState<Tab>('General');
    const [usageCredits, setUsageCredits] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        const loadCredits = async () => {
            try {
                const payload = await fetchJsonWithSession<FeatureMatrixResponse>('/billing/features');
                if (!cancelled) {
                    setUsageCredits(typeof payload.usageCredits === 'number' ? payload.usageCredits : 0);
                }
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 980 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div className="workspace-kicker">Workspace configuration</div>
                <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>
                    Settings
                </h1>
                <p className="workspace-subtitle">Downtown Bistro · Configure organization defaults, billing, and security</p>
            </section>

            <section className="surface-card" style={{ overflow: 'hidden' }}>
                <div
                    style={{
                        display: 'flex',
                        gap: '0.4rem',
                        padding: '0.75rem',
                        borderBottom: '1px solid var(--border)',
                        background: '#f8faff',
                        overflowX: 'auto',
                    }}
                    role="tablist"
                    aria-label="Settings sections"
                >
                    {TABS.map((tab) => (
                        <button
                            key={tab}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === tab}
                            onClick={() => setActiveTab(tab)}
                            style={{
                                padding: '0.5rem 0.8rem',
                                borderRadius: 10,
                                border: activeTab === tab ? '1px solid #bdd0ff' : '1px solid transparent',
                                background: activeTab === tab ? '#edf3ff' : 'transparent',
                                color: activeTab === tab ? '#234ed9' : 'var(--text-secondary)',
                                fontSize: '0.84rem',
                                fontWeight: activeTab === tab ? 700 : 600,
                                cursor: 'pointer',
                                transition: 'all 160ms var(--ease-out)',
                            }}
                        >
                            {tab}
                        </button>
                    ))}
                </div>

                <div style={{ padding: '1rem' }}>
                    {activeTab === 'General' && (
                        <div style={{ display: 'grid', gap: '1rem' }}>
                            <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Organization Profile</h2>

                            {[
                                { label: 'Organization Name', value: 'Downtown Bistro' },
                                { label: 'Slug / Subdomain', value: 'downtown-bistro' },
                            ].map((f) => (
                                <label key={f.label} className="form-group">
                                    <span className="form-label">{f.label}</span>
                                    <input defaultValue={f.value} className="form-input" />
                                </label>
                            ))}

                            <label className="form-group">
                                <span className="form-label">Timezone</span>
                                <select className="form-input" defaultValue="America/Los_Angeles">
                                    <option value="America/Los_Angeles">Pacific Time (US & Canada)</option>
                                    <option value="America/Chicago">Central Time (US & Canada)</option>
                                    <option value="America/New_York">Eastern Time (US & Canada)</option>
                                </select>
                            </label>

                            <div>
                                <button className="btn btn-primary">Save Changes</button>
                            </div>
                        </div>
                    )}

                    {activeTab === 'Team' && (
                        <div style={{ display: 'grid', gap: '1rem' }}>
                            <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Team Defaults</h2>

                            <label className="form-group">
                                <span className="form-label">Default role for new invites</span>
                                <select className="form-input" defaultValue="STAFF">
                                    <option value="STAFF">Staff</option>
                                    <option value="MANAGER">Manager</option>
                                </select>
                            </label>

                            <div className="surface-muted" style={{ padding: '0.9rem' }}>
                                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.6rem' }}>
                                    Shift approval policy
                                </div>
                                {['Auto-approve all shifts', 'Require manager approval', 'Require admin approval'].map((opt) => (
                                    <label key={opt} style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.45rem', alignItems: 'center', cursor: 'pointer' }}>
                                        <input type="radio" name="approval" defaultChecked={opt === 'Require manager approval'} />
                                        <span style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}>{opt}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}

                    {activeTab === 'Billing' && (
                        <div style={{ display: 'grid', gap: '1rem' }}>
                            <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Billing and Usage</h2>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.7rem' }}>
                                <div className="surface-muted" style={{ padding: '0.9rem', background: '#edf3ff', borderColor: '#cfe0ff' }}>
                                    <div className="workspace-kicker" style={{ color: '#2f63ff' }}>
                                        Current Plan
                                    </div>
                                    <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 2 }}>Starter</div>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Up to 15 staff · 2 locations</div>
                                </div>

                                <div className="surface-muted" style={{ padding: '0.9rem', background: '#fff7e7', borderColor: '#ffe4ab' }}>
                                    <div className="workspace-kicker" style={{ color: '#cc7f06' }}>
                                        Usage Credits
                                    </div>
                                    <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#cc7f06', marginBottom: 2 }}>
                                        {usageCredits === null ? '...' : usageCredits.toLocaleString()}
                                    </div>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Live balance</div>
                                </div>
                            </div>

                            <button className="btn btn-secondary" style={{ width: 'fit-content' }}>
                                Manage Billing
                            </button>
                        </div>
                    )}

                    {activeTab === 'Security' && (
                        <div style={{ display: 'grid', gap: '0.8rem' }}>
                            <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Security Controls</h2>

                            {[
                                { label: 'Require MFA for all users', enabled: false },
                                { label: 'Session timeout (inactivity)', enabled: true },
                                { label: 'SSO / OIDC login only', enabled: false },
                            ].map((setting) => (
                                <div
                                    key={setting.label}
                                    className="surface-muted"
                                    style={{
                                        padding: '0.8rem 0.9rem',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: '0.8rem',
                                    }}
                                >
                                    <div style={{ fontWeight: 600, fontSize: '0.87rem', color: 'var(--text-primary)' }}>{setting.label}</div>
                                    <div
                                        aria-hidden="true"
                                        style={{
                                            width: 42,
                                            height: 24,
                                            borderRadius: 999,
                                            background: setting.enabled ? 'linear-gradient(135deg, #4171ff, #2f63ff)' : '#c9d3e6',
                                            position: 'relative',
                                        }}
                                    >
                                        <div
                                            style={{
                                                width: 18,
                                                height: 18,
                                                borderRadius: '50%',
                                                background: '#ffffff',
                                                position: 'absolute',
                                                top: 3,
                                                left: setting.enabled ? 21 : 3,
                                                transition: 'left 200ms',
                                                boxShadow: '0 2px 5px rgba(20,30,50,0.15)',
                                            }}
                                        />
                                    </div>
                                </div>
                            ))}

                            <label className="form-group">
                                <span className="form-label">OIDC Issuer URL</span>
                                <input readOnly defaultValue="https://accounts.google.com" className="form-input" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }} />
                            </label>
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
