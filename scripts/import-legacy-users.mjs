#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PrismaClient, PermissionCategory, PlanTier, TenantStatus, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  ['dashboard:access', 'Access dashboard', 'Sign in to the tenant dashboard.', PermissionCategory.AUTH],
  ['admin_portal:access', 'Access admin portal', 'Access the system administration portal.', PermissionCategory.ADMIN],
  ['auth:login_email', 'Email login', 'Authenticate with work email and one-time passcode.', PermissionCategory.AUTH],
  ['auth:login_pin', 'PIN login', 'Authenticate with username and PIN.', PermissionCategory.AUTH],
  ['auth:login_password', 'Password login', 'Authenticate with migrated username and password.', PermissionCategory.AUTH],
  ['users:read', 'View staff', 'Read staff directory and user details.', PermissionCategory.USERS],
  ['users:write', 'Create staff', 'Invite staff and update basic account details.', PermissionCategory.USERS],
  ['users:admin', 'Administer staff', 'Reset login credentials and deactivate users.', PermissionCategory.USERS],
  ['roles:read', 'View access roles', 'Read role and permission definitions.', PermissionCategory.USERS],
  ['roles:write', 'Manage access roles', 'Create, edit, and delete tenant-defined roles.', PermissionCategory.USERS],
  ['roles:assign', 'Assign access roles', 'Assign or revoke roles for staff members.', PermissionCategory.USERS],
  ['locations:read', 'View locations', 'Read location records.', PermissionCategory.LOCATIONS],
  ['locations:write', 'Manage locations', 'Create and update locations.', PermissionCategory.LOCATIONS],
  ['locations:delete', 'Delete locations', 'Delete locations.', PermissionCategory.LOCATIONS],
  ['shifts:read', 'View shifts', 'Read shifts.', PermissionCategory.SHIFTS],
  ['shifts:write', 'Manage shifts', 'Create and update shifts.', PermissionCategory.SHIFTS],
  ['shifts:delete', 'Delete shifts', 'Delete shifts.', PermissionCategory.SHIFTS],
  ['schedules:read', 'View schedules', 'Read schedules.', PermissionCategory.SCHEDULES],
  ['schedules:write', 'Manage schedules', 'Create and update schedules.', PermissionCategory.SCHEDULES],
  ['schedules:publish', 'Publish schedules', 'Publish schedules.', PermissionCategory.SCHEDULES],
  ['lunch_breaks:read', 'View breaks', 'Read lunch and break plans.', PermissionCategory.LUNCH_BREAKS],
  ['lunch_breaks:write', 'Manage breaks', 'Create and update lunch and break plans.', PermissionCategory.LUNCH_BREAKS],
  ['lunch_breaks:delete', 'Delete breaks', 'Delete lunch and break plans.', PermissionCategory.LUNCH_BREAKS],
  ['notifications:read', 'View notifications', 'Read notifications.', PermissionCategory.NOTIFICATIONS],
  ['notifications:write', 'Manage notifications', 'Create and mark notifications.', PermissionCategory.NOTIFICATIONS],
  ['billing:read', 'View billing', 'Read billing and credits data.', PermissionCategory.BILLING],
  ['billing:write', 'Manage billing', 'Modify billing and credits data.', PermissionCategory.BILLING],
  ['settings:read', 'View settings', 'Read tenant settings.', PermissionCategory.SETTINGS],
  ['settings:write', 'Manage settings', 'Update tenant settings.', PermissionCategory.SETTINGS],
];

const ALL_PERMISSION_KEYS = PERMISSIONS.map(([key]) => key);
const ROLE_DEFINITIONS = [
  { slug: 'super-admin', name: 'System Admin', legacyRole: UserRole.SUPER_ADMIN, permissions: ALL_PERMISSION_KEYS },
  {
    slug: 'admin',
    name: 'Admin',
    legacyRole: UserRole.ADMIN,
    isDefault: true,
    permissions: ALL_PERMISSION_KEYS.filter((key) => key !== 'admin_portal:access'),
  },
  {
    slug: 'manager',
    name: 'Manager',
    legacyRole: UserRole.MANAGER,
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
      'notifications:read',
      'notifications:write',
    ],
  },
  {
    slug: 'staff',
    name: 'Staff',
    legacyRole: UserRole.STAFF,
    permissions: [
      'dashboard:access',
      'auth:login_pin',
      'auth:login_password',
      'locations:read',
      'shifts:read',
      'schedules:read',
      'lunch_breaks:read',
      'lunch_breaks:write',
      'notifications:read',
      'notifications:write',
    ],
  },
];

