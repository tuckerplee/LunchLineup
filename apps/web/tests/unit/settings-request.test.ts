import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { WorkspaceGeneralSettingsUpdateSchema, WorkspaceTeamSettingsUpdateSchema } from '@lunchlineup/api-contract';
import { generalSettingsRequest, teamSettingsRequest } from '../../app/dashboard/settings/settings-request';

const ajv = new Ajv();
const validateGeneral = ajv.compile(WorkspaceGeneralSettingsUpdateSchema);
const validateTeam = ajv.compile(WorkspaceTeamSettingsUpdateSchema);

describe('settings UI request builders', () => {
    it('normalizes General fields and submits only the canonical schema fields', () => {
        const body = generalSettingsRequest({ organizationName: '  Lunch Team  ', slug: '  MY-Team ', timezone: 'America/Los_Angeles' });
        expect(body).toEqual({ name: 'Lunch Team', slug: 'my-team', timezone: 'America/Los_Angeles' });
        expect(validateGeneral(body)).toBe(true);
        expect(validateGeneral({ ...body, organizationName: 'Lunch Team' })).toBe(false);
    });
    it.each(['STAFF', 'MANAGER'] as const)('submits the canonical Team role %s', defaultRole => {
        const body = teamSettingsRequest({ defaultRole, shiftApprovalPolicy: 'MANAGER_APPROVAL' });
        expect(body.defaultInviteRole).toBe(defaultRole);
        expect(validateTeam(body)).toBe(true);
        expect(validateTeam({ ...body, defaultRole })).toBe(false);
    });
});
