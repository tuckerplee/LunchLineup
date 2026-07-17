'use client';

import type { CSSProperties, KeyboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';
import { BillingSettingsPanel } from './BillingSettingsPanel';
import { AccountLifecyclePanel } from './AccountLifecyclePanel';
import { MfaEnrollmentPanel } from './MfaEnrollmentPanel';
import { useBillingSettings } from './use-billing-settings';
import {
    SETTINGS_TABS,
    resolveSettingsTabKey,
    settingsPanelId,
    settingsTabId,
    type SettingsTab,
} from './settings-tabs';

type Banner = {
    tone: 'success' | 'error';
    text: string;
} | null;

type GeneralFormState = {
    organizationName: string;
    slug: string;
    timezone: string;
};

type TeamFormState = {
    defaultRole: 'STAFF' | 'MANAGER';
    shiftApprovalPolicy: 'AUTO_APPROVE' | 'MANAGER_APPROVAL' | 'ADMIN_APPROVAL';
};

type SecurityFormState = {
    requireMfa: boolean;
    sessionTimeoutMinutes: string;
    ssoOnly: boolean;
};

type SettingsWorkspaceProps = {
    canWriteSettings: boolean;
    canReadBilling: boolean;
    canManageBilling: boolean;
    canExportAccount: boolean;
    canManageAccountLifecycle: boolean;
};

const TIMEZONE_OPTIONS = [
    { value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
    { value: 'America/Chicago', label: 'Central Time (US & Canada)' },
    { value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
];

const SESSION_TIMEOUT_OPTIONS = [15, 30, 60, 120, 240];

function getCsrfHeaders(): Record<string, string> {
    if (typeof document === 'undefined') return {};
    const pair = document.cookie
        .split('; ')
        .find((entry) => entry.startsWith('csrf_token='));
    const csrfToken = pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
    return csrfToken ? { 'x-csrf-token': csrfToken } : {};
}

function jsonWriteInit(method: 'POST' | 'PUT', payload: unknown): RequestInit {
    return {
        method,
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...getCsrfHeaders(),
        },
        body: JSON.stringify(payload),
    };
}

async function writeJson<T>(path: string, payload: unknown): Promise<T> {
    const response = await fetchWithSession(path, jsonWriteInit('PUT', payload));
    const responsePayload = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) {
        const message = typeof (responsePayload as { message?: unknown }).message === 'string'
            ? String((responsePayload as { message: string }).message)
            : `Request failed (${response.status})`;
        throw new Error(message);
    }
    return responsePayload as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function unwrapSettings(payload: unknown): Record<string, unknown> {
    const root = asRecord(payload);
    if (!root) return {};
    const nested = asRecord(root.settings) ?? asRecord(root.data) ?? asRecord(root.result);
    return nested ?? root;
}

function firstRecord(sources: Array<Record<string, unknown> | null>, keys: string[]): Record<string, unknown> | null {
    for (const source of sources) {
        if (!source) continue;
        for (const key of keys) {
            const value = asRecord(source[key]);
            if (value) return value;
        }
    }
    return null;
}

function readString(sources: Array<Record<string, unknown> | null>, keys: string[], fallback = ''): string {
    for (const source of sources) {
        if (!source) continue;
        for (const key of keys) {
            const value = source[key];
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
        }
    }
    return fallback;
}

function readBoolean(sources: Array<Record<string, unknown> | null>, keys: string[], fallback = false): boolean {
    for (const source of sources) {
        if (!source) continue;
        for (const key of keys) {
            const value = source[key];
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                if (value === 'true' || value === '1') return true;
                if (value === 'false' || value === '0') return false;
            }
            if (typeof value === 'number') return value !== 0;
        }
    }
    return fallback;
}

function readOptionalNumber(sources: Array<Record<string, unknown> | null>, keys: string[]): number | null {
    for (const source of sources) {
        if (!source) continue;
        for (const key of keys) {
            const value = source[key];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string' && value.trim()) {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) return parsed;
            }
        }
    }
    return null;
}

