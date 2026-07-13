import { describe, it, expect, beforeAll } from 'vitest';
import { Enforcer, MODEL_PATH, POLICY_PATH, newEnforcer } from '@lunchlineup/rbac';
import { ALL_PERMISSION_KEYS, DEFAULT_ROLE_DEFINITIONS } from './rbac.service';

const MANAGED_POLICY_ROLES = ['ADMIN', 'MANAGER', 'STAFF'] as const;

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
        for (const permission of ALL_PERMISSION_KEYS) {
            await expect(can('SUPER_ADMIN', permission)).resolves.toBe(true);
        }
    });

    it.each(MANAGED_POLICY_ROLES)('%s package policy matches API default role definition', async (role) => {
        const definition = DEFAULT_ROLE_DEFINITIONS.find((item) => item.legacyRole === role);
        const expected = new Set(definition?.permissions ?? []);

        for (const permission of ALL_PERMISSION_KEYS) {
            await expect(can(role, permission)).resolves.toBe(expected.has(permission));
        }
    });

    it('STAFF cannot mutate scheduling resources', async () => {
        await expect(can('STAFF', 'shifts:write')).resolves.toBe(false);
        await expect(can('STAFF', 'shifts:delete')).resolves.toBe(false);
        await expect(can('STAFF', 'schedules:write')).resolves.toBe(false);
        await expect(can('STAFF', 'schedules:publish')).resolves.toBe(false);
        await expect(can('STAFF', 'lunch_breaks:write')).resolves.toBe(false);
        await expect(can('STAFF', 'lunch_breaks:delete')).resolves.toBe(false);
    });

    it('tenant admins can use tenant account lifecycle permission by default', async () => {
        await expect(can('SUPER_ADMIN', 'tenant_account:lifecycle')).resolves.toBe(true);
        await expect(can('ADMIN', 'tenant_account:lifecycle')).resolves.toBe(true);
        await expect(can('MANAGER', 'tenant_account:lifecycle')).resolves.toBe(false);
        await expect(can('STAFF', 'tenant_account:lifecycle')).resolves.toBe(false);
    });

    it('keeps full export admin-only while allowing staff email OTP login', async () => {
        await expect(can('ADMIN', 'account:data_export')).resolves.toBe(true);
        await expect(can('MANAGER', 'account:data_export')).resolves.toBe(false);
        await expect(can('STAFF', 'account:data_export')).resolves.toBe(false);
        await expect(can('STAFF', 'auth:login_email')).resolves.toBe(true);
    });
});
