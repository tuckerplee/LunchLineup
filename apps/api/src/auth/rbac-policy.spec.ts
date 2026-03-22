import { describe, it, expect, beforeAll } from 'vitest';
import { Enforcer, MODEL_PATH, POLICY_PATH, newEnforcer } from '@lunchlineup/rbac';

describe('RBAC policy matrix', () => {
    let enforcer: Enforcer;

    beforeAll(async () => {
        enforcer = await newEnforcer(MODEL_PATH, POLICY_PATH);
    });

    async function can(role: string, permission: string): Promise<boolean> {
        const [resource, action] = permission.split(':');
        return enforcer.enforce(role, resource, action);
    }

    it('SUPER_ADMIN can access every default permission', async () => {
        const permissions = [
            'locations:read', 'locations:write', 'locations:delete',
            'users:read', 'users:write', 'users:admin',
            'shifts:read', 'shifts:write', 'shifts:delete',
            'schedules:read', 'schedules:write', 'schedules:publish',
            'billing:write', 'admin:write',
        ];

        for (const permission of permissions) {
            await expect(can('SUPER_ADMIN', permission)).resolves.toBe(true);
        }
    });

    it('ADMIN has operational access but no platform-admin permission', async () => {
        const allowed = [
            'locations:read', 'locations:write', 'locations:delete',
            'users:read', 'users:write', 'users:admin',
            'shifts:read', 'shifts:write', 'shifts:delete',
            'schedules:read', 'schedules:write', 'schedules:publish',
            'billing:write',
        ];

        for (const permission of allowed) {
            await expect(can('ADMIN', permission)).resolves.toBe(true);
        }

        await expect(can('ADMIN', 'admin:write')).resolves.toBe(false);
    });

    it('MANAGER can run scheduling + invites but cannot do admin-only actions', async () => {
        const allowed = [
            'locations:read',
            'users:read', 'users:write',
            'shifts:read', 'shifts:write',
            'schedules:read', 'schedules:write', 'schedules:publish',
        ];
        const denied = [
            'locations:delete',
            'users:admin',
            'shifts:delete',
            'billing:write',
            'admin:write',
        ];

        for (const permission of allowed) {
            await expect(can('MANAGER', permission)).resolves.toBe(true);
        }
        for (const permission of denied) {
            await expect(can('MANAGER', permission)).resolves.toBe(false);
        }
    });

    it('STAFF is read-only for operational resources', async () => {
        const allowed = ['locations:read', 'shifts:read', 'schedules:read'];
        const denied = [
            'locations:write', 'locations:delete',
            'users:read', 'users:write', 'users:admin',
            'shifts:write', 'shifts:delete',
            'schedules:write', 'schedules:publish',
            'billing:write', 'admin:write',
        ];

        for (const permission of allowed) {
            await expect(can('STAFF', permission)).resolves.toBe(true);
        }
        for (const permission of denied) {
            await expect(can('STAFF', permission)).resolves.toBe(false);
        }
    });
});
