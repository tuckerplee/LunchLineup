import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    resolve(import.meta.dirname, '../../app/admin/users/AdminUsersWorkspace.tsx'),
    'utf8',
);

describe('platform admin user account safety wiring', () => {
    it('keeps tenant assignment read-only and omits tenantId from account updates', () => {
        expect(source).toContain('Tenant assignment (read-only)');
        expect(source).toContain('Cross-tenant reassignment is blocked');
        expect(source).toMatch(/id="admin-user-tenant-assignment"[\s\S]*?disabled[\s\S]*?>/);
        expect(source).not.toMatch(/tenantId:\s*form\.tenantId/);
    });

    it('still submits bounded identity and role fields through the admin endpoint', () => {
        expect(source).toContain("await writeJson(`/admin/users/${selectedUser.id}`, 'PUT', {");
        expect(source).toContain('email: email || null');
        expect(source).toContain('role: form.role');
    });
});
