import { BadRequestException, Body, Controller, ForbiddenException, Get, Put, Req, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';

type UserRoleValue = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type ShiftApprovalPolicy = 'AUTO_APPROVE' | 'MANAGER_APPROVAL' | 'ADMIN_APPROVAL';

const USER_ROLE: Record<UserRoleValue, UserRoleValue> = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    ADMIN: 'ADMIN',
    MANAGER: 'MANAGER',
    STAFF: 'STAFF',
};

const SHIFT_APPROVAL_POLICY: Record<ShiftApprovalPolicy, ShiftApprovalPolicy> = {
    AUTO_APPROVE: 'AUTO_APPROVE',
    MANAGER_APPROVAL: 'MANAGER_APPROVAL',
    ADMIN_APPROVAL: 'ADMIN_APPROVAL',
};

const WORKSPACE_SETTINGS_KEY = 'workspace_settings';
const DEFAULT_TIMEZONE = 'America/New_York';
const DEFAULT_SESSION_TIMEOUT_MINUTES = 480;
const MIN_SESSION_TIMEOUT_MINUTES = 5;
const MAX_SESSION_TIMEOUT_MINUTES = 1440;

type WorkspaceSettingsJson = {
    general?: {
        timezone?: unknown;
    };
    team?: {
        defaultInviteRole?: unknown;
        shiftApprovalPolicy?: unknown;
    };
    security?: {
        requireMfaForAll?: unknown;
        sessionTimeoutMinutes?: unknown;
        ssoOidcOnly?: unknown;
        oidcIssuerUrl?: unknown;
    };
};

type NormalizedSettings = {
    general: {
        name: string;
        slug: string;
        timezone: string;
    };
    team: {
        defaultInviteRole: 'STAFF' | 'MANAGER';
        shiftApprovalPolicy: ShiftApprovalPolicy;
    };
    security: {
        requireMfaForAll: boolean;
        sessionTimeoutMinutes: number;
        ssoOidcOnly: boolean;
        oidcIssuerUrl: string | null;
    };
};

type WorkspaceTenant = {
    name: string;
    slug: string;
};

type GeneralUpdateBody = {
    name?: unknown;
    slug?: unknown;
    timezone?: unknown;
};

type TeamUpdateBody = {
    defaultInviteRole?: unknown;
    shiftApprovalPolicy?: unknown;
};

type SecurityUpdateBody = {
    requireMfaForAll?: unknown;
    sessionTimeoutMinutes?: unknown;
    ssoOidcOnly?: unknown;
    oidcIssuerUrl?: unknown;
};

