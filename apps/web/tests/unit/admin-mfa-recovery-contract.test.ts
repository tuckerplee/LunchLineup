import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('platform admin MFA recovery wiring', () => {
    it('requires target-bound confirmation and disables unsafe targets', () => {
        const source = readFileSync(resolve(__dirname, '../../app/admin/users/AdminUsersWorkspace.tsx'), 'utf8');
        expect(source).toContain('const expected = `reset-mfa:${selectedUser.id}`;');
        expect(source).toContain("`/admin/users/${selectedUser.id}/mfa/reset`");
        expect(source).toContain('reason.trim().length < 10');
        expect(source).toContain('isSelf || !selectedUser?.mfaEnabled');
        expect(source).toContain("selectedUser?.status === 'SUSPENDED'");
        expect(source).toContain('disabled={mfaDisabled}');
    });
});