function usage() {
  console.error('Usage: node scripts/import-legacy-users.mjs <legacy-export.json> [--report <credentials.csv>]');
  process.exit(2);
}

function slugify(value, fallback) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function normalizeUsername(value, fallback) {
  return slugify(value, fallback).replace(/-/g, '.');
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? ''));
}

async function uniqueUsername(tenantId, base, reserved) {
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate) || await prisma.user.findFirst({ where: { tenantId, username: candidate, deletedAt: null }, select: { id: true } })) {
    candidate = `${base}.${suffix}`;
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

async function ensureRoles(tenantId) {
  for (const [key, label, description, category] of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: { label, description, category },
      create: { key, label, description, category },
    });
  }
  const permissions = await prisma.permission.findMany({ where: { key: { in: ALL_PERMISSION_KEYS } }, select: { id: true, key: true } });
  const permissionIdByKey = new Map(permissions.map((permission) => [permission.key, permission.id]));
  const roleByLegacy = new Map();

  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { tenantId_slug: { tenantId, slug: definition.slug } },
      update: {
        name: definition.name,
        isSystem: true,
        isDefault: Boolean(definition.isDefault),
        legacyRole: definition.legacyRole,
        deletedAt: null,
      },
      create: {
        tenantId,
        slug: definition.slug,
        name: definition.name,
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
    roleByLegacy.set(definition.legacyRole, role);
  }

  return roleByLegacy;
}

function userRoleForLegacy(user, companyRoles, storeRoles) {
  const roles = [
    ...companyRoles.filter((role) => Number(role.user_id) === Number(user.id)).map((role) => role.role),
    ...storeRoles.filter((role) => Number(role.user_id) === Number(user.id)).map((role) => role.role),
  ];
  if (roles.includes('super_admin')) return UserRole.SUPER_ADMIN;
  if (roles.includes('company_admin')) return UserRole.ADMIN;
  if (roles.includes('store') || roles.includes('schedule')) return UserRole.MANAGER;
  return UserRole.STAFF;
}

function staffRole(staff) {
  return Number(staff.is_admin) === 1 ? UserRole.ADMIN : UserRole.STAFF;
}

