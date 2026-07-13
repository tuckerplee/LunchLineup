import crypto from 'node:crypto';
import { assertE2ESeedTarget } from './data-target-guard.mjs';

assertE2ESeedTarget(process.env);
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'e2e-operations';
const tenantName = process.env.E2E_TENANT_NAME ?? 'E2E Operations Diner';
const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'e2e.admin';
const adminPin = process.env.E2E_ADMIN_PIN ?? '246810';
const superAdminUsername = process.env.E2E_SUPER_ADMIN_USERNAME ?? 'e2e.superadmin';
const superAdminPin = process.env.E2E_SUPER_ADMIN_PIN ?? '864200';
const locationName = process.env.E2E_LOCATION_NAME ?? 'Downtown Diner';

const PERMISSIONS = [
  ['dashboard:access', 'Access dashboard', 'AUTH'],
  ['admin_portal:access', 'Access admin portal', 'ADMIN'],
  ['tenant_account:lifecycle', 'Manage tenant lifecycle', 'ADMIN'],
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

const ROLES = [
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
      'lunch_breaks:write',
      'time_cards:read',
      'time_cards:write',
      'notifications:read',
      'notifications:write',
    ],
  },
];

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function ensurePermissionCatalog() {
  for (const [key, label, category] of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: { label, category },
      create: { key, label, category },
    });
  }
}

async function resetTenantData(tenantId) {
  const users = await prisma.user.findMany({ where: { tenantId }, select: { id: true } });
  const userIds = users.map((user) => user.id);

  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.timeCard.deleteMany({ where: { tenantId } });
  await prisma.break.deleteMany({ where: { shift: { tenantId } } });
  await prisma.shift.deleteMany({ where: { tenantId } });
  await prisma.schedule.deleteMany({ where: { tenantId } });
  await prisma.location.deleteMany({ where: { tenantId } });
  await prisma.webhookEndpoint.deleteMany({ where: { tenantId } });
  await prisma.billingEvent.deleteMany({ where: { tenantId } });
  await prisma.creditTransaction.deleteMany({ where: { tenantId } });
  await prisma.tenantSetting.deleteMany({ where: { tenantId } });
  await prisma.roleAssignment.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } });
  await prisma.role.deleteMany({ where: { tenantId } });
}

async function ensureTenantRoles(tenantId) {
  const permissions = await prisma.permission.findMany({
    where: { key: { in: ALL_PERMISSION_KEYS } },
    select: { id: true, key: true },
  });
  const permissionIdByKey = new Map(permissions.map((permission) => [permission.key, permission.id]));
  const rolesBySlug = new Map();

  for (const definition of ROLES) {
    const role = await prisma.role.upsert({
      where: { tenantId_slug: { tenantId, slug: definition.slug } },
      update: {
        name: definition.name,
        description: definition.description,
        isSystem: true,
        isDefault: Boolean(definition.isDefault),
        legacyRole: definition.legacyRole,
        deletedAt: null,
      },
      create: {
        tenantId,
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        isSystem: true,
        isDefault: Boolean(definition.isDefault),
        legacyRole: definition.legacyRole,
      },
    });

    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: definition.permissions
        .map((key) => permissionIdByKey.get(key))
        .filter(Boolean)
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
    rolesBySlug.set(definition.slug, role);
  }

  return rolesBySlug;
}

async function main() {
  if (!/^\d{4,8}$/.test(adminPin)) {
    throw new Error('E2E_ADMIN_PIN must be 4-8 digits.');
  }
  if (!/^\d{4,8}$/.test(superAdminPin)) {
    throw new Error('E2E_SUPER_ADMIN_PIN must be 4-8 digits.');
  }

  await ensurePermissionCatalog();

  let tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: tenantName,
        slug: tenantSlug,
        planTier: 'GROWTH',
        status: 'ACTIVE',
        usageCredits: 500,
      },
    });
  }

  await resetTenantData(tenant.id);
  tenant = await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      name: tenantName,
      planTier: 'GROWTH',
      status: 'ACTIVE',
      usageCredits: 500,
      deletedAt: null,
    },
  });

  const rolesBySlug = await ensureTenantRoles(tenant.id);
  const adminRole = rolesBySlug.get('admin');
  const superAdminRole = rolesBySlug.get('super-admin');
  if (!adminRole) throw new Error('Admin role was not created.');
  if (!superAdminRole) throw new Error('Super admin role was not created.');

  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: null,
      username: adminUsername,
      name: 'E2E Admin',
      role: 'ADMIN',
      pinHash: hashPin(adminPin),
      pinSetAt: new Date(),
      pinResetRequired: false,
    },
  });

  await prisma.roleAssignment.create({
    data: {
      tenantId: tenant.id,
      userId: admin.id,
      roleId: adminRole.id,
    },
  });

  const superAdmin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: null,
      username: superAdminUsername,
      name: 'E2E Super Admin',
      role: 'SUPER_ADMIN',
      pinHash: hashPin(superAdminPin),
      pinSetAt: new Date(),
      pinResetRequired: false,
    },
  });

  await prisma.roleAssignment.create({
    data: {
      tenantId: tenant.id,
      userId: superAdmin.id,
      roleId: superAdminRole.id,
    },
  });

  const location = await prisma.location.create({
    data: {
      tenantId: tenant.id,
      name: locationName,
      timezone: 'America/Los_Angeles',
    },
  });

  console.log(JSON.stringify({
    tenant: tenant.slug,
    adminUsername,
    adminPin,
    superAdminUsername,
    superAdminPin,
    location: location.name,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
