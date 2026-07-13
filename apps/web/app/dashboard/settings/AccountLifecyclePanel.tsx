'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPath, fetchJsonWithSession } from '@/lib/client-api';

type NoticeTone = 'success' | 'error';
type NoticeStyle = (tone: NoticeTone) => CSSProperties;

type AccountNotice = {
    tone: NoticeTone;
    text: string;
} | null;

type AccountRetention = {
    deletionRequestedAt?: string | null;
    applicationDataEligibleAt?: string | null;
    databaseBackupEligibleAt?: string | null;
    securityLogEligibleAt?: string | null;
    retainedDatabaseRecordsEligibleAt?: string | null;
    fullDatabasePurgeEligibleAt?: string | null;
    retainedRecords?: string[];
} | null;

type AccountStatus = {
    id?: string;
    slug?: string | null;
    status?: string;
    lifecycleStatus?: string;
    cancelledAt?: string | null;
    deletionRequestedAt?: string | null;
    applicationDataPurgedAt?: string | null;
    retention?: AccountRetention;
    retainedRecords?: string[];
};

type CancellationResponse = {
    cancellationEffectiveAt?: string | null;
};

type AccountExportJob = {
    id: string;
    state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
    createdAt: string;
    expiresAt: string;
    statusPath: string;
    downloadPath?: string | null;
    error?: string;
    progress?: {
        collection?: string | null;
        rows?: number;
        attempts?: number;
    };
};

type AccountExportJobsResponse = {
    jobs: AccountExportJob[];
};

type AccountLifecyclePanelProps = {
    canExportAccount: boolean;
    canManageAccountLifecycle: boolean;
    noticeStyle: NoticeStyle;
};

