import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const staffRoot = resolve(process.cwd(), 'app/dashboard/staff');

describe('staff workspace permission contract', () => {
  it('keeps invitation and destructive administration on distinct permissions', () => {
    const pageSource = readFileSync(resolve(staffRoot, 'page.tsx'), 'utf8');
    const workspaceSource = readFileSync(resolve(staffRoot, 'StaffWorkspace.tsx'), 'utf8');

    expect(pageSource).toContain('currentUserPublicId={user.publicUserId}');
    expect(pageSource).toContain("canInvite={canPermission(user, 'users:write')}");
    expect(pageSource).toContain("canAdminister={canPermission(user, 'users:admin')}");
    expect(pageSource).toContain("canReadRoles={canPermission(user, 'roles:read')}");
    expect(pageSource).toContain("canAssignRoles={canPermission(user, 'roles:assign')}");
    expect(pageSource).toContain("canManageRoles={canPermission(user, 'roles:write')}");
    expect(pageSource).toContain("canManageSchedulingProfiles={canPermission(user, 'users:write')}");
    expect(pageSource).not.toContain("canPermission(user, 'roles:write') || canPermission(user, 'roles:assign')");
    expect(workspaceSource).toContain('{canInvite ? (');
    expect(workspaceSource).toContain("...(canAdminister || canManageSchedulingProfiles ? ['Actions'] : [])");
    expect(workspaceSource).toContain('{canAdminister && user.id !== currentUserPublicId && !user.email ? (');
    expect(workspaceSource).toContain('{canAdminister && user.id !== currentUserPublicId ? (');
    expect(workspaceSource).toContain("canReadRoles ? fetchWithSession('/users/access/catalog') : Promise.resolve(null)");
    expect(workspaceSource).toContain('roles.filter((role) => role.canDelegate)');
    expect(workspaceSource).toContain("role.id === accessPayload.defaultInviteRoleId");
    expect(workspaceSource).toContain("role.legacyRole === 'STAFF'");
    expect(workspaceSource).toContain('{canAssignRoles && canReadRoles && user.id !== currentUserPublicId ? (');
    expect(workspaceSource).toContain('{canManageRoles && canReadRoles ? (');
    expect(workspaceSource).toContain('{canManageSchedulingProfiles ? (');
    expect(workspaceSource).not.toContain('canManage: boolean');
    expect(workspaceSource).not.toContain('find((role) => role.isDefault)');
  });
});
