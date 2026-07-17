import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PERMISSION_METADATA_KEY } from '../auth/require-permission.decorator';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { SettingsController } from './settings.controller';

const settingsReadReq = { user: { tenantId: 'tenant-1', role: 'MANAGER', permissions: ['settings:read'] } };
const settingsWriteReq = { user: { sub: 'admin-1', tenantId: 'tenant-1', role: 'ADMIN', permissions: ['settings:read', 'settings:write'] } };
const oidcEnvKeys = [
    'OIDC_ENABLED',
    'NEXT_PUBLIC_OIDC_ENABLED',
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
] as const;
let previousOidcEnv: Record<(typeof oidcEnvKeys)[number], string | undefined>;

function setOidcEnv(overrides: Partial<Record<(typeof oidcEnvKeys)[number], string>> = {}) {
    const values = {
        OIDC_ENABLED: 'true',
        NEXT_PUBLIC_OIDC_ENABLED: 'true',
        OIDC_ISSUER_URL: 'https://auth.example.com',
        OIDC_CLIENT_ID: 'client-1',
        OIDC_CLIENT_SECRET: 'oidc_abcdefghijklmnopqrstuvwxyz1234567890',
        OIDC_REDIRECT_URI: 'https://app.example.com/api/v1/auth/callback',
        ...overrides,
    };
    for (const [key, value] of Object.entries(values)) {
        process.env[key] = value;
    }
}

