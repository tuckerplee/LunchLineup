import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const panelSource = readFileSync(
    resolve(__dirname, '../../app/dashboard/settings/AccountLifecyclePanel.tsx'),
    'utf8',
);

describe('AccountLifecyclePanel export recovery contract', () => {
    it('recovers requester-visible jobs on mount and keeps active polling uncapped', () => {
        expect(panelSource).toContain(
            "fetchJsonWithSession<AccountExportJobsResponse>('/admin/account/exports')",
        );
        expect(panelSource).toContain('setExportJob(selectRecoverableExportJob(payload.jobs))');
        expect(panelSource).toContain('schedule(EXPORT_POLL_INTERVAL_MS)');
        expect(panelSource).toContain('schedule(EXPORT_RETRY_INTERVAL_MS)');
        expect(panelSource).toContain('window.clearTimeout(timeoutId)');
        expect(panelSource).not.toMatch(/attempt\s*>=\s*300/);
        expect(panelSource).not.toContain('Account export is still running. Try again shortly.');
    });

    it('continues from the recovered status path and preserves server-owned download expiry', () => {
        expect(panelSource).toContain(
            'fetchJsonWithSession<AccountExportJob>(exportStatusPath)',
        );
        expect(panelSource).toContain("job.state === 'ready'");
        expect(panelSource).toContain('formatDate(job.expiresAt)');
        expect(panelSource).toContain('window.location.assign(apiPath(exportJob.downloadPath))');
        expect(panelSource).toContain('Generate new export');
    });
});

describe('AccountLifecyclePanel deletion terminal flow', () => {
    it('uses the DELETE response as the receipt without an authenticated status reload', () => {
        const start = panelSource.indexOf('const finishDeletion = useCallback');
        const end = panelSource.indexOf('return (', start);
        const deletionFlow = panelSource.slice(start, end);

        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect(deletionFlow).toContain("fetchJsonWithSession<AccountDeletionResponse>('/admin/account'");
        expect(deletionFlow).toContain('accountDeletionReceiptFromResponse(result)');
        expect(deletionFlow).toContain("fetch('/auth/logout'");
        expect(deletionFlow).toContain("window.location.replace('/auth/account-deleted')");
        expect(deletionFlow).not.toContain('loadStatus');
        expect(deletionFlow).not.toContain('/admin/account/status');
    });
});

describe('AccountLifecyclePanel scheduled cancellation API contract', () => {
    it('renders the projected effective date and disables duplicate cancellation after status reload', () => {
        expect(panelSource).toContain('cancellationEffectiveAt?: string | null');
        expect(panelSource).toContain(
            "const cancellationScheduled = status?.lifecycleStatus === 'CANCELLATION_SCHEDULED';",
        );
        expect(panelSource).toContain(
            "{ label: 'Cancellation effective', value: formatDate(status?.cancellationEffectiveAt) }",
        );
        expect(panelSource).toContain('Renewal cancellation is scheduled for');
        expect(panelSource).toContain("cancellationScheduled ? 'Cancellation scheduled' : 'Cancel renewal'");
        expect(panelSource.match(/deletionRecorded \|\| cancellationScheduled/g)).toHaveLength(3);
    });

    it('preserves the scheduled projection across the POST response and authoritative status refresh', () => {
        const start = panelSource.indexOf('const cancelAccount = useCallback');
        const end = panelSource.indexOf('const finishDeletion = useCallback', start);
        const cancellationFlow = panelSource.slice(start, end);

        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect(cancellationFlow).toContain("lifecycleStatus: 'CANCELLATION_SCHEDULED'");
        expect(cancellationFlow).toContain(
            'cancellationEffectiveAt: result.cancellationEffectiveAt ?? null',
        );
        expect(cancellationFlow).toContain('await loadStatus()');
    });
});

describe('AccountLifecyclePanel legal-hold privacy contract', () => {
    it('renders only customer-safe hold state', () => {
        expect(panelSource).toContain('legalHold?: {');
        expect(panelSource).toContain('Retention hold active; deletion timelines are paused.');
        expect(panelSource).not.toContain('placedByUserId');
        expect(panelSource).not.toContain('legalHold.reason');
    });
});
