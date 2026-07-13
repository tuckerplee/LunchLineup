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

  const result = await prisma.$transaction(async (tx) => {
    await enablePlatformAdmin(tx);
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

    let user = await tx.user.findUnique({
      where: {
        tenantId_email: {
          tenantId: tenant.id,
          email: adminEmail,
        },
      },
    });
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
    }

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