function readDefaultRole(value: unknown): 'STAFF' | 'MANAGER' {
    if (typeof value !== 'string') return 'STAFF';
    if (value.toUpperCase() === 'MANAGER') return 'MANAGER';
    return 'STAFF';
}

function readApprovalPolicy(value: unknown): TeamFormState['shiftApprovalPolicy'] {
    if (typeof value !== 'string') return 'MANAGER_APPROVAL';
    const normalized = value.toUpperCase();
    if (normalized.includes('AUTO')) return 'AUTO_APPROVE';
    if (normalized.includes('ADMIN')) return 'ADMIN_APPROVAL';
    return 'MANAGER_APPROVAL';
}

function toNumberString(value: number | null): string {
    return value === null ? '' : String(value);
}

function extractBannerMessage(payload: unknown, fallback: string): string {
    if (typeof payload === 'string' && payload.trim()) return payload;
    const record = asRecord(payload);
    if (record && typeof record.message === 'string' && record.message.trim()) return record.message;
    return fallback;
}

function noticeStyle(tone: 'success' | 'error'): CSSProperties {
    return {
        padding: '0.8rem 0.95rem',
        borderRadius: 12,
        border: tone === 'success' ? '1px solid #bdeed4' : '1px solid #ffd0da',
        background: tone === 'success' ? '#e9fbf1' : '#fff1f4',
        color: tone === 'success' ? '#0f8c52' : '#cb3653',
        fontWeight: 600,
        fontSize: '0.86rem',
    };
}