function csvEscape(value) {
  const stringValue = String(value ?? '');
  if (!/[",\r\n]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

async function main() {
  const args = process.argv.slice(2);
  const exportPath = args[0];
  if (!exportPath) usage();
  const reportFlagIndex = args.indexOf('--report');
  const reportPath = reportFlagIndex >= 0 ? args[reportFlagIndex + 1] : path.resolve(process.cwd(), '..', '..', 'exports', `imported-user-credentials-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`);
  if (!reportPath) usage();

  const source = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  const reservedUsernames = new Set();
  const tenantByLegacyCompany = new Map();
  const locationByLegacyStore = new Map();
  const reportRows = [['source_type', 'legacy_id', 'name', 'username', 'role', 'login_method', 'has_password_hash']];

  for (const company of source.companies ?? []) {
    const tenant = await prisma.tenant.upsert({
      where: { slug: `legacy-company-${company.id}` },
      update: {
        name: company.name,
        planTier: PlanTier.ENTERPRISE,
        status: TenantStatus.ACTIVE,
        deletedAt: null,
      },
      create: {
        name: company.name,
        slug: `legacy-company-${company.id}`,
        planTier: PlanTier.ENTERPRISE,
        status: TenantStatus.ACTIVE,
        usageCredits: 1000,
      },
    });
    tenantByLegacyCompany.set(Number(company.id), tenant);
    await ensureRoles(tenant.id);
  }

  for (const store of source.stores ?? []) {
    const tenant = tenantByLegacyCompany.get(Number(store.company_id));
    if (!tenant) continue;
    const location = await prisma.location.upsert({
      where: { id: `legacy-store-${store.id}` },
      update: {
        tenantId: tenant.id,
        name: store.name,
        address: store.location || null,
        deletedAt: null,
      },
      create: {
        id: `legacy-store-${store.id}`,
        tenantId: tenant.id,
        name: store.name,
        address: store.location || null,
        timezone: process.env.LEGACY_IMPORT_TIMEZONE || 'America/Los_Angeles',
      },
    });
    locationByLegacyStore.set(Number(store.id), location);
  }

  for (const legacyUser of source.users ?? []) {
    const tenant = tenantByLegacyCompany.get(Number(legacyUser.company_id));
    if (!tenant) continue;
    const role = userRoleForLegacy(legacyUser, source.user_company_roles ?? [], source.user_store_roles ?? []);
    const roleByLegacy = await ensureRoles(tenant.id);
    const sourceUsername = legacyUser.username_plain ?? legacyUser.username ?? `legacy.user.${legacyUser.id}`;
    const username = await uniqueUsername(tenant.id, normalizeUsername(sourceUsername, `legacy.user.${legacyUser.id}`), reservedUsernames);
    const name = legacyUser.name_plain ?? legacyUser.name ?? sourceUsername ?? `Legacy User ${legacyUser.id}`;
    const passwordHash = legacyUser.password_hash ?? legacyUser.passwordHash ?? null;
    const user = await prisma.user.upsert({
      where: { tenantId_username: { tenantId: tenant.id, username } },
      update: {
        email: isEmail(sourceUsername) ? sourceUsername.toLowerCase() : null,
        name,
        role,
        passwordHash,
        pinHash: null,
        pinSetAt: null,
        pinResetRequired: false,
        pinLoginAttempts: 0,
        pinLockedUntil: null,
        deletedAt: null,
      },
      create: {
        tenantId: tenant.id,
        email: isEmail(sourceUsername) ? sourceUsername.toLowerCase() : null,
        username,
        name,
        role,
        passwordHash,
        pinResetRequired: false,
      },
    });
    const roleRow = roleByLegacy.get(role);
    if (roleRow) {
      await prisma.roleAssignment.createMany({ data: [{ userId: user.id, roleId: roleRow.id }], skipDuplicates: true });
    }
    reportRows.push(['user', legacyUser.id, user.name, username, role, passwordHash ? 'legacy-password' : 'none', passwordHash ? 'true' : 'false']);
  }

  for (const staff of source.staff ?? []) {
    const tenant = tenantByLegacyCompany.get(Number(staff.company_id));
    if (!tenant) continue;
    const role = staffRole(staff);
    const roleByLegacy = await ensureRoles(tenant.id);
    const staffName = staff.name_plain ?? staff.name ?? `Staff ${staff.id}`;
    const username = await uniqueUsername(tenant.id, normalizeUsername(staffName, `staff.${staff.id}`), reservedUsernames);
    const user = await prisma.user.upsert({
      where: { tenantId_username: { tenantId: tenant.id, username } },
      update: {
        name: staffName,
        role,
        passwordHash: null,
        pinHash: null,
        pinSetAt: null,
        pinResetRequired: false,
        pinLoginAttempts: 0,
        pinLockedUntil: null,
        deletedAt: null,
      },
      create: {
        tenantId: tenant.id,
        username,
        name: staffName,
        role,
        pinResetRequired: false,
      },
    });
    const roleRow = roleByLegacy.get(role);
    if (roleRow) {
      await prisma.roleAssignment.createMany({ data: [{ userId: user.id, roleId: roleRow.id }], skipDuplicates: true });
    }
    reportRows.push(['staff', staff.id, user.name, username, role, 'none', 'false']);
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${reportRows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`);

  const counts = await prisma.user.groupBy({ by: ['role'], _count: { _all: true } });
  console.log(JSON.stringify({ importedCredentials: reportRows.length - 1, reportPath, counts }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