function formatStatus(value?: string | null): string {
    if (!value) return 'Unknown';
    return value.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value?: string | null): string {
    if (!value) return 'Not scheduled';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

function jsonHeaders(): HeadersInit {
    return { 'Content-Type': 'application/json' };
}

const EXPORT_POLL_INTERVAL_MS = 1_000;
const EXPORT_RETRY_INTERVAL_MS = 5_000;

function isActiveExportJob(job: AccountExportJob | null): boolean {
    return job?.state === 'queued' || job?.state === 'running';
}

function selectRecoverableExportJob(jobs: AccountExportJob[]): AccountExportJob | null {
    return jobs.find((job) => isActiveExportJob(job)) ?? jobs[0] ?? null;
}

function describeExportJob(job: AccountExportJob | null): string | null {
    if (!job) return null;
    if (job.state === 'queued') return 'Export queued.';
    if (job.state === 'running') {
        const rows = job.progress?.rows;
        return typeof rows === 'number' ? `Export in progress - ${rows.toLocaleString()} rows processed.` : 'Export in progress.';
    }
    if (job.state === 'ready') return `Export ready until ${formatDate(job.expiresAt)}.`;
    if (job.state === 'failed') return job.error ? `Export failed: ${job.error}` : 'Export generation failed.';
    return 'The previous export expired. Generate a new export.';
}

export function AccountLifecyclePanel({
    canExportAccount,
    canManageAccountLifecycle,
    noticeStyle,
}: AccountLifecyclePanelProps) {
    const [status, setStatus] = useState<AccountStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [action, setAction] = useState<'export' | 'cancel' | 'delete' | null>(null);
    const [notice, setNotice] = useState<AccountNotice>(null);
    const [cancelConfirmation, setCancelConfirmation] = useState('');
    const [cancelReason, setCancelReason] = useState('');
    const [deleteConfirmation, setDeleteConfirmation] = useState('');
    const [exportJob, setExportJob] = useState<AccountExportJob | null>(null);
    const [recoveringExport, setRecoveringExport] = useState(false);
    const [exportError, setExportError] = useState<string | null>(null);

    const tenantSlug = status?.slug ?? '';
    const retentionRows = useMemo(() => {
        const retention = status?.retention ?? null;
        return [
            { label: 'Deletion requested', value: status?.deletionRequestedAt ?? retention?.deletionRequestedAt },
            { label: 'Application data purge eligible', value: retention?.applicationDataEligibleAt },
            { label: 'Application data purged', value: status?.applicationDataPurgedAt },
            { label: 'Database backup eligible', value: retention?.databaseBackupEligibleAt },
            { label: 'Security log eligible', value: retention?.securityLogEligibleAt },
            { label: 'Full database purge eligible', value: retention?.fullDatabasePurgeEligibleAt ?? retention?.retainedDatabaseRecordsEligibleAt },
        ].filter((row) => row.value);
    }, [status]);

    const loadStatus = useCallback(async () => {
        setLoading(true);
        setNotice(null);
        try {
            const payload = await fetchJsonWithSession<AccountStatus>('/admin/account/status');
            setStatus(payload);
        } catch (error) {
            setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to load account status.' });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadStatus();
    }, [loadStatus]);

    const recoverExport = useCallback(async () => {
        if (!canExportAccount) {
            setExportJob(null);
            return;
        }

        setRecoveringExport(true);
        setExportError(null);
        try {
            const payload = await fetchJsonWithSession<AccountExportJobsResponse>('/admin/account/exports');
            setExportJob(selectRecoverableExportJob(payload.jobs));
        } catch (error) {
            setExportError(error instanceof Error ? error.message : 'Unable to recover recent account exports.');
        } finally {
            setRecoveringExport(false);
        }
    }, [canExportAccount]);

    useEffect(() => {
        void recoverExport();
    }, [recoverExport]);

    const exportJobId = exportJob?.id;
    const exportStatusPath = exportJob?.statusPath;
    const exportIsActive = isActiveExportJob(exportJob);

    useEffect(() => {
        if (!canExportAccount || !exportIsActive || !exportJobId || !exportStatusPath) return;

        let disposed = false;
        let timeoutId: number | undefined;
        const schedule = (delay: number) => {
            timeoutId = window.setTimeout(() => void poll(), delay);
        };
        const poll = async () => {
            try {
                const nextJob = await fetchJsonWithSession<AccountExportJob>(exportStatusPath);
                if (disposed) return;
                setExportJob(nextJob);
                setExportError(null);
                if (isActiveExportJob(nextJob)) {
                    schedule(EXPORT_POLL_INTERVAL_MS);
                } else if (nextJob.state === 'ready') {
                    setNotice({ tone: 'success', text: 'Account export is ready to download.' });
                } else if (nextJob.state === 'failed') {
                    setExportError(nextJob.error || 'Account export could not be generated.');
                }
            } catch (error) {
                if (disposed) return;
                setExportError(error instanceof Error ? error.message : 'Unable to refresh account export status.');
                schedule(EXPORT_RETRY_INTERVAL_MS);
            }
        };

        schedule(EXPORT_POLL_INTERVAL_MS);
        return () => {
            disposed = true;
            if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        };
    }, [canExportAccount, exportIsActive, exportJobId, exportStatusPath]);

    const exportAccount = useCallback(async () => {
        if (!canExportAccount) {
            setNotice({ tone: 'error', text: 'Account export requires tenant data export access.' });
            return;
        }

        setAction('export');
        setNotice(null);
        setExportError(null);
        try {
            const job = await fetchJsonWithSession<AccountExportJob>('/admin/account/export', {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({}),
            });
            setExportJob(job);
            if (job.state === 'ready') {
                setNotice({ tone: 'success', text: 'Account export is ready to download.' });
            }
        } catch (error) {
            setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to export account data.' });
        } finally {
            setAction(null);
        }
    }, [canExportAccount]);

    const downloadExport = useCallback(() => {
        if (exportJob?.state !== 'ready' || !exportJob.downloadPath) {
            setNotice({ tone: 'error', text: 'Account export is not ready to download.' });
            return;
        }
        window.location.assign(apiPath(exportJob.downloadPath));
        setNotice({ tone: 'success', text: 'Account export download started.' });
    }, [exportJob]);

    const cancelAccount = useCallback(async () => {
        if (!canManageAccountLifecycle) {
            setNotice({ tone: 'error', text: 'Account cancellation requires tenant lifecycle access.' });
            return;
        }
        if (!tenantSlug || cancelConfirmation.trim().toLowerCase() !== tenantSlug.toLowerCase()) {
            setNotice({ tone: 'error', text: 'Confirmation must match the workspace slug.' });
            return;
        }

        setAction('cancel');
        setNotice(null);
        try {
            const result = await fetchJsonWithSession<CancellationResponse>('/admin/account/cancel', {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({
                    confirmation: cancelConfirmation,
                    reason: cancelReason.trim() || undefined,
                }),
            });
            setCancelConfirmation('');
            setCancelReason('');
            await loadStatus();
            const effectiveAt = result.cancellationEffectiveAt
                ? ` Access remains available through ${formatDate(result.cancellationEffectiveAt)}.`
                : ' Access remains available until Stripe confirms the subscription has ended.';
            setNotice({ tone: 'success', text: `Subscription renewal cancelled.${effectiveAt}` });
        } catch (error) {
            setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to cancel account.' });
        } finally {
            setAction(null);
        }
    }, [canManageAccountLifecycle, cancelConfirmation, cancelReason, loadStatus, tenantSlug]);

    const requestDeletion = useCallback(async () => {
        if (!canManageAccountLifecycle) {
            setNotice({ tone: 'error', text: 'Account deletion requires tenant lifecycle access.' });
            return;
        }
        if (!tenantSlug || deleteConfirmation.trim().toLowerCase() !== tenantSlug.toLowerCase()) {
            setNotice({ tone: 'error', text: 'Confirmation must match the workspace slug.' });
            return;
        }

        setAction('delete');
        setNotice(null);
        try {
            await fetchJsonWithSession('/admin/account', {
                method: 'DELETE',
                headers: jsonHeaders(),
                body: JSON.stringify({ confirmation: deleteConfirmation }),
            });
            setDeleteConfirmation('');
            await loadStatus();
            setNotice({ tone: 'success', text: 'Account deletion request recorded.' });
        } catch (error) {
            setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to request deletion.' });
        } finally {
            setAction(null);
        }
    }, [canManageAccountLifecycle, deleteConfirmation, loadStatus, tenantSlug]);

    return (
        <div style={{ display: 'grid', gap: '1rem' }}>
            <div style={{ display: 'grid', gap: '0.2rem' }}>
                <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Account</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                    Review workspace lifecycle status, export account data, and manage cancellation or deletion requests.
                </p>
            </div>

            {notice ? (
                <div style={noticeStyle(notice.tone)} role="status">
                    {notice.text}
                </div>
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem' }}>
                {[
                    { label: 'Workspace slug', value: tenantSlug || 'Unknown' },
                    { label: 'Tenant status', value: formatStatus(status?.status) },
                    { label: 'Lifecycle', value: formatStatus(status?.lifecycleStatus) },
                    { label: 'Cancelled at', value: formatDate(status?.cancelledAt) },
                ].map((item) => (
                    <div key={item.label} className="surface-muted" style={{ padding: '0.85rem', display: 'grid', gap: 3 }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>
                            {item.label}
                        </div>
                        <div style={{ fontSize: '1rem', color: 'var(--text-primary)', fontWeight: 800 }}>
                            {loading ? 'Loading...' : item.value}
                        </div>
                    </div>
                ))}
            </div>

            <div className="surface-muted" style={{ padding: '0.9rem', display: 'grid', gap: '0.65rem' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.55rem', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'grid', gap: 2 }}>
                        <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>Account export</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                            Export tenant profile, settings, staff, scheduling, billing, webhook, notification, and audit records without secrets.
                        </div>
                        {describeExportJob(exportJob) ? (
                            <div style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 700 }} aria-live="polite">
                                {describeExportJob(exportJob)}
                            </div>
                        ) : null}
                        {exportError ? (
                            <div style={{ color: '#b4233f', fontSize: '0.8rem' }} role="status">
                                {exportError}
                            </div>
                        ) : null}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
                        {exportJob?.state === 'ready' && exportJob.downloadPath ? (
                            <button
                                className="btn btn-secondary"
                                type="button"
                                onClick={downloadExport}
                                disabled={loading || action !== null || !canExportAccount}
                            >
                                Download export
                            </button>
                        ) : null}
                        <button
                            className="btn btn-secondary"
                            type="button"
                            onClick={() => void exportAccount()}
                            disabled={loading || recoveringExport || action !== null || !canExportAccount || exportIsActive}
                        >
                            {recoveringExport
                                ? 'Checking exports...'
                                : action === 'export'
                                    ? 'Starting...'
                                    : exportIsActive
                                        ? 'Preparing export...'
                                        : exportJob?.state === 'ready'
                                            ? 'Generate new export'
                                            : exportJob?.state === 'failed' || exportJob?.state === 'expired'
                                                ? 'Retry export'
                                                : 'Generate export'}
                        </button>
                    </div>
                </div>
            </div>

            {retentionRows.length > 0 ? (
                <div className="surface-muted" style={{ padding: '0.9rem', display: 'grid', gap: '0.65rem' }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>Retention schedule</div>
                    <div style={{ display: 'grid', gap: '0.4rem' }}>
                        {retentionRows.map((row) => (
                            <div key={row.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 0.7fr) 1fr', gap: '0.75rem', fontSize: '0.82rem' }}>
                                <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>{row.label}</span>
                                <span style={{ color: 'var(--text-primary)' }}>{formatDate(row.value)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="surface-muted" style={{ padding: '0.9rem', display: 'grid', gap: '0.7rem' }}>
                <div style={{ display: 'grid', gap: 2 }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>Cancel subscription renewal</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                        Renewal stops at the end of the current billing period. Workspace access continues through the paid period.
                    </div>
                </div>
                <label className="form-group">
                    <span className="form-label">Confirm workspace slug</span>
                    <input
                        className="form-input"
                        value={cancelConfirmation}
                        onChange={(event) => setCancelConfirmation(event.target.value)}
                        placeholder={tenantSlug || 'workspace-slug'}
                        disabled={!canManageAccountLifecycle || loading || action !== null}
                    />
                </label>
                <label className="form-group">
                    <span className="form-label">Reason</span>
                    <input
                        className="form-input"
                        value={cancelReason}
                        onChange={(event) => setCancelReason(event.target.value)}
                        disabled={!canManageAccountLifecycle || loading || action !== null}
                    />
                </label>
                <div>
                    <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => void cancelAccount()}
                        disabled={!canManageAccountLifecycle || loading || action !== null}
                    >
                        {action === 'cancel' ? 'Cancelling...' : 'Cancel renewal'}
                    </button>
                </div>
            </div>

            <div className="surface-muted" style={{ padding: '0.9rem', display: 'grid', gap: '0.7rem', borderColor: '#ffd0da' }}>
                <div style={{ display: 'grid', gap: 2 }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 800, color: '#b4233f' }}>Request account deletion</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                        Deletion disables the tenant, revokes sessions, and starts the retained-record schedule for delayed physical purge.
                    </div>
                </div>
                <label className="form-group">
                    <span className="form-label">Confirm workspace slug</span>
                    <input
                        className="form-input"
                        value={deleteConfirmation}
                        onChange={(event) => setDeleteConfirmation(event.target.value)}
                        placeholder={tenantSlug || 'workspace-slug'}
                        disabled={!canManageAccountLifecycle || loading || action !== null}
                    />
                </label>
                <div>
                    <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => void requestDeletion()}
                        disabled={!canManageAccountLifecycle || loading || action !== null}
                        style={{ borderColor: '#ffd0da', color: '#b4233f' }}
                    >
                        {action === 'delete' ? 'Requesting...' : 'Request deletion'}
                    </button>
                </div>
            </div>

            <button className="btn btn-secondary" type="button" onClick={() => void loadStatus()} disabled={loading || action !== null}>
                {loading ? 'Refreshing...' : 'Refresh account status'}
            </button>
        </div>
    );
}
