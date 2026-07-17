import { describe, expect, it } from 'vitest';
import { canMutateAdminUserLifecycle, resolveAdminUserStatus } from '../../app/admin/users/admin-user-lifecycle';

const active = {
    deletedAt: null,
    suspendedAt: null,
    lockedUntil: null,
    pinLockedUntil: null,
};

describe('admin user lifecycle status', () => {
    it('distinguishes reversible suspension from irreversible deletion', () => {
        expect(resolveAdminUserStatus({ ...active, suspendedAt: '2026-07-15T12:00:00.000Z' })).toBe('SUSPENDED');
        expect(resolveAdminUserStatus({
            ...active,
            suspendedAt: '2026-07-15T12:00:00.000Z',
            deletedAt: '2026-07-15T13:00:00.000Z',
        })).toBe('DELETED');
        expect(canMutateAdminUserLifecycle('SUSPENDED')).toBe(true);
        expect(canMutateAdminUserLifecycle('DELETED')).toBe(false);
    });

    it('reports current locks without treating expired locks as active', () => {
        const now = Date.parse('2026-07-15T12:00:00.000Z');
        expect(resolveAdminUserStatus({ ...active, lockedUntil: '2026-07-15T12:01:00.000Z' }, now)).toBe('LOCKED');
        expect(resolveAdminUserStatus({ ...active, pinLockedUntil: '2026-07-15T11:59:00.000Z' }, now)).toBe('ACTIVE');
    });
});