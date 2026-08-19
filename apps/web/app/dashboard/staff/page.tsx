import { requirePermission, canPermission } from '@/lib/server-auth';
import { StaffWorkspace } from './StaffWorkspace';
import { emailInvitationEnabledFromEnv } from './staff-onboarding';

export default async function StaffPage() {
    const user = await requirePermission('users:read');
    return (
        <StaffWorkspace
            currentUserPublicId={user.publicUserId}
            canInvite={canPermission(user, 'users:write')}
            canAdminister={canPermission(user, 'users:admin')}
            canReadRoles={canPermission(user, 'roles:read')}
            canAssignRoles={canPermission(user, 'roles:assign')}
            canManageRoles={canPermission(user, 'roles:write')}
            canManageSchedulingProfiles={canPermission(user, 'users:write')}
            emailInvitationAvailable={emailInvitationEnabledFromEnv(process.env.STAFF_INVITATION_OUTBOX_ENABLED)}
        />
    );
}
