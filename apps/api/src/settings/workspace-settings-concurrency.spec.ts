import { describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { SettingsController } from './settings.controller';
import { WorkspaceSettingsService } from '../../../api-v2/src/settings/settings.service';

type Owner = 'legacy' | 'native';
const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};

// A deterministic READ COMMITTED/row-lock double, not PostgreSQL evidence.
// Transactions overlap; only locks requested by production code or ordinary
// UPDATE/upsert operations serialize. Reads return independent snapshots.
function harness(initiallyMissing = false) {
    const values = new Map<string, any>();
    const tenants = new Map<string, { name: string; slug: string }>();
    const resourceQueues = new Map<string, Promise<void>>();
    const writes = vi.fn(), audits = vi.fn();
    const firstUpsert = deferred(), releaseFirst = deferred(), secondBoundary = deferred();
    let sequence = 0;
    function ensure(tenantId: string) {
        if (!tenants.has(tenantId)) {
            tenants.set(tenantId, { name: 'Original name', slug: 'original' });
            values.set(tenantId, initiallyMissing ? null : {
                general: { timezone: 'America/New_York' },
                team: { defaultInviteRole: 'STAFF', shiftApprovalPolicy: 'MANAGER_APPROVAL' },
                security: { requireMfaForAll: false, sessionTimeoutMinutes: 480, ssoOidcOnly: false },
            });
        }
    }
    async function transaction(tenantId: string, operation: (tx: any) => Promise<any>) {
        ensure(tenantId);
        const number = ++sequence;
        const releases: Array<() => void> = [], held = new Set<string>();
        let draft: any, tenantDraft: { name: string; slug: string } | undefined;
        async function lock(resource: string) {
            if (held.has(resource)) return;
            const prior = resourceQueues.get(resource) ?? Promise.resolve();
            const done = deferred();
            resourceQueues.set(resource, prior.then(() => done.promise));
            await prior;
            held.add(resource);
            releases.push(done.release);
        }
        async function explicitLock(sql: { strings: readonly string[]; values?: unknown[] } | readonly string[], ...args: unknown[]) {
            const text = (Array.isArray(sql) ? sql : (sql as { strings: readonly string[] }).strings).join('');
            const parameters = Array.isArray(sql) ? args : (sql as { values: unknown[] }).values;
            if (text.includes('FROM "Tenant"') && text.includes('FOR UPDATE')) {
                if (number === 2) secondBoundary.release();
                expect(parameters).toEqual([tenantId]);
                await lock(`tenant:${tenantId}`);
            } else if (text.includes('pg_advisory_xact_lock')) {
                if (number === 2) secondBoundary.release();
                await lock(`advisory:${parameters[0]}`);
            }
            return [{ id: tenantId }];
        }
        const readTenant = async ({ where }: { where: { id: string } }) => {
            expect(where).toEqual({ id: tenantId });
            return { ...(tenantDraft ?? tenants.get(tenantId)!) };
        };
        const tx = {
            $queryRaw: explicitLock,
            $executeRaw: explicitLock,
            tenant: {
                findUnique: readTenant,
                findUniqueOrThrow: readTenant,
                update: async ({ where, data }: { where: { id: string }; data: Partial<{ name: string; slug: string }> }) => {
                    expect(where).toEqual({ id: tenantId });
                    await lock(`tenant:${tenantId}`);
                    tenantDraft = { ...tenants.get(tenantId)!, ...data };
                    return { ...tenantDraft };
                },
            },
            tenantSetting: {
                findUnique: async ({ where }: { where: unknown }) => {
                    expect(where).toEqual({ tenantId_key: { tenantId, key: 'workspace_settings' } });
                    if (number === 2) secondBoundary.release();
                    const value = draft ?? values.get(tenantId);
                    return value === null ? null : { value: structuredClone(value) };
                },
                upsert: async ({ where, create, update }: { where: unknown; create: { tenantId: string; key: string; value: any }; update: { value: any } }) => {
                    expect(where).toEqual({ tenantId_key: { tenantId, key: 'workspace_settings' } });
                    expect(create).toMatchObject({ tenantId, key: 'workspace_settings' });
                    expect(create.value).toEqual(update.value);
                    await lock(`setting:${tenantId}`);
                    if (number === 1) { firstUpsert.release(); await releaseFirst.promise; }
                    draft = structuredClone(update.value);
                    writes(tenantId, draft);
                    return { value: structuredClone(draft) };
                },
            },
            auditLog: { create: async ({ data }: { data: { tenantId: string } }) => {
                expect(data.tenantId).toBe(tenantId);
                audits(data);
                return {};
            } },
        };
        try {
            const result = await operation(tx);
            if (draft !== undefined) values.set(tenantId, draft);
            if (tenantDraft) tenants.set(tenantId, tenantDraft);
            return result;
        } finally { for (const release of releases.reverse()) release(); }
    }
    function services(tenantId = 'tenant-1') {
        const req = { user: { sub: 'actor-1', tenantId, permissions: ['settings:read', 'settings:write'] } };
        const identity = { sub: 'actor-1', tenantId, sessionId: 'session-1', role: 'ADMIN', permissions: req.user.permissions };
        const legacy = new SettingsController(new TenantPrismaService({
            $transaction: (operation: (tx: any) => Promise<any>) => transaction(tenantId, operation),
        } as any));
        const native = new WorkspaceSettingsService({
            withTenant: (selected: string, operation: (tx: any) => Promise<any>) => {
                expect(selected).toBe(tenantId);
                return transaction(selected, operation);
            },
        } as never, { oidcSsoAvailable: false });
        return {
            security: (owner: Owner) => owner === 'legacy'
                ? legacy.updateSecurity({ requireMfaForAll: true }, req)
                : native.updateSecurity(identity as never, { requireMfaForAll: true }),
            second: (owner: Owner, section: 'general' | 'team') => {
                const body = section === 'general' ? { name: 'Changed name', timezone: 'America/Chicago' } : { defaultInviteRole: 'MANAGER' as const };
                if (owner === 'legacy') return section === 'general' ? legacy.updateGeneral(body, req) : legacy.updateTeam(body, req);
                return section === 'general' ? native.updateGeneral(identity as never, body) : native.updateTeam(identity as never, body);
            },
            read: () => legacy.getSettings(req),
        };
    }
    return { services, firstUpsert, releaseFirst, secondBoundary, writes, audits };
}

