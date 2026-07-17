#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  ['dashboard:access', 'Access dashboard', 'AUTH'],
  ['admin_portal:access', 'Access admin portal', 'ADMIN'],
  ['tenant_account:lifecycle', 'Manage tenant lifecycle', 'ADMIN'],
  ['account:data_export', 'Export tenant data', 'ADMIN'],
  ['auth:login_email', 'Email login', 'AUTH'],
  ['auth:login_pin', 'PIN login', 'AUTH'],
  ['auth:login_password', 'Password login', 'AUTH'],
  ['users:read', 'View staff', 'USERS'],
  ['users:write', 'Create staff', 'USERS'],
  ['users:admin', 'Administer staff', 'USERS'],
  ['roles:read', 'View access roles', 'USERS'],
  ['roles:write', 'Manage access roles', 'USERS'],
  ['roles:assign', 'Assign access roles', 'USERS'],
  ['locations:read', 'View locations', 'LOCATIONS'],
  ['locations:write', 'Manage locations', 'LOCATIONS'],
  ['locations:delete', 'Delete locations', 'LOCATIONS'],
  ['shifts:read', 'View shifts', 'SHIFTS'],
  ['shifts:write', 'Manage shifts', 'SHIFTS'],
  ['shifts:delete', 'Delete shifts', 'SHIFTS'],
  ['schedules:read', 'View schedules', 'SCHEDULES'],
  ['schedules:write', 'Manage schedules', 'SCHEDULES'],
  ['schedules:publish', 'Publish schedules', 'SCHEDULES'],
  ['lunch_breaks:read', 'View breaks', 'LUNCH_BREAKS'],
  ['lunch_breaks:write', 'Manage breaks', 'LUNCH_BREAKS'],
  ['lunch_breaks:delete', 'Delete breaks', 'LUNCH_BREAKS'],
  ['time_cards:read', 'View time cards', 'TIME_CARDS'],
  ['time_cards:write', 'Manage time cards', 'TIME_CARDS'],
  ['notifications:read', 'View notifications', 'NOTIFICATIONS'],
  ['notifications:write', 'Manage notifications', 'NOTIFICATIONS'],
  ['billing:read', 'View billing', 'BILLING'],
  ['billing:write', 'Manage billing', 'BILLING'],
  ['settings:read', 'View settings', 'SETTINGS'],
  ['settings:write', 'Manage settings', 'SETTINGS'],
];

const ALL_PERMISSION_KEYS = PERMISSIONS.map(([key]) => key);

const SYSTEM_ROLES = [
  {
    slug: 'super-admin',
    name: 'System Admin',
    description: 'Full platform access.',
    legacyRole: 'SUPER_ADMIN',
    permissions: ALL_PERMISSION_KEYS,
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Tenant administrator with staff and operations access.',
    legacyRole: 'ADMIN',
    isDefault: true,
    permissions: [
      'dashboard:access',
      'auth:login_email',
      'auth:login_pin',
      'auth:login_password',
      'users:read',
      'users:write',
      'users:admin',
      'roles:read',
      'roles:write',
      'roles:assign',
      'locations:read',
      'locations:write',
      'locations:delete',
      'shifts:read',
      'shifts:write',
      'shifts:delete',
      'schedules:read',
      'schedules:write',
      'schedules:publish',
      'lunch_breaks:read',
      'lunch_breaks:write',
      'lunch_breaks:delete',
      'time_cards:read',
      'time_cards:write',
      'notifications:read',
      'notifications:write',
      'billing:read',
      'billing:write',
      'settings:read',
      'settings:write',
      'tenant_account:lifecycle',
      'account:data_export',
    ],
  },
  {
    slug: 'manager',
    name: 'Manager',
    description: 'Store manager with scheduling and people access.',
    legacyRole: 'MANAGER',
    permissions: [
      'dashboard:access',
      'auth:login_email',
      'auth:login_pin',
      'auth:login_password',
      'users:read',
      'users:write',
      'roles:read',
      'locations:read',
      'shifts:read',
      'shifts:write',
      'schedules:read',
      'schedules:write',
      'schedules:publish',
      'lunch_breaks:read',
      'lunch_breaks:write',
      'time_cards:read',
      'time_cards:write',
      'notifications:read',
      'notifications:write',
    ],
  },
  {
    slug: 'staff',
    name: 'Staff',
    description: 'Frontline staff member.',
    legacyRole: 'STAFF',
    permissions: [
      'dashboard:access',
      'auth:login_pin',
      'auth:login_password',
      'locations:read',
      'shifts:read',
      'schedules:read',
      'lunch_breaks:read',
      'time_cards:read',
      'time_cards:write',
      'notifications:read',
      'notifications:write',
    ],
  },
];