@Controller({ path: 'settings', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class SettingsController {
    private prisma = new PrismaClient();

    private assertCanReadSettings(role: unknown): void {
        if (role === USER_ROLE.SUPER_ADMIN || role === USER_ROLE.ADMIN || role === USER_ROLE.MANAGER) {
            return;
        }
        throw new ForbiddenException('Settings are only available to managers and admins.');
    }

    private assertCanWriteSettings(role: unknown): void {
        if (role === USER_ROLE.SUPER_ADMIN || role === USER_ROLE.ADMIN) {
            return;
        }
        throw new ForbiddenException('Settings can only be modified by admins.');
    }

    private parseRequiredString(value: unknown, field: string): string {
        if (typeof value !== 'string') {
            throw new BadRequestException(`${field} must be a string`);
        }
        const trimmed = value.trim();
        if (!trimmed) {
            throw new BadRequestException(`${field} is required`);
        }
        return trimmed;
    }

    private parseOptionalString(value: unknown, field: string): string | undefined {
        if (value === undefined) {
            return undefined;
        }
        return this.parseRequiredString(value, field);
    }

    private parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (typeof value !== 'boolean') {
            throw new BadRequestException(`${field} must be a boolean`);
        }
        return value;
    }

    private parseOptionalPositiveInt(value: unknown, field: string): number | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (typeof value !== 'number' || !Number.isInteger(value)) {
            throw new BadRequestException(`${field} must be an integer`);
        }
        if (value < MIN_SESSION_TIMEOUT_MINUTES || value > MAX_SESSION_TIMEOUT_MINUTES) {
            throw new BadRequestException(`${field} must be between ${MIN_SESSION_TIMEOUT_MINUTES} and ${MAX_SESSION_TIMEOUT_MINUTES}`);
        }
        return value;
    }

    private parseOptionalOidcIssuerUrl(value: unknown): string | null | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (value === null) {
            return null;
        }
        if (typeof value !== 'string') {
            throw new BadRequestException('oidcIssuerUrl must be a string or null');
        }

        const trimmed = value.trim();
        if (!trimmed) {
            throw new BadRequestException('oidcIssuerUrl cannot be empty');
        }

        let parsed: URL;
        try {
            parsed = new URL(trimmed);
        } catch {
            throw new BadRequestException('oidcIssuerUrl must be a valid http or https URL');
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new BadRequestException('oidcIssuerUrl must be a valid http or https URL');
        }

        return trimmed;
    }

    private normalizeSettings(
        tenant: WorkspaceTenant,
        value: unknown,
    ): NormalizedSettings {
        const raw = value && typeof value === 'object' && !Array.isArray(value)
            ? (value as WorkspaceSettingsJson)
            : {};

        const timezone = typeof raw.general?.timezone === 'string' && raw.general.timezone.trim()
            ? raw.general.timezone.trim()
            : DEFAULT_TIMEZONE;

        const defaultInviteRole = raw.team?.defaultInviteRole === USER_ROLE.MANAGER
            ? 'MANAGER'
            : raw.team?.defaultInviteRole === USER_ROLE.STAFF
                ? 'STAFF'
                : 'STAFF';

        const shiftApprovalPolicy = raw.team?.shiftApprovalPolicy === SHIFT_APPROVAL_POLICY.AUTO_APPROVE
            ? 'AUTO_APPROVE'
            : raw.team?.shiftApprovalPolicy === SHIFT_APPROVAL_POLICY.ADMIN_APPROVAL
                ? 'ADMIN_APPROVAL'
                : 'MANAGER_APPROVAL';

        const requireMfaForAll = raw.security?.requireMfaForAll === true;

        const sessionTimeoutMinutes = typeof raw.security?.sessionTimeoutMinutes === 'number' && Number.isInteger(raw.security.sessionTimeoutMinutes)
            && raw.security.sessionTimeoutMinutes >= MIN_SESSION_TIMEOUT_MINUTES
            && raw.security.sessionTimeoutMinutes <= MAX_SESSION_TIMEOUT_MINUTES
            ? raw.security.sessionTimeoutMinutes
            : DEFAULT_SESSION_TIMEOUT_MINUTES;

        const ssoOidcOnly = raw.security?.ssoOidcOnly === true;

        const oidcIssuerUrl = this.normalizeOidcIssuerUrl(raw.security?.oidcIssuerUrl);

        return {
            general: {
                name: tenant.name,
                slug: tenant.slug,
                timezone,
            },
            team: {
                defaultInviteRole,
                shiftApprovalPolicy,
            },
            security: {
                requireMfaForAll,
                sessionTimeoutMinutes,
                ssoOidcOnly,
                oidcIssuerUrl,
            },
        };
    }

    private normalizeOidcIssuerUrl(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null;
        }

        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        try {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return null;
            }
            return trimmed;
        } catch {
            return null;
        }
    }

    private async readNormalizedSettings(client: any, tenantId: string): Promise<NormalizedSettings> {
        const [tenant, setting] = await Promise.all([
            client.tenant.findUniqueOrThrow({
                where: { id: tenantId },
                select: {
                    name: true,
                    slug: true,
                },
            }),
            client.tenantSetting.findUnique({
                where: {
                    tenantId_key: {
                        tenantId,
                        key: WORKSPACE_SETTINGS_KEY,
                    },
                },
                select: {
                    value: true,
                },
            }),
        ]);

        return this.normalizeSettings(
            tenant,
            setting?.value,
        );
    }

    private async persistSettings(
        client: any,
        tenantId: string,
        settings: NormalizedSettings,
    ): Promise<void> {
        await client.tenantSetting.upsert({
            where: {
                tenantId_key: {
                    tenantId,
                    key: WORKSPACE_SETTINGS_KEY,
                },
            },
            create: {
                tenantId,
                key: WORKSPACE_SETTINGS_KEY,
                value: settings as any,
            },
            update: {
                value: settings as any,
            },
        });
    }

    @Get()
    async getSettings(@Req() req: any): Promise<NormalizedSettings> {
        this.assertCanReadSettings(req.user?.role);
        return this.readNormalizedSettings(this.prisma, req.user.tenantId);
    }

    @Put('general')
    async updateGeneral(@Body() body: GeneralUpdateBody, @Req() req: any): Promise<NormalizedSettings> {
        this.assertCanWriteSettings(req.user?.role);

        const name = this.parseOptionalString(body?.name, 'name');
        const slug = this.parseOptionalString(body?.slug, 'slug');
        const timezone = this.parseOptionalString(body?.timezone, 'timezone');

        return this.prisma.$transaction(async (tx: any) => {
            const current = await this.readNormalizedSettings(tx, req.user.tenantId);
            const tenantUpdate: Record<string, string> = {};

            if (name !== undefined) {
                tenantUpdate.name = name;
            }

            if (slug !== undefined) {
                tenantUpdate.slug = slug;
            }

            const tenant = Object.keys(tenantUpdate).length > 0
                ? await tx.tenant.update({
                    where: { id: req.user.tenantId },
                    data: tenantUpdate,
                    select: {
                        name: true,
                        slug: true,
                    },
                })
                : { name: current.general.name, slug: current.general.slug };

            const nextSettings: NormalizedSettings = {
                general: {
                    name: tenant.name,
                    slug: tenant.slug,
                    timezone: timezone ?? current.general.timezone,
                },
                team: current.team,
                security: current.security,
            };

            await this.persistSettings(tx, req.user.tenantId, nextSettings);
            return nextSettings;
        });
    }

    @Put('team')
    async updateTeam(@Body() body: TeamUpdateBody, @Req() req: any): Promise<NormalizedSettings> {
        this.assertCanWriteSettings(req.user?.role);

        const defaultInviteRole = body?.defaultInviteRole === undefined
            ? undefined
            : this.normalizeInviteRole(body.defaultInviteRole);
        const shiftApprovalPolicy = body?.shiftApprovalPolicy === undefined
            ? undefined
            : this.normalizeShiftApprovalPolicy(body.shiftApprovalPolicy);

        return this.prisma.$transaction(async (tx: any) => {
            const current = await this.readNormalizedSettings(tx, req.user.tenantId);
            const nextSettings: NormalizedSettings = {
                general: current.general,
                team: {
                    defaultInviteRole: defaultInviteRole ?? current.team.defaultInviteRole,
                    shiftApprovalPolicy: shiftApprovalPolicy ?? current.team.shiftApprovalPolicy,
                },
                security: current.security,
            };

            await this.persistSettings(tx, req.user.tenantId, nextSettings);
            return nextSettings;
        });
    }

    @Put('security')
    async updateSecurity(@Body() body: SecurityUpdateBody, @Req() req: any): Promise<NormalizedSettings> {
        this.assertCanWriteSettings(req.user?.role);

        const requireMfaForAll = this.parseOptionalBoolean(body?.requireMfaForAll, 'requireMfaForAll');
        const sessionTimeoutMinutes = this.parseOptionalPositiveInt(body?.sessionTimeoutMinutes, 'sessionTimeoutMinutes');
        const ssoOidcOnly = this.parseOptionalBoolean(body?.ssoOidcOnly, 'ssoOidcOnly');
        const oidcIssuerUrl = this.parseOptionalOidcIssuerUrl(body?.oidcIssuerUrl);

        return this.prisma.$transaction(async (tx: any) => {
            const current = await this.readNormalizedSettings(tx, req.user.tenantId);
            const nextSettings: NormalizedSettings = {
                general: current.general,
                team: current.team,
                security: {
                    requireMfaForAll: requireMfaForAll ?? current.security.requireMfaForAll,
                    sessionTimeoutMinutes: sessionTimeoutMinutes ?? current.security.sessionTimeoutMinutes,
                    ssoOidcOnly: ssoOidcOnly ?? current.security.ssoOidcOnly,
                    oidcIssuerUrl: oidcIssuerUrl === undefined ? current.security.oidcIssuerUrl : oidcIssuerUrl,
                },
            };

            await this.persistSettings(tx, req.user.tenantId, nextSettings);
            return nextSettings;
        });
    }

    private normalizeInviteRole(value: unknown): 'STAFF' | 'MANAGER' {
        if (value === USER_ROLE.MANAGER) {
            return 'MANAGER';
        }
        if (value === USER_ROLE.STAFF) {
            return 'STAFF';
        }
        throw new BadRequestException('defaultInviteRole must be STAFF or MANAGER');
    }

    private normalizeShiftApprovalPolicy(value: unknown): ShiftApprovalPolicy {
        if (value === SHIFT_APPROVAL_POLICY.AUTO_APPROVE) {
            return 'AUTO_APPROVE';
        }
        if (value === SHIFT_APPROVAL_POLICY.MANAGER_APPROVAL) {
            return 'MANAGER_APPROVAL';
        }
        if (value === SHIFT_APPROVAL_POLICY.ADMIN_APPROVAL) {
            return 'ADMIN_APPROVAL';
        }
        throw new BadRequestException('shiftApprovalPolicy must be AUTO_APPROVE, MANAGER_APPROVAL, or ADMIN_APPROVAL');
    }
}
