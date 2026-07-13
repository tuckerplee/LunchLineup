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