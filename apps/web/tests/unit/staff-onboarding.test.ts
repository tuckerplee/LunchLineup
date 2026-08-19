import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildStaffInvitationPayload,
  emailInvitationEnabledFromEnv,
  generateTemporaryPin,
  resolveEmailInvitationAvailability,
  sameRoleSelection,
} from '../../app/dashboard/staff/staff-onboarding';

describe('staff onboarding contract', () => {
  it('builds an email-only invitation payload without hidden PIN fields', () => {
    expect(buildStaffInvitationPayload({
      method: 'email',
      name: '  Avery Email  ',
      email: '  avery@example.test ',
      username: 'must-not-leak',
      pin: '123456',
      roleId: ' role-staff ',
    })).toEqual({
      name: 'Avery Email',
      email: 'avery@example.test',
      roleId: 'role-staff',
    });
  });

  it('builds a PIN-only invitation payload without a hidden email field', () => {
    expect(buildStaffInvitationPayload({
      method: 'pin',
      name: '  Parker Pin  ',
      email: 'must-not-leak@example.test',
      username: '  parker.pin ',
      pin: '246810',
      roleId: '',
    })).toEqual({
      name: 'Parker Pin',
      username: 'parker.pin',
      pin: '246810',
    });
  });

  it('fails email availability closed unless the environment enables it', () => {
    expect(emailInvitationEnabledFromEnv(undefined)).toBe(false);
    expect(emailInvitationEnabledFromEnv('false')).toBe(false);
    expect(emailInvitationEnabledFromEnv(' TRUE ')).toBe(true);
    expect(resolveEmailInvitationAvailability(undefined, false)).toBe(false);
    expect(resolveEmailInvitationAvailability(true, false)).toBe(false);
    expect(resolveEmailInvitationAvailability(false, true)).toBe(false);
    expect(resolveEmailInvitationAvailability(undefined, true)).toBe(true);
  });

  it('generates a six-digit temporary PIN from cryptographic input', () => {
    const pin = generateTemporaryPin((values) => {
      values[0] = 42;
      return values;
    });
    expect(pin).toBe('100042');
    expect(pin).toMatch(/^\d{6}$/);
  });

  it('treats reordered roles as unchanged and actual additions as drafts', () => {
    expect(sameRoleSelection(['role-a', 'role-b'], ['role-b', 'role-a'])).toBe(true);
    expect(sameRoleSelection(['role-a'], ['role-a', 'role-b'])).toBe(false);
  });

  it('keeps credential dismissal and role writes behind explicit actions', () => {
    const staffRoot = resolve(process.cwd(), 'app/dashboard/staff');
    const formSource = readFileSync(resolve(staffRoot, 'AddTeamMemberForm.tsx'), 'utf8');
    const workspaceSource = readFileSync(resolve(staffRoot, 'StaffWorkspace.tsx'), 'utf8');

    expect(formSource).toContain("navigator.clipboard.writeText(credentials.pin)");
    expect(formSource).toContain("disabled={!credentialsAcknowledged}");
    expect(formSource).toContain('I have copied and stored these credentials securely.');
    expect(workspaceSource).toContain('stageUserRoles(user.id, nextRoleIds)');
    expect(workspaceSource).toContain('onClick={() => void updateUserRoles(user.id, draftRoleIds)}');
    expect(workspaceSource).toContain('onClick={() => cancelUserRoleDraft(user.id)}');
  });
});
