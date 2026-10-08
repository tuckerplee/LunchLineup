import { BadRequestException, Body, Controller, ForbiddenException, Get, Optional, Put, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { isCurrentMfaObservation, type MfaSessionIdentity, type MfaVerificationObservation } from '@lunchlineup/rbac';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { RbacService } from '../auth/rbac.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';

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

type SecurityPolicyAuditValue = {
    requireMfaForAll: boolean;
    sessionTimeoutMinutes: number;
    ssoOidcOnly: boolean;
    oidcIssuerConfigured: boolean;
};

@Controller({ path: 'settings', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class SettingsController {
    private readonly tenantDb: TenantPrismaService;
    private readonly rbacService: RbacService;

    constructor(@Optional() tenantDb?: TenantPrismaService, @Optional() rbacService?: RbacService,
        @Optional() private readonly authService?: AuthService) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
        this.rbacService = rbacService ?? new RbacService(this.tenantDb);
    }

    private assertCanReadSettings(permissions: unknown): void {
        if (Array.isArray(permissions) && permissions.includes('settings:read')) {
            return;
        }
        throw new ForbiddenException('Settings are only available to authorized users.');
    }

    private assertCanWriteSettings(permissions: unknown): void {
        if (Array.isArray(permissions) && permissions.includes('settings:write')) {
            return;
        }
        throw new ForbiddenException('Settings can only be modified by authorized users.');
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

    private isTruthyEnv(value: string | undefined): boolean {
        return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
    }

    private hasRequiredOidcValue(value: string | undefined): boolean {
        return typeof value === 'string' && value.trim().length > 0;
    }

    private assertOidcAvailableForSsoOnly(): void {
        const apiOidcEnabled = this.isTruthyEnv(process.env.OIDC_ENABLED);
        const webOidcEnabled = this.isTruthyEnv(process.env.NEXT_PUBLIC_OIDC_ENABLED);
        const hasApiConfig = [
            process.env.OIDC_ISSUER_URL,
            process.env.OIDC_CLIENT_ID,
            process.env.OIDC_CLIENT_SECRET,
            process.env.OIDC_REDIRECT_URI,
        ].every((value) => this.hasRequiredOidcValue(value));

        if (!apiOidcEnabled || !webOidcEnabled || !hasApiConfig) {
            throw new BadRequestException('SSO-only login requires OIDC to be enabled and configured for both API and web.');
        }
    }

    private securityPolicyAuditValue(settings: NormalizedSettings['security']): SecurityPolicyAuditValue {
        return {
            requireMfaForAll: settings.requireMfaForAll,
            sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
            ssoOidcOnly: settings.ssoOidcOnly,
            oidcIssuerConfigured: settings.oidcIssuerUrl !== null,
        };
    }

    private securityPolicyChanged(before: SecurityPolicyAuditValue, after: SecurityPolicyAuditValue): boolean {
        return Object.keys(before).some((key) => (
            before[key as keyof SecurityPolicyAuditValue] !== after[key as keyof SecurityPolicyAuditValue]
        ));
    }

    private async readNormalizedSettings(client: TenantPrismaTransaction, tenantId: string): Promise<NormalizedSettings> {
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
        client: TenantPrismaTransaction,
        tenantId: string,
        settings: NormalizedSettings,
        assertCurrent: () => void,
    ): Promise<void> {
        assertCurrent();
        // Commit an actual tuple version with the child policy while preserving
        // business values. Waiting Serializable authority readers must retry
        // instead of proceeding with an older workspace_settings snapshot.
        const fenced = await client.$executeRaw`
            UPDATE "Tenant" SET "updatedAt" = "updatedAt" WHERE "id" = ${tenantId}
        `;
        assertCurrent();
        if (fenced !== 1) throw new ServiceUnavailableException('Workspace settings could not be saved');
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
        assertCurrent();
    }

    private async authorizeSettingsWrite(client: TenantPrismaTransaction, tenantId: string, actor: any): Promise<{
        current: NormalizedSettings; expiresAtEpochMs: number;
    }> {
        // The shared helper obtains Tenant first, preserving aggregate/policy
        // serialization, then rechecks the exact session and live role grants.
        await this.rbacService.authorizeSelfSecurityMutationInTransaction(client, tenantId, {
            actorUserId: actor?.sub,
            actorSessionId: actor?.sessionId,
            requiredPermission: 'settings:write',
        });

        const user = await client.user.findFirst({
            where: { id: actor.sub.trim(), tenantId, deletedAt: null, suspendedAt: null },
            select: { pinResetRequired: true },
        });
        if (!user) throw new ForbiddenException('User account is inactive');
        if (user.pinResetRequired) throw new ForbiddenException('PIN rotation required');

        // A request guard can precede a Tenant/Session/role lock wait. Recheck
        // workspace eligibility and the effective lifetime under those locks,
        // using the current policy rather than the proposed security update.
        const tenant = await client.tenant.findUnique({
            where: { id: tenantId },
            select: { status: true, deletedAt: true },
        });
        if (!tenant || tenant.deletedAt || tenant.status === 'SUSPENDED' || tenant.status === 'PURGED') {
            throw new ForbiddenException('Workspace is no longer active');
        }
        const current = await this.readNormalizedSettings(client, tenantId);
        const session = await client.session.findFirst({
            where: { id: actor.sessionId.trim(), userId: actor.sub.trim() },
            select: { createdAt: true, expiresAt: true, revokedAt: true },
        });
        const expiresAtEpochMs = session ? Math.min(
            session.expiresAt.getTime(),
            session.createdAt.getTime() + current.security.sessionTimeoutMinutes * 60_000,
        ) : NaN;
        if (!session || session.revokedAt || !Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= Date.now()) {
            throw new ForbiddenException('Administrator session is no longer active');
        }
        return { current, expiresAtEpochMs };
    }

    private async writeSettings(
        actor: any,
        operation: (client: TenantPrismaTransaction, current: NormalizedSettings,
            assertCurrent: () => void) => Promise<NormalizedSettings>,
    ): Promise<NormalizedSettings> {
        const identity: MfaSessionIdentity = Object.freeze({ sub: actor?.sub?.trim(), tenantId: actor?.tenantId,
            sessionId: actor?.sessionId?.trim() });
        const observerOwner = this.authService;
        const observe = observerOwner?.observeSessionMfa;
        // Validate database authority without writes before observing Redis.
        await this.tenantDb.withTenant(identity.tenantId, tx => this.authorizeSettingsWrite(tx, identity.tenantId, identity));
        if (typeof observe !== 'function') {
            throw new ServiceUnavailableException('MFA verification is temporarily unavailable');
        }
        let observed: MfaVerificationObservation | null;
        try { observed = await observe.call(observerOwner, { ...identity }); }
        catch { throw new ServiceUnavailableException('MFA verification is temporarily unavailable'); }
        const observation = observed ? Object.freeze({ sub: observed.sub, tenantId: observed.tenantId,
            sessionId: observed.sessionId, expiresAtEpochMs: observed.expiresAtEpochMs,
            expiresAtMonotonicMs: observed.expiresAtMonotonicMs }) : null;
        if (!isCurrentMfaObservation(observation, identity)) throw new ForbiddenException('MFA verification required');
        return this.tenantDb.withTenant(identity.tenantId, async tx => {
            const { current, expiresAtEpochMs } = await this.authorizeSettingsWrite(tx, identity.tenantId, identity);
            // settings:write always requires MFA, even when user/workspace/JWT
            // flags say otherwise. Clock/TTL and exact identity are rechecked
            // after the final Tenant/User/Session/role waits, before any write.
            const assertCurrent = () => {
                if (!Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= Date.now()) {
                    throw new ForbiddenException('Administrator session is no longer active');
                }
                if (!isCurrentMfaObservation(observation, identity)) throw new ForbiddenException('MFA verification required');
            };
            assertCurrent();
            const result = await operation(tx, current, assertCurrent);
            assertCurrent();
            return result;
        });
    }

    @Get()
    @RequirePermission('settings:read')
    async getSettings(@Req() req: any): Promise<NormalizedSettings> {
        this.assertCanReadSettings(req.user?.permissions);
        const tenantId = req.user.tenantId;
        return this.tenantDb.withTenant(tenantId, (tx) => this.readNormalizedSettings(tx, tenantId));
    }

    @Put('general')
    @RequirePermission('settings:write')
    async updateGeneral(@Body() body: GeneralUpdateBody, @Req() req: any): Promise<NormalizedSettings> {
        this.assertCanWriteSettings(req.user?.permissions);

        const name = this.parseOptionalString(body?.name, 'name');
        const slug = this.parseOptionalString(body?.slug, 'slug');
        const timezone = this.parseOptionalString(body?.timezone, 'timezone');

        const tenantId = req.user.tenantId;
        return this.writeSettings(req.user, async (tx, current, assertCurrent) => {
            const tenantUpdate: Record<string, string> = {};

            if (name !== undefined) {
                tenantUpdate.name = name;
            }

            if (slug !== undefined) {
                tenantUpdate.slug = slug;
            }

            assertCurrent();
            const tenant = Object.keys(tenantUpdate).length > 0
                ? await tx.tenant.update({
                    where: { id: tenantId },
                    data: tenantUpdate,
                    select: {
                        name: true,
                        slug: true,
                    },
                })
                : { name: current.general.name, slug: current.general.slug };
            assertCurrent();

            const nextSettings: NormalizedSettings = {
                general: {
                    name: tenant.name,
                    slug: tenant.slug,
                    timezone: timezone ?? current.general.timezone,
                },
                team: current.team,
                security: current.security,
            };

            await this.persistSettings(tx, tenantId, nextSettings, assertCurrent);
            return nextSettings;
        });
    }

    @Put('team')
    @RequirePermission('settings:write')
    async updateTeam(@Body() body: TeamUpdateBody, @Req() req: any): Promise<NormalizedSettings> {
        this.assertCanWriteSettings(req.user?.permissions);

        const defaultInviteRole = body?.defaultInviteRole === undefined
            ? undefined
            : this.normalizeInviteRole(body.defaultInviteRole);
        const shiftApprovalPolicy = body?.shiftApprovalPolicy === undefined
            ? undefined
            : this.normalizeShiftApprovalPolicy(body.shiftApprovalPolicy);

        const tenantId = req.user.tenantId;
        return this.writeSettings(req.user, async (tx, current, assertCurrent) => {
            const nextSettings: NormalizedSettings = {
                general: current.general,
                team: {
                    defaultInviteRole: defaultInviteRole ?? current.team.defaultInviteRole,
                    shiftApprovalPolicy: shiftApprovalPolicy ?? current.team.shiftApprovalPolicy,
                },
                security: current.security,
            };

            await this.persistSettings(tx, tenantId, nextSettings, assertCurrent);
            return nextSettings;
        });
    }

    @Put('security')
    @RequirePermission('settings:write')
    async updateSecurity(@Body() body: SecurityUpdateBody, @Req() req: any): Promise<NormalizedSettings> {
        this.assertCanWriteSettings(req.user?.permissions);

        const requireMfaForAll = this.parseOptionalBoolean(body?.requireMfaForAll, 'requireMfaForAll');
        const sessionTimeoutMinutes = this.parseOptionalPositiveInt(body?.sessionTimeoutMinutes, 'sessionTimeoutMinutes');
        const ssoOidcOnly = this.parseOptionalBoolean(body?.ssoOidcOnly, 'ssoOidcOnly');
        const oidcIssuerUrl = this.parseOptionalOidcIssuerUrl(body?.oidcIssuerUrl);

        const tenantId = req.user.tenantId;
        const actorUserId = typeof req.user?.sub === 'string' ? req.user.sub.trim() : '';
        if (!actorUserId) {
            throw new ForbiddenException('A live actor identity is required to update security settings');
        }

        return this.writeSettings(req.user, async (tx, current, assertCurrent) => {
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

            if (nextSettings.security.ssoOidcOnly) {
                this.assertOidcAvailableForSsoOnly();
            }

            await this.persistSettings(tx, tenantId, nextSettings, assertCurrent);

            const oldValue = this.securityPolicyAuditValue(current.security);
            const newValue = this.securityPolicyAuditValue(nextSettings.security);
            if (this.securityPolicyChanged(oldValue, newValue)) {
                assertCurrent();
                await tx.auditLog.create({
                    data: {
                        tenantId,
                        userId: actorUserId,
                        actorUserId,
                        actorTenantId: tenantId,
                        action: 'SECURITY_POLICY_UPDATED',
                        resource: 'TenantSecurityPolicy',
                        resourceId: tenantId,
                        oldValue,
                        newValue,
                    },
                });
                assertCurrent();
            }
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
