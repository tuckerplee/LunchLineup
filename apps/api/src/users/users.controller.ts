import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, Headers, HttpCode, HttpStatus, HttpException, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Optional } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { AuthService, type SessionRequestAudit } from '../auth/auth.service';
import { AllowAuthenticated } from '../auth/require-permission.decorator';
import { assertTenantCanAddActiveUser } from '../billing/user-capacity';
import {
    canonicalPermissionKey,
    MAX_ROLES_PER_USER,
    migrationSafeRoleName,
    PROTECTED_PERMISSION_KEYS,
    RbacService,
} from '../auth/rbac.service';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import {
    isPrismaUniqueConstraintConflict,
    isSerializableTransactionConflict,
} from '../database/transaction-error';
import { runSerializableMutationWithRetry } from '../auth/serializable-mutation';
import {
    buildBoundedListPage,
    decodeBoundedListCursor,
    parseBoundedListLimit,
} from '../common/bounded-pagination';
import {
    ACTIVE_SCHEDULABLE_USER_FILTER,
    lockTenantSchedulingMutations,
} from '../common/schedulable-user';
import {
    normalizeStaffSchedulingProfile,
    NormalizedStaffSchedulingProfile,
    StaffSchedulingProfileInput,
} from './staff-scheduling-profile';
import { deleteAvailabilityImportStorageKeys } from '../availability-imports/availability-imports.service';
import { anonymizeDeletedUser } from './user-deletion';
import { StaffInvitationOutboxService } from './staff-invitation-outbox.service';

const Permission = (perm: string) => SetMetadata('permission', perm);
type UserRoleValue = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type AccessRole = {
    id: string;
    isSystem?: boolean;
    legacyRole?: string | null;
    rolePermissions: Array<{ permission: { key: string } }>;
};
type LockedSchedulingProfileUser = { id: string; role: UserRoleValue };
type SchedulingAvailabilityWindow = NormalizedStaffSchedulingProfile['availability'][number];
type ChangedAvailabilityScope = { locationId: string | null; days: number[] };
const USER_ROLE: Record<UserRoleValue, UserRoleValue> = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    ADMIN: 'ADMIN',
    MANAGER: 'MANAGER',
    STAFF: 'STAFF',
};

