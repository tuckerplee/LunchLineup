import type { WorkspaceGeneralSettingsUpdate, WorkspaceTeamSettingsUpdate } from '@lunchlineup/api-contract';

export function generalSettingsRequest(form: { organizationName: string; slug: string; timezone: string }) {
    return { name: form.organizationName.trim(), slug: form.slug.trim().toLowerCase(), timezone: form.timezone } satisfies WorkspaceGeneralSettingsUpdate;
}

export function teamSettingsRequest(form: { defaultRole: 'STAFF' | 'MANAGER'; shiftApprovalPolicy: 'AUTO_APPROVE' | 'MANAGER_APPROVAL' | 'ADMIN_APPROVAL' }) {
    return { defaultInviteRole: form.defaultRole, shiftApprovalPolicy: form.shiftApprovalPolicy } satisfies WorkspaceTeamSettingsUpdate;
}
