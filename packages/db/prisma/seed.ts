import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const guardPath = resolve(__dirname, '../../../scripts/data-target-guard.mjs');
execFileSync(process.execPath, [guardPath, 'development-seed'], {
    env: process.env,
    stdio: 'inherit',
});
const { PrismaClient } = require('@lunchlineup/db') as typeof import('@lunchlineup/db');
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
] as const;

const ALL_PERMISSION_KEYS = PERMISSIONS.map(([key]) => key);

const SYSTEM_ADMIN_ROLE = {
    slug: 'super-admin',
    name: 'System Admin',
    description: 'Full platform access.',
    legacyRole: 'SUPER_ADMIN',
    permissions: ALL_PERMISSION_KEYS,
} as const;

async function main() {
    console.log('Seeding initial permissions and roles...');

    for (const [key, label, category] of PERMISSIONS) {
        await prisma.permission.upsert({
            where: { key },
            update: { label, category: category as any },
            create: {
                key,
                label,
                category: category as any,
            },
        });
    }

    const planDefinitions = [
        {
            code: 'FREE',
            name: 'Free',
            monthlyPriceCents: null,
            locationLimit: 1,
            userLimit: 10,
            creditQuotaLimit: null,
            active: true,
            metadata: { features: [] },
        },
        {
            code: 'STARTER',
            name: 'Starter',
            monthlyPriceCents: 3900,
            locationLimit: 5,
            userLimit: 50,
            creditQuotaLimit: null,
            active: true,
            metadata: { features: ['scheduling'] },
        },
        {
            code: 'GROWTH',
            name: 'Growth',
            monthlyPriceCents: 7900,
            locationLimit: 25,
            userLimit: 250,
            creditQuotaLimit: null,
            active: true,
            metadata: { features: ['scheduling', 'lunch_breaks', 'time_cards', 'webhooks'] },
        },
        {
            code: 'ENTERPRISE',
            name: 'Enterprise',
            monthlyPriceCents: null,
            locationLimit: null,
            userLimit: null,
            creditQuotaLimit: null,
            active: true,
            metadata: { features: ['scheduling', 'lunch_breaks', 'time_cards', 'webhooks'] },
        },
    ] as const;

    for (const plan of planDefinitions) {
        await prisma.planDefinition.upsert({
            where: { code: plan.code },
            update: {
                name: plan.name,
                monthlyPriceCents: plan.monthlyPriceCents,
                locationLimit: plan.locationLimit,
                userLimit: plan.userLimit,
                creditQuotaLimit: plan.creditQuotaLimit,
                active: plan.active,
                metadata: plan.metadata,
            },
            create: plan,
        });
    }

    // 1. Create System Tenant
    const systemTenant = await prisma.tenant.upsert({
        where: { slug: 'system' },
        update: {},
        create: {
            name: 'System Administration',
            slug: 'system',
        },
    });

    const permissions = await prisma.permission.findMany({
        where: { key: { in: SYSTEM_ADMIN_ROLE.permissions } },
        select: { id: true, key: true },
    });
    const permissionIdByKey = new Map(permissions.map((permission) => [permission.key, permission.id]));
    const systemAdminRole = await prisma.role.upsert({
        where: {
            tenantId_slug: {
                tenantId: systemTenant.id,
                slug: SYSTEM_ADMIN_ROLE.slug,
            },
        },
        update: {
            name: SYSTEM_ADMIN_ROLE.name,
            description: SYSTEM_ADMIN_ROLE.description,
            isSystem: true,
            legacyRole: SYSTEM_ADMIN_ROLE.legacyRole,
            deletedAt: null,
        },
        create: {
            tenantId: systemTenant.id,
            slug: SYSTEM_ADMIN_ROLE.slug,
            name: SYSTEM_ADMIN_ROLE.name,
            description: SYSTEM_ADMIN_ROLE.description,
            isSystem: true,
            legacyRole: SYSTEM_ADMIN_ROLE.legacyRole,
        },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: systemAdminRole.id } });
    await prisma.rolePermission.createMany({
        data: SYSTEM_ADMIN_ROLE.permissions
            .map((key) => permissionIdByKey.get(key))
            .filter((permissionId): permissionId is string => Boolean(permissionId))
            .map((permissionId) => ({ roleId: systemAdminRole.id, permissionId })),
        skipDuplicates: true,
    });

    // 2. Create or repair Initial Super Admin
    const existingAdmin = await prisma.user.findFirst({
        where: {
            tenantId: systemTenant.id,
            email: 'admin@lunchlineup.com',
        },
    });

    const admin = existingAdmin
        ? await prisma.user.update({
            where: { id: existingAdmin.id },
            data: {
                name: 'System Admin',
                role: 'SUPER_ADMIN',
                deletedAt: null,
            },
        })
        : await prisma.user.create({
            data: {
                email: 'admin@lunchlineup.com',
                name: 'System Admin',
                tenantId: systemTenant.id,
                role: 'SUPER_ADMIN',
            },
        });

    await prisma.roleAssignment.createMany({
        data: [{ tenantId: systemTenant.id, userId: admin.id, roleId: systemAdminRole.id }],
        skipDuplicates: true,
    });

    console.log('Seeding complete.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