describe('SettingsController', () => {
    let controller: SettingsController;
    let prisma: any;

    beforeEach(() => {
        previousOidcEnv = Object.fromEntries(
            oidcEnvKeys.map((key) => [key, process.env[key]]),
        ) as Record<(typeof oidcEnvKeys)[number], string | undefined>;
        for (const key of oidcEnvKeys) {
            delete process.env[key];
        }
        prisma = {
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue({
                    name: 'Acme Dining',
                    slug: 'acme-dining',
                }),
                update: vi.fn(),
            },
            tenantSetting: {
                findUnique: vi.fn().mockResolvedValue(null),
                upsert: vi.fn().mockResolvedValue({}),
            },
            auditLog: {
                create: vi.fn().mockResolvedValue({}),
            },
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            $transaction: vi.fn(async (cb: any) => cb(prisma)),
        };
        controller = new SettingsController(new TenantPrismaService(prisma));
    });

    afterEach(() => {
        for (const key of oidcEnvKeys) {
            const value = previousOidcEnv[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        vi.restoreAllMocks();
    });

    it('declares RBAC metadata for global guard enforcement', () => {
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, SettingsController.prototype.getSettings)).toBe('settings:read');
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, SettingsController.prototype.updateGeneral)).toBe('settings:write');
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, SettingsController.prototype.updateTeam)).toBe('settings:write');
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, SettingsController.prototype.updateSecurity)).toBe('settings:write');
    });

    it('returns normalized settings for managers', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                general: { timezone: 'America/Chicago' },
                team: {
                    defaultInviteRole: 'MANAGER',
                    shiftApprovalPolicy: 'AUTO_APPROVE',
                },
                security: {
                    requireMfaForAll: true,
                    sessionTimeoutMinutes: 60,
                    ssoOidcOnly: false,
                    oidcIssuerUrl: 'https://login.example.com',
                },
            },
        });

        const result = await controller.getSettings(settingsReadReq);

        expect(prisma.tenant.findUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { name: true, slug: true },
        });
        expect(prisma.$transaction).toHaveBeenCalledOnce();
        expect(prisma.$executeRaw).toHaveBeenCalledOnce();
        expect(result).toEqual({
            general: {
                name: 'Acme Dining',
                slug: 'acme-dining',
                timezone: 'America/Chicago',
            },
            team: {
                defaultInviteRole: 'MANAGER',
                shiftApprovalPolicy: 'AUTO_APPROVE',
            },
            security: {
                requireMfaForAll: true,
                sessionTimeoutMinutes: 60,
                ssoOidcOnly: false,
                oidcIssuerUrl: 'https://login.example.com',
            },
        });
    });

    it('updates tenant general settings for admins', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                general: { timezone: 'America/Chicago' },
                team: {
                    defaultInviteRole: 'STAFF',
                    shiftApprovalPolicy: 'MANAGER_APPROVAL',
                },
                security: {
                    requireMfaForAll: false,
                    sessionTimeoutMinutes: 480,
                    ssoOidcOnly: false,
                    oidcIssuerUrl: null,
                },
            },
        });
        prisma.tenant.update.mockResolvedValue({
            name: 'Acme HQ',
            slug: 'acme-hq',
        });

        const result = await controller.updateGeneral(
            { name: 'Acme HQ', slug: 'acme-hq', timezone: 'America/Los_Angeles' },
            settingsWriteReq,
        );

        expect(prisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                name: 'Acme HQ',
                slug: 'acme-hq',
            },
            select: {
                name: true,
                slug: true,
            },
        });
        expect(prisma.tenantSetting.upsert).toHaveBeenCalledWith({
            where: {
                tenantId_key: {
                    tenantId: 'tenant-1',
                    key: 'workspace_settings',
                },
            },
            create: {
                tenantId: 'tenant-1',
                key: 'workspace_settings',
                value: {
                    general: {
                        name: 'Acme HQ',
                        slug: 'acme-hq',
                        timezone: 'America/Los_Angeles',
                    },
                    team: {
                        defaultInviteRole: 'STAFF',
                        shiftApprovalPolicy: 'MANAGER_APPROVAL',
                    },
                    security: {
                        requireMfaForAll: false,
                        sessionTimeoutMinutes: 480,
                        ssoOidcOnly: false,
                        oidcIssuerUrl: null,
                    },
                },
            },
            update: {
                value: {
                    general: {
                        name: 'Acme HQ',
                        slug: 'acme-hq',
                        timezone: 'America/Los_Angeles',
                    },
                    team: {
                        defaultInviteRole: 'STAFF',
                        shiftApprovalPolicy: 'MANAGER_APPROVAL',
                    },
                    security: {
                        requireMfaForAll: false,
                        sessionTimeoutMinutes: 480,
                        ssoOidcOnly: false,
                        oidcIssuerUrl: null,
                    },
                },
            },
        });
        expect(result.general).toEqual({
            name: 'Acme HQ',
            slug: 'acme-hq',
            timezone: 'America/Los_Angeles',
        });
    });

    it('updates team defaults for super admins', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                general: { timezone: 'America/New_York' },
                team: {
                    defaultInviteRole: 'STAFF',
                    shiftApprovalPolicy: 'MANAGER_APPROVAL',
                },
                security: {
                    requireMfaForAll: false,
                    sessionTimeoutMinutes: 480,
                    ssoOidcOnly: false,
                    oidcIssuerUrl: null,
                },
            },
        });

        const result = await controller.updateTeam(
            { defaultInviteRole: 'MANAGER', shiftApprovalPolicy: 'ADMIN_APPROVAL' },
            settingsWriteReq,
        );

        expect(prisma.tenantSetting.upsert).toHaveBeenCalledWith({
            where: {
                tenantId_key: {
                    tenantId: 'tenant-1',
                    key: 'workspace_settings',
                },
            },
            create: {
                tenantId: 'tenant-1',
                key: 'workspace_settings',
                value: {
                    general: {
                        name: 'Acme Dining',
                        slug: 'acme-dining',
                        timezone: 'America/New_York',
                    },
                    team: {
                        defaultInviteRole: 'MANAGER',
                        shiftApprovalPolicy: 'ADMIN_APPROVAL',
                    },
                    security: {
                        requireMfaForAll: false,
                        sessionTimeoutMinutes: 480,
                        ssoOidcOnly: false,
                        oidcIssuerUrl: null,
                    },
                },
            },
            update: {
                value: {
                    general: {
                        name: 'Acme Dining',
                        slug: 'acme-dining',
                        timezone: 'America/New_York',
                    },
                    team: {
                        defaultInviteRole: 'MANAGER',
                        shiftApprovalPolicy: 'ADMIN_APPROVAL',
                    },
                    security: {
                        requireMfaForAll: false,
                        sessionTimeoutMinutes: 480,
                        ssoOidcOnly: false,
                        oidcIssuerUrl: null,
                    },
                },
            },
        });
        expect(result.team).toEqual({
            defaultInviteRole: 'MANAGER',
            shiftApprovalPolicy: 'ADMIN_APPROVAL',
        });
    });

    it('updates security controls for admins', async () => {
        setOidcEnv();
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                general: { timezone: 'America/New_York' },
                team: {
                    defaultInviteRole: 'STAFF',
                    shiftApprovalPolicy: 'MANAGER_APPROVAL',
                },
                security: {
                    requireMfaForAll: false,
                    sessionTimeoutMinutes: 480,
                    ssoOidcOnly: false,
                    oidcIssuerUrl: null,
                },
            },
        });

        const result = await controller.updateSecurity(
            {
                requireMfaForAll: true,
                sessionTimeoutMinutes: 90,
                ssoOidcOnly: true,
                oidcIssuerUrl: 'https://auth.example.com',
            },
            settingsWriteReq,
        );

        expect(prisma.tenantSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                tenantId_key: {
                    tenantId: 'tenant-1',
                    key: 'workspace_settings',
                },
            },
        }));
        expect(result.security).toEqual({
            requireMfaForAll: true,
            sessionTimeoutMinutes: 90,
            ssoOidcOnly: true,
            oidcIssuerUrl: 'https://auth.example.com',
        });
    });

    it('writes the security policy audit through the same active tenant transaction', async () => {
        setOidcEnv();
        let transactionActive = false;
        const transactionAuditCreate = vi.fn(async (_input: unknown) => {
            expect(transactionActive).toBe(true);
            return {};
        });
        const transactionSettingsUpsert = vi.fn(async () => {
            expect(transactionActive).toBe(true);
            return {};
        });
        const tx = {
            ...prisma,
            tenantSetting: {
                findUnique: vi.fn().mockResolvedValue({
                    value: {
                        general: { timezone: 'America/New_York' },
                        team: { defaultInviteRole: 'STAFF', shiftApprovalPolicy: 'MANAGER_APPROVAL' },
                        security: {
                            requireMfaForAll: false,
                            sessionTimeoutMinutes: 480,
                            ssoOidcOnly: false,
                            oidcIssuerUrl: null,
                            clientSecret: 'must-never-be-audited',
                        },
                    },
                }),
                upsert: transactionSettingsUpsert,
            },
            auditLog: { create: transactionAuditCreate },
        };
        prisma.$transaction.mockImplementation(async (callback: any) => {
            transactionActive = true;
            try {
                return await callback(tx);
            } finally {
                transactionActive = false;
            }
        });

        await controller.updateSecurity({
            requireMfaForAll: true,
            sessionTimeoutMinutes: 60,
            ssoOidcOnly: true,
            oidcIssuerUrl: 'https://issuer.example.com/path?token=secret-token',
            accessToken: 'must-never-be-audited',
        } as any, settingsWriteReq);

        expect(transactionSettingsUpsert).toHaveBeenCalledOnce();
        expect(transactionAuditCreate).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'admin-1',
                actorUserId: 'admin-1',
                actorTenantId: 'tenant-1',
                action: 'SECURITY_POLICY_UPDATED',
                resource: 'TenantSecurityPolicy',
                resourceId: 'tenant-1',
                oldValue: {
                    requireMfaForAll: false,
                    sessionTimeoutMinutes: 480,
                    ssoOidcOnly: false,
                    oidcIssuerConfigured: false,
                },
                newValue: {
                    requireMfaForAll: true,
                    sessionTimeoutMinutes: 60,
                    ssoOidcOnly: true,
                    oidcIssuerConfigured: true,
                },
            },
        });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();

        const auditMetadata = JSON.stringify(transactionAuditCreate.mock.calls[0][0]);
        expect(auditMetadata.length).toBeLessThan(512);
        expect(auditMetadata).not.toContain('must-never-be-audited');
        expect(auditMetadata).not.toContain('secret-token');
        expect(auditMetadata).not.toContain('issuer.example.com');
    });

    it('does not audit when the effective security policy is unchanged', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                general: { timezone: 'America/New_York' },
                team: { defaultInviteRole: 'STAFF', shiftApprovalPolicy: 'MANAGER_APPROVAL' },
                security: {
                    requireMfaForAll: false,
                    sessionTimeoutMinutes: 480,
                    ssoOidcOnly: false,
                    oidcIssuerUrl: null,
                },
            },
        });

        await controller.updateSecurity({}, settingsWriteReq);

        expect(prisma.tenantSetting.upsert).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('requires the authenticated subject before security settings writes', async () => {
        await expect(controller.updateSecurity({}, {
            user: { tenantId: 'tenant-1', role: 'ADMIN', permissions: ['settings:write'] },
        })).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects enabling SSO-only when API or web OIDC is unavailable', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                general: { timezone: 'America/New_York' },
                team: {
                    defaultInviteRole: 'STAFF',
                    shiftApprovalPolicy: 'MANAGER_APPROVAL',
                },
                security: {
                    requireMfaForAll: false,
                    sessionTimeoutMinutes: 480,
                    ssoOidcOnly: false,
                    oidcIssuerUrl: null,
                },
            },
        });

        await expect(
            controller.updateSecurity(
                { ssoOidcOnly: true },
                settingsWriteReq,
            ),
        ).rejects.toThrow('SSO-only login requires OIDC to be enabled and configured for both API and web.');

        expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
    });

    it('rejects keeping SSO-only enabled when web OIDC is disabled', async () => {
        setOidcEnv({ NEXT_PUBLIC_OIDC_ENABLED: 'false' });
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                general: { timezone: 'America/New_York' },
                team: {
                    defaultInviteRole: 'STAFF',
                    shiftApprovalPolicy: 'MANAGER_APPROVAL',
                },
                security: {
                    requireMfaForAll: false,
                    sessionTimeoutMinutes: 480,
                    ssoOidcOnly: true,
                    oidcIssuerUrl: 'https://auth.example.com',
                },
            },
        });

        await expect(
            controller.updateSecurity(
                { sessionTimeoutMinutes: 120 },
                settingsWriteReq,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
    });

    it('rejects writes for non-admin roles', async () => {
        await expect(
            controller.updateTeam(
                { defaultInviteRole: 'MANAGER' },
                { user: { tenantId: 'tenant-1', role: 'MANAGER' } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
    });

    it('rejects invalid team and security values', async () => {
        await expect(
            controller.updateTeam(
                { defaultInviteRole: 'LEAD' },
                settingsWriteReq,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            controller.updateSecurity(
                {
                    sessionTimeoutMinutes: 0,
                },
                settingsWriteReq,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            controller.updateSecurity(
                {
                    oidcIssuerUrl: 'ftp://issuer.example.com',
                },
                settingsWriteReq,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
