import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SettingsController } from './settings.controller';

describe('SettingsController', () => {
    let controller: SettingsController;
    let prisma: any;

    beforeEach(() => {
        controller = new SettingsController();
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
            $transaction: vi.fn(async (cb: any) => cb(prisma)),
        };
        (controller as any).prisma = prisma;
    });

    afterEach(() => {
        vi.restoreAllMocks();
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

        const result = await controller.getSettings({
            user: {
                tenantId: 'tenant-1',
                role: 'MANAGER',
            },
        });

        expect(prisma.tenant.findUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { name: true, slug: true },
        });
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
            { user: { tenantId: 'tenant-1', role: 'ADMIN' } },
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
            { user: { tenantId: 'tenant-1', role: 'SUPER_ADMIN' } },
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
            { user: { tenantId: 'tenant-1', role: 'ADMIN' } },
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
                { user: { tenantId: 'tenant-1', role: 'ADMIN' } },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            controller.updateSecurity(
                {
                    sessionTimeoutMinutes: 0,
                },
                { user: { tenantId: 'tenant-1', role: 'ADMIN' } },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
            controller.updateSecurity(
                {
                    oidcIssuerUrl: 'ftp://issuer.example.com',
                },
                { user: { tenantId: 'tenant-1', role: 'ADMIN' } },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
