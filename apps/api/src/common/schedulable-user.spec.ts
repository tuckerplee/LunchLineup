import { lockActiveSchedulableUser } from './schedulable-user';
import { describe, expect, it, vi } from 'vitest';

describe('schedulable user eligibility', () => {
    it('locks one active manager or staff user in the tenant', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'staff-1' }]),
        };

        await expect(lockActiveSchedulableUser(tx as any, 'tenant-1', 'staff-1'))
            .resolves.toEqual({ id: 'staff-1' });

        const query = tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray;
        const sql = Array.from(query).join(' ');
        expect(sql).toContain('FROM "User"');
        expect(sql).toContain('"tenantId"');
        expect(sql).toContain('"role" IN');
        expect(sql).toContain('"deletedAt" IS NULL');
        expect(sql).toContain('"suspendedAt" IS NULL');
        expect(sql).toContain('FOR UPDATE');
    });

    it('returns null when the locked user is not assignable', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
        };

        await expect(lockActiveSchedulableUser(tx as any, 'tenant-1', 'admin-1'))
            .resolves.toBeNull();
    });
});