@Controller({ path: 'users', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class UsersController {
    private readonly tenantDb: TenantPrismaService;
    private static readonly USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
    private static readonly PIN_REGEX = /^\d{4,8}$/;
    private static readonly EMAIL_LOGIN_REGEX = /^[a-z0-9.!#$%*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
    private static readonly SYSTEM_EMAIL_DOMAIN = 'staff.lunchlineup.local';
    private static readonly WORKSPACE_SETTINGS_KEY = 'workspace_settings';

    constructor(
        private readonly authService: AuthService,
        private readonly rbacService: RbacService,
        private readonly staffInvitationOutbox: StaffInvitationOutboxService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
    }

    private isSystemGeneratedEmail(email: string): boolean {
        return email.endsWith(`@${UsersController.SYSTEM_EMAIL_DOMAIN}`);
    }

    private sanitizeEmailForResponse(email: string | null): string {
        if (!email) return '';
        return this.isSystemGeneratedEmail(email) ? '' : email;
    }

    private normalizeUsername(username?: string): string | null {
        const normalized = (username ?? '').trim().toLowerCase();
        return normalized || null;
    }

    private isUserRole(value: unknown): value is UserRoleValue {
        return typeof value === 'string' && Object.prototype.hasOwnProperty.call(USER_ROLE, value);
    }

    private parseUserRole(value: unknown): UserRoleValue {
        if (!this.isUserRole(value)) {
            throw new BadRequestException('Invalid user role');
        }
        return value;
    }

    private normalizeRoleIds(value: unknown): string[] {
        if (!Array.isArray(value)) {
            throw new BadRequestException('roleIds must be an array');
        }
        const roleIds = Array.from(new Set(value.map((roleId) => {
            if (typeof roleId !== 'string' || !roleId.trim()) {
                throw new BadRequestException('roleIds must only contain non-empty strings');
            }
            return roleId.trim();
        })));
        if (roleIds.length > MAX_ROLES_PER_USER) {
            throw new BadRequestException(`A user may be assigned at most ${MAX_ROLES_PER_USER} roles`);
        }
        return roleIds;
    }

    private normalizePermissionKeys(value: unknown): string[] {
        if (!Array.isArray(value)) {
            throw new BadRequestException('permissionKeys must be an array');
        }
        return Array.from(new Set(value.map((permissionKey) => {
            if (typeof permissionKey !== 'string' || !permissionKey.trim()) {
                throw new BadRequestException('permissionKeys must only contain non-empty strings');
            }
            return canonicalPermissionKey(permissionKey);
        })));
    }

    private createTemporaryPin(): string {
        return randomInt(100_000, 1_000_000).toString();
    }

    private requestAudit(req: any): SessionRequestAudit {
        const userAgentHeader = req?.headers?.['user-agent'];
        return {
            ipAddress: typeof req?.ip === 'string' ? req.ip : null,
            userAgent: Array.isArray(userAgentHeader)
                ? userAgentHeader[0] ?? null
                : typeof userAgentHeader === 'string'
                    ? userAgentHeader
                    : null,
        };
    }

    private requestSessionId(req: any): string {
        const sessionId = typeof req?.user?.sessionId === 'string' ? req.user.sessionId.trim() : '';
        if (!sessionId) throw new ForbiddenException('A live administrator session is required');
        return sessionId;
    }

    private async withActorAuthorizedSerializableMutation<T>(
        tenantId: string,
        operation: (tx: TenantPrismaTransaction) => Promise<T>,
        conflictMessage = 'Authorization or invitation state changed concurrently; retry the request',
    ): Promise<T> {
        return runSerializableMutationWithRetry(
            () => this.tenantDb.withTenant(
                tenantId,
                operation,
                { isolationLevel: 'Serializable' },
            ),
            { conflictMessage },
        );
    }

    private async resolveInviteRole(tx: TenantPrismaTransaction, tenantId: string, requestedRole?: UserRoleValue): Promise<UserRoleValue> {
        if (requestedRole) {
            return this.parseUserRole(requestedRole);
        }

        const workspaceSettings = await tx.tenantSetting.findUnique({
            where: {
                tenantId_key: {
                    tenantId,
                    key: UsersController.WORKSPACE_SETTINGS_KEY,
                },
            },
            select: { value: true },
        });

        const defaultInviteRole = workspaceSettings?.value && typeof workspaceSettings.value === 'object' && !Array.isArray(workspaceSettings.value)
            ? (workspaceSettings.value as { team?: { defaultInviteRole?: unknown } }).team?.defaultInviteRole
            : undefined;

        if (defaultInviteRole === USER_ROLE.MANAGER) {
            return USER_ROLE.MANAGER;
        }
        if (defaultInviteRole === USER_ROLE.STAFF) {
            return USER_ROLE.STAFF;
        }
        return USER_ROLE.STAFF;
    }

    private isSystemAdminRequest(req: any): boolean {
        return req.user?.legacyRole === USER_ROLE.SUPER_ADMIN
            && Array.isArray(req.user?.roles)
            && req.user.roles.some((role: { isSystem?: boolean; legacyRole?: string | null }) =>
                role.isSystem === true && role.legacyRole === USER_ROLE.SUPER_ADMIN);
    }

    private assertCanDelegateRoles(req: any, roles: AccessRole[]): void {
        const blockedRole = roles.find((role) => !this.canDelegateRole(req, role));
        if (!blockedRole) return;

        const permissionKeys = blockedRole.rolePermissions.map((item) => canonicalPermissionKey(item.permission.key));
        if (!this.isSystemAdminRequest(req)
            && (blockedRole.legacyRole === USER_ROLE.SUPER_ADMIN
                || permissionKeys.some((key) => PROTECTED_PERMISSION_KEYS.has(key)))) {
            throw new ForbiddenException('Only system admins can grant system admin access');
        }
        throw new ForbiddenException('Cannot grant a role with permissions you do not hold');
    }

    private canDelegateRole(req: any, role: AccessRole): boolean {
        const actorPermissions = new Set(
            (Array.isArray(req.user?.permissions) ? req.user.permissions : [])
                .filter((permission: unknown): permission is string => typeof permission === 'string')
                .map(canonicalPermissionKey),
        );
        const isSystemAdmin = this.isSystemAdminRequest(req);

        const permissionKeys = role.rolePermissions.map((item) => canonicalPermissionKey(item.permission.key));
        return (isSystemAdmin
                || (role.legacyRole !== USER_ROLE.SUPER_ADMIN
                    && !permissionKeys.some((key) => PROTECTED_PERMISSION_KEYS.has(key))))
            && permissionKeys.every((key) => actorPermissions.has(key));
    }

    private assertCanUsePermissionKeys(req: any, permissionKeys: string[]): void {
        if (this.isSystemAdminRequest(req)) return;
        if (permissionKeys.some((key) => PROTECTED_PERMISSION_KEYS.has(key))) {
            throw new ForbiddenException('Only system admins can grant protected admin permissions');
        }
    }

    private async lockActiveSchedulingProfileScope(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userId: string,
        locationIds: string[],
    ): Promise<LockedSchedulingProfileUser> {
        const users = await tx.$queryRaw<LockedSchedulingProfileUser[]>(Prisma.sql`
            SELECT "id", "role"
            FROM "User"
            WHERE "id" = ${userId}
              AND "tenantId" = ${tenantId}
              AND "role" IN ('MANAGER'::"UserRole", 'STAFF'::"UserRole")
              AND "deletedAt" IS NULL
              AND "suspendedAt" IS NULL
            FOR UPDATE
        `);
        if (users.length !== 1) throw new NotFoundException('User not found');

        if (locationIds.length === 0) return users[0];
        const locations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id"
            FROM "Location"
            WHERE "tenantId" = ${tenantId}
              AND "id" IN (${Prisma.join(locationIds)})
              AND "deletedAt" IS NULL
            FOR UPDATE
        `);
        if (locations.length !== locationIds.length) {
            throw new BadRequestException('Every availability location must be an active tenant location');
        }
        return users[0];
    }

    private changedAvailabilityScopes(
        existing: SchedulingAvailabilityWindow[],
        replacement: SchedulingAvailabilityWindow[],
    ): ChangedAvailabilityScope[] {
        const rowsByScopeDay = (rows: SchedulingAvailabilityWindow[]) => {
            const grouped = new Map<string, string[]>();
            for (const row of rows) {
                const key = `${row.locationId ?? '*'}:${row.dayOfWeek}`;
                const windows = grouped.get(key) ?? [];
                windows.push(`${row.startTimeMinutes}:${row.endTimeMinutes}`);
                grouped.set(key, windows);
            }
            for (const windows of grouped.values()) windows.sort();
            return grouped;
        };
        const before = rowsByScopeDay(existing);
        const after = rowsByScopeDay(replacement);
        const changedByLocation = new Map<string | null, Set<number>>();
        for (const key of new Set([...before.keys(), ...after.keys()])) {
            if (JSON.stringify(before.get(key) ?? []) === JSON.stringify(after.get(key) ?? [])) continue;
            const separator = key.lastIndexOf(':');
            const rawLocationId = key.slice(0, separator);
            const locationId = rawLocationId === '*' ? null : rawLocationId;
            const days = changedByLocation.get(locationId) ?? new Set<number>();
            const day = Number(key.slice(separator + 1));
            days.add(day);
            const changedWindows = [...(before.get(key) ?? []), ...(after.get(key) ?? [])];
            if (changedWindows.some((window) => {
                const [start, end] = window.split(':').map(Number);
                return end <= start;
            })) {
                days.add((day + 1) % 7);
            }
            changedByLocation.set(locationId, days);
        }
        return Array.from(changedByLocation, ([locationId, days]) => ({
            locationId,
            days: Array.from(days).sort((left, right) => left - right),
        }));
    }

    private async invalidateAffectedDraftSchedules(
        tx: TenantPrismaTransaction,
        tenantId: string,
        changedSkills: string[],
        availabilityScopes: ChangedAvailabilityScope[],
    ): Promise<void> {
        const predicates: Prisma.Sql[] = [];
        if (changedSkills.length > 0) {
            predicates.push(Prisma.sql`TRUE`);
        }
        for (const scope of availabilityScopes) {
            const locationPredicate = scope.locationId === null
                ? Prisma.sql`TRUE`
                : Prisma.sql`schedule."locationId" = ${scope.locationId}`;
            predicates.push(Prisma.sql`
                (${locationPredicate})
                AND EXISTS (
                    SELECT 1
                    FROM generate_series(
                        (schedule."startDate" AT TIME ZONE 'UTC' AT TIME ZONE location."timezone")::date,
                        ((schedule."endDate" - INTERVAL '1 millisecond') AT TIME ZONE 'UTC' AT TIME ZONE location."timezone")::date,
                        INTERVAL '1 day'
                    ) AS local_day
                    WHERE EXTRACT(DOW FROM local_day)::int IN (${Prisma.join(scope.days)})
                )
            `);
        }
        if (predicates.length === 0) return;

        const affected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT schedule."id"
            FROM "Schedule" schedule
            JOIN "Location" location
              ON location."id" = schedule."locationId"
             AND location."tenantId" = schedule."tenantId"
             AND location."deletedAt" IS NULL
            WHERE schedule."tenantId" = ${tenantId}
              AND schedule."status" = 'DRAFT'
              AND schedule."deletedAt" IS NULL
              AND (${Prisma.join(predicates, ' OR ')})
            ORDER BY schedule."id" ASC
            FOR UPDATE OF schedule
        `);
        const scheduleIds = affected.map((schedule) => schedule.id);
        if (scheduleIds.length === 0) return;
        await tx.schedule.updateMany({
            where: {
                id: { in: scheduleIds },
                tenantId,
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
    }

    @Get()
    @Permission('users:read')
    async findAll(
        @Req() req: any,
        @Query('locationId') _locationId?: string,
        @Query('limit') limitValue?: string,
        @Query('cursor') cursorValue?: string,
    ) {
        const tenantId = req.user.tenantId;
        const limit = parseBoundedListLimit(limitValue);
        const cursor = decodeBoundedListCursor(cursorValue);
        await this.rbacService.ensureTenantRoles(tenantId);
        const { page, roleAssignmentsByUser, summary } = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const where: Prisma.UserWhereInput = { tenantId, deletedAt: null };
            if (cursor) {
                where.OR = [
                    { createdAt: { gt: cursor.timestamp } },
                    { createdAt: cursor.timestamp, id: { gt: cursor.id } },
                ];
            }
            const summary = cursor ? undefined : await this.userDirectorySummary(tx, tenantId);
            const rows = await tx.user.findMany({
                where,
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: limit + 1,
                select: {
                    id: true,
                    createdAt: true,
                    name: true,
                    email: true,
                    username: true,
                    role: true,
                    pinHash: true,
                    pinResetRequired: true,
                },
            });
            const page = buildBoundedListPage(rows, limit, (user) => user.createdAt, {});
            const assignments = page.data.length === 0
                ? []
                : await tx.roleAssignment.findMany({
                    where: {
                        tenantId,
                        userId: { in: page.data.map((user) => user.id) },
                        role: { tenantId, deletedAt: null },
                    },
                    orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
                    select: {
                        userId: true,
                        role: {
                            select: {
                                id: true,
                                name: true,
                                description: true,
                                isSystem: true,
                                legacyRole: true,
                                rolePermissions: {
                                    select: { permission: { select: { key: true } } },
                                },
                            },
                        },
                    },
                });
            const roleAssignmentsByUser = new Map<string, Array<{
                id: string;
                name: string;
                description: string | null;
                isSystem: boolean;
                legacyRole: UserRoleValue | null;
                permissions: string[];
            }>>();
            for (const assignment of assignments) {
                const roles = roleAssignmentsByUser.get(assignment.userId) ?? [];
                roles.push({
                    id: assignment.role.id,
                    name: migrationSafeRoleName(assignment.role.name),
                    description: assignment.role.description,
                    isSystem: assignment.role.isSystem,
                    legacyRole: assignment.role.legacyRole,
                    permissions: assignment.role.rolePermissions
                        .map((item) => item.permission.key)
                        .sort(),
                });
                roleAssignmentsByUser.set(assignment.userId, roles);
            }
            return { page, roleAssignmentsByUser, summary };
        });

        return {
            ...page,
            data: page.data.map((user) => ({
                id: user.id,
                name: user.name,
                email: this.sanitizeEmailForResponse(user.email),
                username: user.username ?? '',
                role: user.role,
                pinEnabled: Boolean(user.pinHash),
                pinResetRequired: Boolean(user.pinResetRequired),
                assignedRoles: roleAssignmentsByUser.get(user.id) ?? [],
            })),
            tenantId,
            ...(summary ? { summary } : {}),
        };
    }

    private async userDirectorySummary(tx: TenantPrismaTransaction, tenantId: string) {
        const [summary] = await tx.$queryRaw<Array<{
            totalUsers: number | bigint;
            staffCount: number | bigint;
            managerCount: number | bigint;
            privilegedUsers: number | bigint;
            pinAccounts: number | bigint;
        }>>(Prisma.sql`
            SELECT
                COUNT(*)::int AS "totalUsers",
                COUNT(*) FILTER (WHERE user_row."role" IN ('MANAGER', 'STAFF'))::int AS "staffCount",
                COUNT(*) FILTER (WHERE user_row."role" = 'MANAGER')::int AS "managerCount",
                COUNT(*) FILTER (
                    WHERE user_row."role" IN ('SUPER_ADMIN', 'ADMIN')
                       OR EXISTS (
                            SELECT 1
                            FROM "RoleAssignment" assignment
                            JOIN "Role" role
                              ON role."id" = assignment."roleId"
                             AND role."tenantId" = assignment."tenantId"
                             AND role."deletedAt" IS NULL
                            JOIN "RolePermission" role_permission
                              ON role_permission."roleId" = role."id"
                            JOIN "Permission" permission
                              ON permission."id" = role_permission."permissionId"
                            WHERE assignment."tenantId" = user_row."tenantId"
                              AND assignment."userId" = user_row."id"
                              AND permission."key" IN ('roles:assign', 'users:admin')
                       )
                )::int AS "privilegedUsers",
                COUNT(*) FILTER (WHERE user_row."username" IS NOT NULL)::int AS "pinAccounts"
            FROM "User" user_row
            WHERE user_row."tenantId" = ${tenantId}
              AND user_row."deletedAt" IS NULL
        `);

        return {
            totalUsers: Number(summary?.totalUsers ?? 0),
            staffCount: Number(summary?.staffCount ?? 0),
            managerCount: Number(summary?.managerCount ?? 0),
            privilegedUsers: Number(summary?.privilegedUsers ?? 0),
            pinAccounts: Number(summary?.pinAccounts ?? 0),
        };
    }
    @Get('access/catalog')
    @Permission('roles:read')
    async accessCatalog(@Req() req: any) {
        const tenantId = req.user.tenantId;
        const [permissions, roles, configuredInviteRole] = await Promise.all([
            this.rbacService.listPermissions(),
            this.rbacService.listRolesForTenant(tenantId),
            this.tenantDb.withTenant(tenantId, (tx) => this.resolveInviteRole(tx, tenantId)),
        ]);
        const delegableRoles = roles.filter((role) => this.canDelegateRole(req, role));
        const defaultInviteRole = delegableRoles.find((role) => role.legacyRole === configuredInviteRole)
            ?? delegableRoles.find((role) => role.legacyRole === USER_ROLE.STAFF)
            ?? delegableRoles[0];

        return {
            permissions: permissions.map((permission) => ({
                key: permission.key,
                label: permission.label,
                description: permission.description,
                category: permission.category,
            })),
            defaultInviteRoleId: defaultInviteRole?.id ?? null,
            roles: roles.map((role) => ({
                id: role.id,
                name: role.name,
                slug: role.slug,
                description: role.description,
                isSystem: role.isSystem,
                isDefault: role.isDefault,
                legacyRole: role.legacyRole,
                userCount: role._count.assignments,
                permissions: role.rolePermissions.map((item) => item.permission.key).sort(),
                canDelegate: this.canDelegateRole(req, role),
            })),
        };
    }

    @Get(':id/scheduling-profile')
    @Permission('users:read')
    async schedulingProfile(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const user = await tx.user.findFirst({
                where: { id, tenantId, ...ACTIVE_SCHEDULABLE_USER_FILTER },
                select: { id: true, name: true },
            });
            if (!user) throw new NotFoundException('User not found');

            const [skills, availability] = await Promise.all([
                tx.staffSkill.findMany({
                    where: { tenantId, userId: user.id },
                    select: { skill: true },
                    orderBy: { skill: 'asc' },
                }),
                tx.staffAvailability.findMany({
                    where: { tenantId, userId: user.id },
                    select: {
                        locationId: true,
                        dayOfWeek: true,
                        startTimeMinutes: true,
                        endTimeMinutes: true,
                    },
                    orderBy: [
                        { dayOfWeek: 'asc' },
                        { startTimeMinutes: 'asc' },
                        { locationId: 'asc' },
                    ],
                }),
            ]);
            return {
                user,
                skills: skills.map((entry) => entry.skill),
                availability,
                availabilityConfigured: availability.length > 0,
            };
        });
    }

    @Put(':id/scheduling-profile')
    @Permission('users:write')
    async replaceSchedulingProfile(
        @Param('id') id: string,
        @Body() body: StaffSchedulingProfileInput,
        @Req() req: any,
    ) {
        const tenantId = req.user.tenantId;
        const profile = normalizeStaffSchedulingProfile(body);
        const locationIds = Array.from(new Set(
            profile.availability
                .map((window) => window.locationId)
                .filter((locationId): locationId is string => Boolean(locationId)),
        ));

        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await lockTenantSchedulingMutations(tx, tenantId);
            await this.lockActiveSchedulingProfileScope(tx, tenantId, id, locationIds);
            const [existingSkills, existingAvailability] = await Promise.all([
                tx.staffSkill.findMany({
                    where: { tenantId, userId: id },
                    select: { skill: true },
                    orderBy: { skill: 'asc' },
                }),
                tx.staffAvailability.findMany({
                    where: { tenantId, userId: id },
                    select: {
                        locationId: true,
                        dayOfWeek: true,
                        startTimeMinutes: true,
                        endTimeMinutes: true,
                    },
                }),
            ]);
            const previousSkills = existingSkills.map((entry) => entry.skill).sort();
            const changedSkills = Array.from(new Set([
                ...previousSkills.filter((skill) => !profile.skills.includes(skill)),
                ...profile.skills.filter((skill) => !previousSkills.includes(skill)),
            ])).sort();
            const availabilityScopes = this.changedAvailabilityScopes(
                existingAvailability,
                profile.availability,
            );
            await this.invalidateAffectedDraftSchedules(
                tx,
                tenantId,
                changedSkills,
                availabilityScopes,
            );
            await tx.staffAvailability.deleteMany({ where: { tenantId, userId: id } });
            await tx.staffSkill.deleteMany({ where: { tenantId, userId: id } });
            if (profile.skills.length > 0) {
                await tx.staffSkill.createMany({
                    data: profile.skills.map((skill) => ({ tenantId, userId: id, skill })),
                });
            }
            if (profile.availability.length > 0) {
                await tx.staffAvailability.createMany({
                    data: profile.availability.map((window) => ({ tenantId, userId: id, ...window })),
                });
            }
            return {
                user: { id },
                ...profile,
                availabilityConfigured: profile.availability.length > 0,
            };
        });
    }

    private async invalidateArchivedUserAuthState(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userId: string,
        now: Date,
    ): Promise<void> {
        await tx.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: now },
        });
        await tx.passwordResetToken.updateMany({
            where: { tenantId, userId, consumedAt: null },
            data: { consumedAt: now },
        });
        await tx.passwordResetEmailOutbox.updateMany({
            where: {
                tenantId,
                userId,
                status: { in: ['PENDING', 'SENDING', 'FAILED'] },
            },
            data: {
                status: 'DEAD_LETTERED',
                deadLetteredAt: now,
                leaseUntil: null,
                lastError: 'User credentials reprovisioned',
            },
        });
        await tx.mfaTotpClaim.deleteMany({
            where: { tenantId, userId },
        });
    }

    @Get(':id')
    @Permission('users:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const user = await this.tenantDb.withTenant(tenantId, (tx) => tx.user.findFirst({
            where: { id, tenantId, deletedAt: null }
        }));
        if (!user) throw new NotFoundException('User not found');
        const assignedRoles = await this.rbacService.getUserRoleAssignments(user.id, tenantId);
        return {
            id: user.id,
            name: user.name,
            email: this.sanitizeEmailForResponse(user.email),
            username: user.username ?? '',
            role: user.role,
            pinEnabled: Boolean(user.pinHash),
            pinResetRequired: Boolean(user.pinResetRequired),
            assignedRoles,
        };
    }

    @Post('invite')
    @Permission('users:write')
    async invite(@Body() body: { email?: string; username?: string; pin?: string; name: string; role?: UserRoleValue; roleId?: string }, @Req() req: any) {
        const normalizedName = (body.name || '').trim();
        const normalizedEmail = (body.email || '').trim().toLowerCase();
        const normalizedUsername = this.normalizeUsername(body.username);
        const normalizedPin = (body.pin || '').trim();
        const hasEmail = Boolean(normalizedEmail);
        const hasUsername = Boolean(normalizedUsername);

        if (!normalizedName) {
            throw new BadRequestException('Name is required');
        }

        if (!hasEmail && !hasUsername) {
            throw new BadRequestException('Provide either email or username');
        }

        if (normalizedEmail && !UsersController.EMAIL_LOGIN_REGEX.test(normalizedEmail)) {
            throw new BadRequestException('Invalid email address');
        }

        if (normalizedUsername && !UsersController.USERNAME_REGEX.test(normalizedUsername)) {
            throw new BadRequestException('Username must be 3-32 chars using lowercase letters, numbers, ., _, -');
        }

        if (normalizedPin && !UsersController.PIN_REGEX.test(normalizedPin)) {
            throw new BadRequestException('PIN must be 4-8 numeric digits');
        }

        if (normalizedEmail && normalizedUsername) {
            throw new BadRequestException('Choose email login or username login, not both');
        }

        const tenantId = req.user.tenantId;

        const requestedRoleId = (body.roleId || '').trim();
        const actorSessionId = this.requestSessionId(req);
        const { user, temporaryPin, invitationDelivery } = await this.withActorAuthorizedSerializableMutation(
            tenantId,
            async (tx) => {
            await assertTenantCanAddActiveUser(tx as any, tenantId);
            const requestedLegacyRole = requestedRoleId
                ? null
                : await this.resolveInviteRole(tx, tenantId, body.role);
            const archivedUser = await tx.user.findFirst({
                where: {
                    tenantId,
                    deletedAt: { not: null },
                    ...(normalizedEmail
                        ? { email: normalizedEmail }
                        : { username: normalizedUsername }),
                },
                select: { id: true },
            });
            const selectedRole = await this.rbacService.authorizeUserInvitationInTransaction(
                tx,
                tenantId,
                {
                    actorUserId: req.user.sub,
                    actorSessionId,
                    targetUserId: archivedUser?.id,
                    requestedRoleId: requestedRoleId || undefined,
                    requestedLegacyRole: requestedLegacyRole ?? undefined,
                },
            );

            const selectedPermissions = selectedRole.rolePermissions.map((item) => item.permission.key);
            const allowsEmail = selectedPermissions.includes('auth:login_email');
            const allowsPin = selectedPermissions.includes('auth:login_pin');
            const selectedLegacyRole = this.isUserRole(selectedRole.legacyRole)
                ? selectedRole.legacyRole
                : USER_ROLE.STAFF;

            if (hasEmail && !allowsEmail) {
                throw new BadRequestException('Email login is not enabled for the selected role');
            }
            if (!allowsPin && hasUsername) {
                throw new BadRequestException('Username and PIN login is not enabled for the selected role');
            }

            const identityData = {
                email: normalizedEmail || null,
                username: normalizedUsername,
                name: normalizedName,
                role: selectedLegacyRole,
            };
            const now = new Date();
            const temporaryPin = normalizedUsername
                ? normalizedPin || this.createTemporaryPin()
                : null;
            const pinCredentialData = temporaryPin
                ? this.authService.buildPinCredentialData(temporaryPin, !normalizedPin, now)
                : {
                    pinHash: null,
                    pinSetAt: null,
                    pinResetRequired: false,
                    pinLoginAttempts: 0,
                    pinLockedUntil: null,
                };
            const credentialData = {
                passwordHash: null,
                oidcIssuer: null,
                oidcSubject: null,
                mfaEnabled: false,
                mfaSecret: null,
                mfaBackupCodes: [],
                loginAttempts: 0,
                lockedUntil: null,
                lastLoginAt: null,
                ...pinCredentialData,
            };
            const user = archivedUser
                ? await tx.user.update({
                    where: { id: archivedUser.id },
                    data: {
                        ...identityData,
                        ...credentialData,
                        deletedAt: null,
                    },
                })
                : await tx.user.create({
                    data: {
                        tenantId,
                        ...identityData,
                        ...(temporaryPin ? pinCredentialData : {}),
                    },
                });

            await this.rbacService.assignRolesToUserInTransaction(tx, user.id, tenantId, [selectedRole.id]);

            if (archivedUser) {
                await this.invalidateArchivedUserAuthState(tx, tenantId, user.id, now);
            }
            const invitationDelivery = normalizedEmail
                ? this.staffInvitationOutbox.toResponse(
                    await this.staffInvitationOutbox.enqueueInTransaction(tx, {
                        tenantId,
                        userId: user.id,
                        recipient: normalizedEmail,
                    }),
                )
                : this.staffInvitationOutbox.notApplicable();

            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: req.user.sub,
                    actorUserId: req.user.sub,
                    actorTenantId: tenantId,
                    action: archivedUser ? 'USER_REACTIVATED' : 'USER_INVITED',
                    resource: 'User',
                    resourceId: user.id
                }
            });

            return { user, temporaryPin, invitationDelivery };
            },
        );


        return {
            id: user.id,
            email: this.sanitizeEmailForResponse(user.email),
            username: user.username ?? '',
            name: user.name,
            role: user.role,
            pinEnabled: Boolean(user.pinHash) || Boolean(normalizedUsername),
            pinResetRequired: Boolean(normalizedUsername) && !normalizedPin,
            temporaryPin,
            invitationDelivery,
            assignedRoles: await this.rbacService.getUserRoleAssignments(user.id, tenantId),
            status: 'INVITED',
        };
    }

    @Get(':id/invitation')
    @Permission('users:admin')
    async invitationStatus(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        return {
            invitationDelivery: await this.tenantDb.withTenant(
                tenantId,
                (tx) => this.staffInvitationOutbox.statusInTransaction(tx, tenantId, id),
            ),
        };
    }

    @Post(':id/invitation/retry')
    @Permission('users:admin')
    async retryInvitation(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const actorSessionId = this.requestSessionId(req);
        return {
            invitationDelivery: await this.withActorAuthorizedSerializableMutation(
                tenantId,
                async (tx) => {
                    await this.rbacService.authorizeUserAdministrationInTransaction(tx, tenantId, {
                        actorUserId: req.user.sub,
                        actorSessionId,
                        targetUserId: id,
                        requiredPermission: 'users:admin',
                        selfMutationMessage: 'You cannot retry your own invitation delivery',
                    });
                    return this.staffInvitationOutbox.retryInTransaction(tx, {
                        tenantId,
                        userId: id,
                        actorUserId: req.user.sub,
                    });
                },
            ),
        };
    }

    @Post(':id/invitation/reissue')
    @Permission('users:admin')
    async reissueInvitation(
        @Param('id') id: string,
        @Req() req: any,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        const tenantId = req.user.tenantId;
        const actorSessionId = this.requestSessionId(req);
        return {
            invitationDelivery: await this.withActorAuthorizedSerializableMutation(
                tenantId,
                async (tx) => {
                    await this.rbacService.authorizeUserAdministrationInTransaction(tx, tenantId, {
                        actorUserId: req.user.sub,
                        actorSessionId,
                        targetUserId: id,
                        requiredPermission: 'users:admin',
                        selfMutationMessage: 'You cannot reissue your own invitation delivery',
                    });
                    return this.staffInvitationOutbox.reissueInTransaction(tx, {
                        tenantId,
                        userId: id,
                        actorUserId: req.user.sub,
                        idempotencyKey,
                    });
                },
            ),
        };
    }

    @Put(':id/role')
    @Permission('users:admin')
    async updateRole(@Param('id') id: string, @Body() body: { role: UserRoleValue }, @Req() req: any) {
        const role = this.parseUserRole(body.role);
        const tenantId = req.user.tenantId;
        const replacement = await this.rbacService.replaceUserRolesAsActor(tenantId, {
            actorUserId: req.user.sub,
            actorSessionId: this.requestSessionId(req),
            targetUserId: id,
            legacyRole: role,
            requiredPermission: 'users:admin',
            selfMutationMessage: 'You cannot change your own role',
            auditAction: 'USER_ROLE_UPDATED',
        });
        return {
            id,
            role: replacement.legacyRole,
            assignedRoles: replacement.assignedRoles,
        };
    }

    @Post(':id/pin/reset')
    @Permission('users:admin')
    async resetUserPin(@Param('id') id: string, @Body() body: { pin?: unknown }, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const requestedPin = typeof body?.pin === 'string' ? body.pin.trim() : body?.pin;
        const newPin = requestedPin === undefined || requestedPin === ''
            ? this.createTemporaryPin()
            : requestedPin;
        const reset = await this.authService.resetUserPinAsAdmin(
            id,
            newPin,
            tenantId,
            req.user.sub,
            this.requestSessionId(req),
            this.requestAudit(req),
        );

        return { id, username: reset.username, temporaryPin: newPin, pinResetRequired: true };
    }

    @Put('me/pin')
    @AllowAuthenticated()
    async rotateOwnPin(@Req() req: any, @Body() body: { currentPin: string; newPin: string }) {
        await this.authService.rotateOwnPin(
            req.user.sub,
            body.currentPin,
            body.newPin,
            req.user.tenantId,
            this.requestSessionId(req),
            this.requestAudit(req),
        );
        return { success: true };
    }

    @Delete(':id')
    @Permission('users:admin')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deactivate(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const actorSessionId = this.requestSessionId(req);
        const storageKeys = await this.withActorAuthorizedSerializableMutation(
            tenantId,
            async (tx) => {
                await tx.$queryRaw(Prisma.sql`
                    SELECT "id"
                    FROM "Tenant"
                    WHERE "id" = ${tenantId}
                    FOR UPDATE
                `);
                const user = await this.rbacService.authorizeUserAdministrationInTransaction(
                    tx,
                    tenantId,
                    {
                        actorUserId: req.user.sub,
                        actorSessionId,
                        targetUserId: id,
                        requiredPermission: 'users:admin',
                        selfMutationMessage: 'You cannot deactivate your own account',
                    },
                );
                const deletedAt = new Date();
                const cleanup = await anonymizeDeletedUser(tx, tenantId, user.id, deletedAt);
                await tx.auditLog.create({
                    data: {
                        tenantId,
                        userId: req.user.sub,
                        actorUserId: req.user.sub,
                        actorTenantId: tenantId,
                        action: 'USER_DELETED',
                        resource: 'User',
                        resourceId: user.id,
                    },
                });
                return cleanup.availabilityImportStorageKeys;
            },
            'Authorization changed during user deactivation; retry the request',
        );
        await deleteAvailabilityImportStorageKeys(storageKeys);
    }

    @Get(':id/access')
    @Permission('roles:read')
    async userAccess(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const user = await this.tenantDb.withTenant(tenantId, (tx) => tx.user.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: { id: true, role: true, tenantId: true },
        }));
        if (!user) throw new NotFoundException('User not found');

        const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
        return access;
    }

    @Put(':id/access')
    @Permission('roles:assign')
    async updateUserAccess(@Param('id') id: string, @Body() body: { roleIds: string[] }, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const requestedRoleIds = this.normalizeRoleIds(body.roleIds);
        const replacement = await this.rbacService.replaceUserRolesAsActor(tenantId, {
            actorUserId: req.user.sub,
            actorSessionId: this.requestSessionId(req),
            targetUserId: id,
            roleIds: requestedRoleIds,
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'You cannot change your own access roles',
            auditAction: 'USER_ACCESS_UPDATED',
        });
        return { id, assignedRoles: replacement.assignedRoles };
    }

    @Post('roles')
    @Permission('roles:write')
    async createAccessRole(
        @Body() body: { name: string; description?: string; permissionKeys: string[] },
        @Req() req: any,
    ) {
        const permissionKeys = this.normalizePermissionKeys(body.permissionKeys);
        this.assertCanUsePermissionKeys(req, permissionKeys);
        const requestAudit = this.requestAudit(req);
        try {
            const role = await this.rbacService.createRole(
                req.user.tenantId,
                { ...body, permissionKeys },
                {
                    actorUserId: req.user.sub,
                    actorSessionId: this.requestSessionId(req),
                    ...requestAudit,
                },
            );
            return {
                id: role.id,
                name: role.name,
                description: role.description,
                isSystem: role.isSystem,
                permissions: role.rolePermissions.map((item) => item.permission.key).sort(),
            };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            if (isPrismaUniqueConstraintConflict(error) || isSerializableTransactionConflict(error)) {
                throw new ConflictException('Unable to create role');
            }
            throw error;
        }
    }

    @Put('roles/:roleId')
    @Permission('roles:write')
    async updateAccessRole(
        @Param('roleId') roleId: string,
        @Body() body: { name: string; description?: string; permissionKeys: string[] },
        @Req() req: any,
    ) {
        const permissionKeys = this.normalizePermissionKeys(body.permissionKeys);
        this.assertCanUsePermissionKeys(req, permissionKeys);
        const requestAudit = this.requestAudit(req);
        const role = await this.rbacService.updateRole(
            req.user.tenantId,
            roleId,
            { ...body, permissionKeys },
            {
                actorUserId: req.user.sub,
                actorSessionId: this.requestSessionId(req),
                ...requestAudit,
            },
        );
        if (!role) throw new NotFoundException('Role not found');
        return {
            id: role.id,
            name: role.name,
            description: role.description,
            isSystem: role.isSystem,
            userCount: role._count.assignments,
            permissions: role.rolePermissions.map((item) => item.permission.key).sort(),
        };
    }

    @Delete('roles/:roleId')
    @Permission('roles:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteAccessRole(@Param('roleId') roleId: string, @Req() req: any) {
        const requestAudit = this.requestAudit(req);
        const deleted = await this.rbacService.deleteRole(
            req.user.tenantId,
            roleId,
            {
                actorUserId: req.user.sub,
                actorSessionId: this.requestSessionId(req),
                ...requestAudit,
            },
        );
        if (!deleted) {
            throw new NotFoundException('Role not found or cannot be deleted');
        }
    }
}