describe('workspace settings cross-owner transaction boundaries', () => {
    for (const missing of [false, true]) for (const firstOwner of ['legacy', 'native'] as const) for (const secondOwner of ['legacy', 'native'] as const) for (const section of ['general', 'team'] as const) {
        it(`preserves Security and ${section} for ${firstOwner}/${secondOwner} with settings ${missing ? 'missing' : 'present'}`, async () => {
            const h = harness(missing), writers = h.services();
            const first = writers.security(firstOwner);
            let second: ReturnType<typeof writers.second> | undefined;
            try {
                await h.firstUpsert.promise;
                second = writers.second(secondOwner, section);
                await h.secondBoundary.promise;
                h.releaseFirst.release();
                await Promise.all([first, second]);
                const stored = await writers.read();
                expect(stored.security.requireMfaForAll).toBe(true);
                if (section === 'team') expect(stored.team.defaultInviteRole).toBe('MANAGER');
                else expect(stored.general).toMatchObject({ name: 'Changed name', timezone: 'America/Chicago' });
                expect(h.audits).toHaveBeenCalledOnce();
            } finally { h.releaseFirst.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
        });
    }

    it('lets an unrelated tenant finish while a settings save holds its Tenant lock', async () => {
        const h = harness(), first = h.services('tenant-a').security('legacy');
        try {
            await h.firstUpsert.promise;
            const other = h.services('tenant-b');
            await other.second('native', 'team');
            expect((await other.read()).team.defaultInviteRole).toBe('MANAGER');
            expect((await other.read()).security.requireMfaForAll).toBe(false);
        } finally { h.releaseFirst.release(); await first; }
    });
});