function requireProductionBootstrap() {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.RUN_PRODUCTION_ADMIN_BOOTSTRAP === 'true') return;
  throw new Error('Refusing production admin bootstrap outside NODE_ENV=production without RUN_PRODUCTION_ADMIN_BOOTSTRAP=true.');
}

function requireAdminEmail() {
  const email = String(process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('ADMIN_EMAIL must be a valid monitored mailbox before production admin bootstrap.');
  }
  return email;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

async function enablePlatformAdmin(tx) {
  const capability = String(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET ?? '').trim();
  if (!capability) throw new Error('PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
}

async function assertNoUnexpectedPlatformAdmins(tx, adminEmail, tenantSlug) {
  const [schema] = await tx.$queryRaw`
    SELECT
      to_regclass('"Tenant"') IS NOT NULL AS "tenantExists",
      to_regclass('"User"') IS NOT NULL AS "userExists",
      to_regclass('"Role"') IS NOT NULL AS "roleExists",
      to_regclass('"RoleAssignment"') IS NOT NULL AS "roleAssignmentExists",
      to_regprocedure('set_current_platform_admin(boolean,text)') IS NOT NULL AS "platformAdminHelperExists"
  `;
  if (!schema?.tenantExists || !schema?.userExists) return;
  if (schema.platformAdminHelperExists) await enablePlatformAdmin(tx);

  const unauthorized = schema.roleExists && schema.roleAssignmentExists
    ? await tx.$queryRaw`
        SELECT u."id"
        FROM "User" u
        JOIN "Tenant" t ON t."id" = u."tenantId"
        WHERE u."deletedAt" IS NULL
          AND u."suspendedAt" IS NULL
          AND t."deletedAt" IS NULL
          AND t."status" = 'ACTIVE'::"TenantStatus"
          AND (
            u."role" = 'SUPER_ADMIN'::"UserRole"
            OR EXISTS (
              SELECT 1
              FROM "RoleAssignment" ra
              JOIN "Role" r ON r."id" = ra."roleId"
              WHERE ra."tenantId" = u."tenantId"
                AND ra."userId" = u."id"
                AND r."tenantId" = u."tenantId"
                AND r."slug" = 'super-admin'
                AND r."deletedAt" IS NULL
            )
          )
          AND NOT (
            t."slug" = ${tenantSlug}
            AND lower(COALESCE(u."email", '')) = ${adminEmail}
          )
        LIMIT 1
      `
    : await tx.$queryRaw`
        SELECT u."id"
        FROM "User" u
        JOIN "Tenant" t ON t."id" = u."tenantId"
        WHERE u."deletedAt" IS NULL
          AND u."suspendedAt" IS NULL
          AND t."deletedAt" IS NULL
          AND t."status" = 'ACTIVE'::"TenantStatus"
          AND u."role" = 'SUPER_ADMIN'::"UserRole"
          AND NOT (
            t."slug" = ${tenantSlug}
            AND lower(COALESCE(u."email", '')) = ${adminEmail}
          )
        LIMIT 1
      `;

  if (unauthorized.length > 0) {
    throw new Error(
      'Refusing production admin preflight: an active non-designated account has legacy SUPER_ADMIN or a super-admin RBAC assignment.',
    );
  }
}

async function ensurePermissionCatalog(tx) {
  for (const [key, label, category] of PERMISSIONS) {
    await tx.permission.upsert({
      where: { key },
      update: { label, category },
      create: { key, label, category },
    });
  }
}

async function ensureSystemRoles(tx, tenantId) {
  const permissions = await tx.permission.findMany({
    where: { key: { in: ALL_PERMISSION_KEYS } },
    select: { id: true, key: true },
  });
  const permissionIdByKey = new Map(permissions.map((permission) => [permission.key, permission.id]));

  for (const roleDefinition of SYSTEM_ROLES) {
    const role = await tx.role.upsert({
      where: { tenantId_slug: { tenantId, slug: roleDefinition.slug } },
      update: {
        name: roleDefinition.name,
        description: roleDefinition.description,
        isSystem: true,
        isDefault: Boolean(roleDefinition.isDefault),
        legacyRole: roleDefinition.legacyRole,
        deletedAt: null,
      },
      create: {
        tenantId,
        slug: roleDefinition.slug,
        name: roleDefinition.name,
        description: roleDefinition.description,
        isSystem: true,
        isDefault: Boolean(roleDefinition.isDefault),
        legacyRole: roleDefinition.legacyRole,
      },
    });

    await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
    await tx.rolePermission.createMany({
      data: roleDefinition.permissions
        .map((permissionKey) => permissionIdByKey.get(permissionKey))
        .filter(Boolean)
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }
}

async function bootstrap() {
  requireProductionBootstrap();
  const adminEmail = requireAdminEmail();
  const tenantSlug = String(process.env.ADMIN_TENANT_SLUG ?? 'system').trim() || 'system';
  const tenantName = String(process.env.ADMIN_TENANT_NAME ?? 'System Administration').trim() || 'System Administration';
  const adminName = String(process.env.ADMIN_NAME ?? 'System Admin').trim() || 'System Admin';
  const preflightOnly = process.argv.includes('--preflight-only');

  if (preflightOnly) {
    await prisma.$transaction((tx) => assertNoUnexpectedPlatformAdmins(tx, adminEmail, tenantSlug));
    console.log(JSON.stringify({ ok: true, preflightOnly: true }));
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    await assertNoUnexpectedPlatformAdmins(tx, adminEmail, tenantSlug);
    await ensurePermissionCatalog(tx);

    let tenant = await tx.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) {
      tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          slug: tenantSlug,
          planTier: 'ENTERPRISE',
          status: 'ACTIVE',
        },
      });
    } else if (tenant.deletedAt || tenant.status !== 'ACTIVE') {
      throw new Error(
        'Refusing to bootstrap an administrator into an unavailable tenant.',
      );
    }

    await ensureSystemRoles(tx, tenant.id);

    const matchingUsers = await tx.user.findMany({
      where: {
        tenantId: tenant.id,
        email: { equals: adminEmail, mode: 'insensitive' },
      },
      orderBy: { id: 'asc' },
      take: 2,
    });
    if (matchingUsers.length > 1) {
      throw new Error('Refusing to bootstrap an ambiguous designated administrator identity.');
    }
    let user = matchingUsers[0];
    const adminCreated = !user;
    if (!user) {
      user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: adminEmail,
          name: adminName,
          role: 'SUPER_ADMIN',
          mfaEnabled: false,
        },
      });
    } else {
      if (user.deletedAt || user.suspendedAt) {
        throw new Error('Refusing to repair an unavailable designated administrator account.');
      }
      if (user.role !== 'SUPER_ADMIN') {
        user = await tx.user.update({
          where: { id: user.id },
          data: { role: 'SUPER_ADMIN' },
        });
      }
    }

    const role = await tx.role.findFirstOrThrow({
      where: {
        tenantId: tenant.id,
        slug: 'super-admin',
        deletedAt: null,
      },
      select: { id: true },
    });

    await tx.roleAssignment.createMany({
      data: [{ tenantId: tenant.id, userId: user.id, roleId: role.id }],
      skipDuplicates: true,
    });

    return {
      tenantId: tenant.id,
      userId: user.id,
      adminEmail,
      adminCreated,
    };
  });

  console.log(JSON.stringify({
    ok: true,
    tenantId: result.tenantId,
    userId: result.userId,
    adminEmail: maskEmail(result.adminEmail),
    adminCreated: result.adminCreated,
    mfaRequiredByPolicy: true,
  }));
}

bootstrap()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