export function SettingsWorkspace({
    canWriteSettings,
    canReadBilling,
    canManageBilling,
    canExportAccount,
    canManageAccountLifecycle,
}: SettingsWorkspaceProps) {
    const [activeTab, setActiveTab] = useState<SettingsTab>('General');
    const [isLoading, setIsLoading] = useState(true);
    const [isSettingsHydrated, setIsSettingsHydrated] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [generalForm, setGeneralForm] = useState<GeneralFormState>({
        organizationName: '',
        slug: '',
        timezone: 'America/Los_Angeles',
    });
    const [teamForm, setTeamForm] = useState<TeamFormState>({
        defaultRole: 'STAFF',
        shiftApprovalPolicy: 'MANAGER_APPROVAL',
    });
    const [securityForm, setSecurityForm] = useState<SecurityFormState>({
        requireMfa: false,
        sessionTimeoutMinutes: '30',
        ssoOnly: false,
    });
    const [generalNotice, setGeneralNotice] = useState<Banner>(null);
    const [teamNotice, setTeamNotice] = useState<Banner>(null);
    const [securityNotice, setSecurityNotice] = useState<Banner>(null);
    const [pinNotice, setPinNotice] = useState<Banner>(null);
    const [generalSaving, setGeneralSaving] = useState(false);
    const [teamSaving, setTeamSaving] = useState(false);
    const [securitySaving, setSecuritySaving] = useState(false);
    const [pinSaving, setPinSaving] = useState(false);

    const [currentPin, setCurrentPin] = useState('');
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const settingsLoadRequestRef = useRef(0);
    const initialSettingsLoadStartedRef = useRef(false);
    const tabButtonRefs = useRef(new Map<SettingsTab, HTMLButtonElement>());

    const {
        billingState,
        creditPackState,
        billingNotice,
        billingFeatures,
        configuredPriceOptions,
        canPurchaseCreditPacks,
        subscriptionSaving,
        creditPackSaving,
        billingReturnDetected,
        loadBilling,
        startSubscription,
        changeSubscription,
        openBillingPortal,
        resumeSubscription,
        purchaseCreditPack,
    } = useBillingSettings({ canReadBilling, canManageBilling });
    const loadSettings = useCallback(async () => {
        const requestId = ++settingsLoadRequestRef.current;
        setIsLoading(true);
        setIsSettingsHydrated(false);
        setLoadError(null);
        try {
            const payload = await fetchJsonWithSession<unknown>('/settings');
            if (requestId !== settingsLoadRequestRef.current) return;
            const root = unwrapSettings(payload);
            const general = firstRecord([root], ['general', 'workspace', 'organization', 'profile', 'tenant']);
            const team = firstRecord([root], ['team', 'defaults', 'inviteDefaults', 'workflows']);
            const security = firstRecord([root], ['security', 'auth', 'access', 'session']);

            setGeneralForm({
                organizationName: readString([general, root], ['organizationName', 'name', 'workspaceName', 'companyName'], 'Workspace'),
                slug: readString([general, root], ['slug', 'subdomain', 'workspaceSlug'], ''),
                timezone: readString([general, root], ['timezone', 'timeZone'], 'America/Los_Angeles'),
            });

            setTeamForm({
                defaultRole: readDefaultRole(readString([team, root], ['defaultRole', 'defaultInviteRole', 'inviteRole'], 'STAFF')),
                shiftApprovalPolicy: readApprovalPolicy(readString([team, root], ['shiftApprovalPolicy', 'approvalPolicy', 'shiftPolicy'], 'MANAGER_APPROVAL')),
            });

            setSecurityForm({
                requireMfa: readBoolean([security, root], ['requireMfaForAll', 'requireMfa', 'mfaRequired', 'enforceMfa']),
                sessionTimeoutMinutes: toNumberString(readOptionalNumber([security, root], ['sessionTimeoutMinutes', 'sessionTimeout', 'idleTimeoutMinutes']) ?? 480),
                ssoOnly: readBoolean([security, root], ['ssoOidcOnly', 'ssoOnly', 'ssoRequired', 'oidcOnly']),
            });
            setIsSettingsHydrated(true);
        } catch (error) {
            if (requestId !== settingsLoadRequestRef.current) return;
            setLoadError(error instanceof Error ? error.message : 'Unable to load settings.');
        } finally {
            if (requestId === settingsLoadRequestRef.current) setIsLoading(false);
        }
    }, []);

    const visibleTabs = useMemo<SettingsTab[]>(
        () => SETTINGS_TABS.filter((tab) => {
            if (tab === 'Billing') return canReadBilling;
            if (tab === 'Account') return canWriteSettings;
            return true;
        }),
        [canReadBilling, canWriteSettings],
    );

    const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: SettingsTab) => {
        const targetTab = resolveSettingsTabKey(event.key, tab, visibleTabs);
        if (!targetTab) return;
        event.preventDefault();
        setActiveTab(targetTab);
        window.requestAnimationFrame(() => tabButtonRefs.current.get(targetTab)?.focus());
    };

    const panelProps = (tab: SettingsTab) => ({
        id: settingsPanelId(tab),
        role: 'tabpanel' as const,
        'aria-labelledby': settingsTabId(tab),
        tabIndex: 0,
    });

    useEffect(() => {
        if (initialSettingsLoadStartedRef.current) return;
        initialSettingsLoadStartedRef.current = true;
        void loadSettings();
    }, [loadSettings]);

    useEffect(() => {
        if (!visibleTabs.includes(activeTab)) {
            setActiveTab(visibleTabs[0] ?? 'General');
            return;
        }
        if (activeTab === 'Billing') {
            void loadBilling();
        }
    }, [activeTab, loadBilling, visibleTabs]);
    useEffect(() => {
        if (billingReturnDetected && canReadBilling) {
            setActiveTab('Billing');
        }
    }, [billingReturnDetected, canReadBilling]);

    const workspaceName = generalForm.organizationName || 'Workspace settings';
    const subtitle = useMemo(() => {
        if (isLoading) return 'Loading live settings...';
        return `${workspaceName} · Configure organization defaults, team behavior, billing, and security`;
    }, [isLoading, workspaceName]);
    const canMutateSettings = canWriteSettings && isSettingsHydrated && !isLoading;

    const saveGeneral = useCallback(async () => {
        if (!canMutateSettings) {
            setGeneralNotice({ tone: 'error', text: isSettingsHydrated ? 'You have read-only settings access.' : 'Reload settings before saving.' });
            return;
        }
        const organizationName = generalForm.organizationName.trim();
        const slug = generalForm.slug.trim().toLowerCase();
        if (!organizationName) {
            setGeneralNotice({ tone: 'error', text: 'Organization name is required.' });
            return;
        }
        if (!slug) {
            setGeneralNotice({ tone: 'error', text: 'Slug / subdomain is required.' });
            return;
        }

        setGeneralSaving(true);
        setGeneralNotice(null);
        try {
            await writeJson('/settings/general', {
                organizationName,
                name: organizationName,
                slug,
                timezone: generalForm.timezone,
            });
            setGeneralNotice({ tone: 'success', text: 'General settings saved.' });
        } catch (error) {
            setGeneralNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to save general settings.' });
        } finally {
            setGeneralSaving(false);
        }
    }, [canMutateSettings, generalForm.organizationName, generalForm.slug, generalForm.timezone, isSettingsHydrated]);

    const saveTeam = useCallback(async () => {
        if (!canMutateSettings) {
            setTeamNotice({ tone: 'error', text: isSettingsHydrated ? 'You have read-only settings access.' : 'Reload settings before saving.' });
            return;
        }
        setTeamSaving(true);
        setTeamNotice(null);
        try {
            await writeJson('/settings/team', {
                defaultRole: teamForm.defaultRole,
                defaultInviteRole: teamForm.defaultRole,
                shiftApprovalPolicy: teamForm.shiftApprovalPolicy,
            });
            setTeamNotice({ tone: 'success', text: 'Team settings saved.' });
        } catch (error) {
            setTeamNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to save team settings.' });
        } finally {
            setTeamSaving(false);
        }
    }, [canMutateSettings, isSettingsHydrated, teamForm.defaultRole, teamForm.shiftApprovalPolicy]);
    const saveSecurity = useCallback(async () => {
        if (!canMutateSettings) {
            setSecurityNotice({ tone: 'error', text: isSettingsHydrated ? 'You have read-only settings access.' : 'Reload settings before saving.' });
            return;
        }
        const timeout = Number(securityForm.sessionTimeoutMinutes);
        if (!Number.isFinite(timeout) || timeout <= 0) {
            setSecurityNotice({ tone: 'error', text: 'Session timeout must be a valid number of minutes.' });
            return;
        }

        setSecuritySaving(true);
        setSecurityNotice(null);
        try {
            await writeJson('/settings/security', {
                requireMfaForAll: securityForm.requireMfa,
                sessionTimeoutMinutes: timeout,
                ssoOidcOnly: securityForm.ssoOnly,
            });
            setSecurityNotice({ tone: 'success', text: 'Security settings saved.' });
        } catch (error) {
            setSecurityNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to save security settings.' });
        } finally {
            setSecuritySaving(false);
        }
    }, [canMutateSettings, isSettingsHydrated, securityForm.requireMfa, securityForm.sessionTimeoutMinutes, securityForm.ssoOnly]);

    const updatePin = useCallback(async () => {
        const normalizedCurrentPin = currentPin.replace(/\D/g, '');
        const normalizedNewPin = newPin.replace(/\D/g, '');
        const normalizedConfirmPin = confirmPin.replace(/\D/g, '');
        if (!/^\d{4,8}$/.test(normalizedCurrentPin) || !/^\d{4,8}$/.test(normalizedNewPin)) {
            setPinNotice({ tone: 'error', text: 'PIN must be 4 to 8 digits.' });
            return;
        }
        if (normalizedNewPin !== normalizedConfirmPin) {
            setPinNotice({ tone: 'error', text: 'New PIN and confirmation do not match.' });
            return;
        }

        setPinSaving(true);
        setPinNotice(null);
        try {
            const response = await fetchWithSession('/users/me/pin', {
                method: 'PUT',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    ...getCsrfHeaders(),
                },
                body: JSON.stringify({
                    currentPin: normalizedCurrentPin,
                    newPin: normalizedNewPin,
                }),
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                const message = extractBannerMessage(payload, 'Unable to update PIN.');
                throw new Error(message);
            }
            setCurrentPin('');
            setNewPin('');
            setConfirmPin('');
            setPinNotice({ tone: 'success', text: 'PIN updated successfully.' });
        } catch (error) {
            setPinNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to update PIN.' });
        } finally {
            setPinSaving(false);
        }
    }, [confirmPin, currentPin, newPin]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 980 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div className="workspace-kicker">Workspace configuration</div>
                <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>
                    Settings
                </h1>
                <p className="workspace-subtitle">{subtitle}</p>
            </section>

            {loadError ? (
                <div style={{ ...noticeStyle('error'), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }} role="alert">
                    <span>{loadError} Settings changes are disabled until the current values load.</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadSettings()} disabled={isLoading}>
                        {isLoading ? 'Retrying...' : 'Retry settings load'}
                    </button>
                </div>
            ) : null}

            {!canWriteSettings ? (
                <div style={noticeStyle('success')} role="status">
                    Read-only settings access. Tenant setting changes are hidden for this role.
                </div>
            ) : null}

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
                    aria-orientation="horizontal"
                >
                    {visibleTabs.map((tab) => (
                        <button
                            key={tab}
                            type="button"
                            id={settingsTabId(tab)}
                            ref={(element) => {
                                if (element) tabButtonRefs.current.set(tab, element);
                                else tabButtonRefs.current.delete(tab);
                            }}
                            role="tab"
                            aria-selected={activeTab === tab}
                            aria-controls={settingsPanelId(tab)}
                            tabIndex={activeTab === tab ? 0 : -1}
                            onClick={() => setActiveTab(tab)}
                            onKeyDown={(event) => handleTabKeyDown(event, tab)}
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
                    {visibleTabs.filter((tab) => tab !== activeTab).map((tab) => (
                        <div key={tab} {...panelProps(tab)} hidden />
                    ))}
                    {activeTab === 'General' && (
                        <div {...panelProps('General')} style={{ display: 'grid', gap: '1rem' }}>
                            <div style={{ display: 'grid', gap: '0.2rem' }}>
                                <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Organization Profile</h2>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Update the visible workspace identity and routing defaults.</p>
                            </div>

                            {generalNotice ? (
                                <div style={noticeStyle(generalNotice.tone)} role="status">
                                    {generalNotice.text}
                                </div>
                            ) : null}

                            <label className="form-group">
                                <span className="form-label">Organization Name</span>
                                <input
                                    value={generalForm.organizationName}
                                    onChange={(event) => setGeneralForm((current) => ({ ...current, organizationName: event.target.value }))}
                                    className="form-input"
                                    disabled={!canMutateSettings}
                                />
                            </label>

                            <label className="form-group">
                                <span className="form-label">Slug / Subdomain</span>
                                <input
                                    value={generalForm.slug}
                                    onChange={(event) => setGeneralForm((current) => ({ ...current, slug: event.target.value }))}
                                    className="form-input"
                                    disabled={!canMutateSettings}
                                />
                            </label>

                            <label className="form-group">
                                <span className="form-label">Timezone</span>
                                <select
                                    className="form-input"
                                    value={generalForm.timezone}
                                    onChange={(event) => setGeneralForm((current) => ({ ...current, timezone: event.target.value }))}
                                    disabled={!canMutateSettings}
                                >
                                    {TIMEZONE_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            {canWriteSettings ? (
                                <div>
                                    <button className="btn btn-primary" onClick={() => void saveGeneral()} disabled={generalSaving || !canMutateSettings}>
                                        {generalSaving ? 'Saving...' : 'Save Changes'}
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    )}

                    {activeTab === 'Team' && (
                        <div {...panelProps('Team')} style={{ display: 'grid', gap: '1rem' }}>
                            <div style={{ display: 'grid', gap: '0.2rem' }}>
                                <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Team Defaults</h2>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Controls invite defaults and approval behavior for new work.</p>
                            </div>

                            {teamNotice ? (
                                <div style={noticeStyle(teamNotice.tone)} role="status">
                                    {teamNotice.text}
                                </div>
                            ) : null}

                            <label className="form-group">
                                <span className="form-label">Default role for new invites</span>
                                <select
                                    className="form-input"
                                    value={teamForm.defaultRole}
                                    onChange={(event) =>
                                        setTeamForm((current) => ({ ...current, defaultRole: event.target.value as TeamFormState['defaultRole'] }))
                                    }
                                    disabled={!canMutateSettings}
                                >
                                    <option value="STAFF">Staff</option>
                                    <option value="MANAGER">Manager</option>
                                </select>
                            </label>

                            <div className="surface-muted" style={{ padding: '0.9rem' }}>
                                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.6rem' }}>
                                    Shift approval policy
                                </div>
                                {[
                                    { value: 'AUTO_APPROVE', label: 'Auto-approve all shifts' },
                                    { value: 'MANAGER_APPROVAL', label: 'Require manager approval' },
                                    { value: 'ADMIN_APPROVAL', label: 'Require admin approval' },
                                ].map((option) => (
                                    <label key={option.value} style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.45rem', alignItems: 'center', cursor: canWriteSettings ? 'pointer' : 'default' }}>
                                        <input
                                            type="radio"
                                            name="approval"
                                            checked={teamForm.shiftApprovalPolicy === option.value}
                                            onChange={() => setTeamForm((current) => ({ ...current, shiftApprovalPolicy: option.value as TeamFormState['shiftApprovalPolicy'] }))}
                                            disabled={!canMutateSettings}
                                        />
                                        <span style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}>{option.label}</span>
                                    </label>
                                ))}
                            </div>

                            {canWriteSettings ? (
                                <div>
                                    <button className="btn btn-primary" onClick={() => void saveTeam()} disabled={teamSaving || !canMutateSettings}>
                                        {teamSaving ? 'Saving...' : 'Save Changes'}
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    )}

                    {activeTab === 'Billing' && (
                        <div {...panelProps('Billing')}>
                            <BillingSettingsPanel
                                billingState={billingState}
                                creditPackState={creditPackState}
                                billingNotice={billingNotice}
                                billingFeatures={billingFeatures}
                                configuredPriceOptions={configuredPriceOptions}
                                canManageBilling={canManageBilling}
                                canPurchaseCreditPacks={canPurchaseCreditPacks}
                                subscriptionSaving={subscriptionSaving}
                                creditPackSaving={creditPackSaving}
                                noticeStyle={noticeStyle}
                                onStartSubscription={startSubscription}
                                onChangeSubscription={changeSubscription}
                                onOpenBillingPortal={openBillingPortal}
                                onResumeSubscription={resumeSubscription}
                                onPurchaseCreditPack={purchaseCreditPack}
                                onRefreshBilling={loadBilling}
                            />
                        </div>
                    )}

                    {activeTab === 'Account' && (
                        <div {...panelProps('Account')}>
                            <AccountLifecyclePanel
                                canExportAccount={canExportAccount}
                                canManageAccountLifecycle={canManageAccountLifecycle}
                                noticeStyle={noticeStyle}
                            />
                        </div>
                    )}

                    {activeTab === 'Security' && (
                        <div {...panelProps('Security')} style={{ display: 'grid', gap: '1rem' }}>
                            <div style={{ display: 'grid', gap: '0.2rem' }}>
                                <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Security Controls</h2>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Adjust account protection settings, MFA enrollment, and PIN rotation.</p>
                            </div>

                            {securityNotice ? (
                                <div style={noticeStyle(securityNotice.tone)} role="status">
                                    {securityNotice.text}
                                </div>
                            ) : null}

                            <MfaEnrollmentPanel tenantMfaRequired={securityForm.requireMfa} />

                            <div style={{ display: 'grid', gap: '0.6rem' }}>
                                {(
                                    [
                                        { key: 'requireMfa', label: 'Require MFA for all users', enabled: securityForm.requireMfa },
                                        { key: 'ssoOnly', label: 'SSO / OIDC login only', enabled: securityForm.ssoOnly },
                                    ] as const
                                ).map((setting) => (
                                    <label
                                        key={setting.key}
                                        className="surface-muted"
                                        style={{
                                            padding: '0.8rem 0.9rem',
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            gap: '0.8rem',
                                            cursor: canWriteSettings ? 'pointer' : 'default',
                                        }}
                                    >
                                        <div style={{ display: 'grid', gap: 2 }}>
                                            <div style={{ fontWeight: 600, fontSize: '0.87rem', color: 'var(--text-primary)' }}>{setting.label}</div>
                                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                                                {setting.key === 'requireMfa'
                                                    ? 'Require a second factor at sign-in.'
                                                    : 'Only allow identity-provider authentication.'}
                                            </div>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={setting.enabled}
                                            onChange={(event) =>
                                                setSecurityForm((current) => ({ ...current, [setting.key]: event.target.checked } as SecurityFormState))
                                            }
                                            disabled={!canMutateSettings}
                                            style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                                        />
                                        <div
                                            aria-hidden="true"
                                            style={{
                                                width: 42,
                                                height: 24,
                                                borderRadius: 999,
                                                background: setting.enabled ? 'linear-gradient(135deg, #4171ff, #2f63ff)' : '#c9d3e6',
                                                position: 'relative',
                                                flexShrink: 0,
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
                                    </label>
                                ))}
                            </div>

                            <label className="form-group">
                                <span className="form-label">Session timeout</span>
                                <select
                                    className="form-input"
                                    value={securityForm.sessionTimeoutMinutes}
                                    onChange={(event) =>
                                        setSecurityForm((current) => ({ ...current, sessionTimeoutMinutes: event.target.value }))
                                    }
                                    disabled={!canMutateSettings}
                                >
                                    {SESSION_TIMEOUT_OPTIONS.map((minutes) => (
                                        <option key={minutes} value={minutes}>
                                            {minutes} minute{minutes === 1 ? '' : 's'}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            {canWriteSettings ? (
                                <div>
                                    <button className="btn btn-primary" onClick={() => void saveSecurity()} disabled={securitySaving || !canMutateSettings}>
                                        {securitySaving ? 'Saving...' : 'Save Changes'}
                                    </button>
                                </div>
                            ) : null}

                            <div className="surface-muted" style={{ padding: '0.85rem', display: 'grid', gap: '0.55rem' }}>
                                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>Change my PIN</div>
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                    Username-based accounts can rotate their own PIN here.
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr)) auto', gap: '0.5rem' }}>
                                    <input
                                        className="form-input"
                                        type="password"
                                        inputMode="numeric"
                                        placeholder="Current PIN"
                                        value={currentPin}
                                        onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                                    />
                                    <input
                                        className="form-input"
                                        type="password"
                                        inputMode="numeric"
                                        placeholder="New PIN"
                                        value={newPin}
                                        onChange={(event) => setNewPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                                    />
                                    <input
                                        className="form-input"
                                        type="password"
                                        inputMode="numeric"
                                        placeholder="Confirm PIN"
                                        value={confirmPin}
                                        onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                                    />
                                    <button className="btn btn-secondary" onClick={() => void updatePin()} disabled={pinSaving}>
                                        {pinSaving ? 'Saving...' : 'Update PIN'}
                                    </button>
                                </div>
                                {pinNotice ? (
                                    <div style={noticeStyle(pinNotice.tone)} role="status">
                                        {pinNotice.text}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    )}
                </div>
            </section>

        </div>
    );
}
