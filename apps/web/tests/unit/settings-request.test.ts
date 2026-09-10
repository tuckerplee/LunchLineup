import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { WorkspaceGeneralSettingsUpdateSchema, WorkspaceTeamSettingsUpdateSchema } from '@lunchlineup/api-contract';
import { generalSettingsRequest, teamSettingsRequest } from '../../app/dashboard/settings/settings-request';

describe('settings UI request builders', () => {
    it('normalizes General fields and submits only the canonical schema fields', () => {
        const body = generalSettingsRequest({ organizationName: '  Lunch Team  ', slug: '  MY-Team ', timezone: 'America/Los_Angeles' });
        expect(body).toEqual({ name: 'Lunch Team', slug: 'my-team', timezone: 'America/Los_Angeles' });
        expect(Value.Check(WorkspaceGeneralSettingsUpdateSchema, body)).toBe(true);
        expect(Value.Check(WorkspaceGeneralSettingsUpdateSchema, { ...body, organizationName: 'Lunch Team' })).toBe(false);
    });
    it.each(['STAFF', 'MANAGER'] as const)('submits the canonical Team role %s', defaultRole => {
        const body = teamSettingsRequest({ defaultRole, shiftApprovalPolicy: 'MANAGER_APPROVAL' });
        expect(body.defaultInviteRole).toBe(defaultRole);
        expect(Value.Check(WorkspaceTeamSettingsUpdateSchema, body)).toBe(true);
        expect(Value.Check(WorkspaceTeamSettingsUpdateSchema, { ...body, defaultRole })).toBe(false);
    });
});
