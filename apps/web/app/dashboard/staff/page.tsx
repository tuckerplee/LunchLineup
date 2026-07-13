import { requirePermission, canPermission } from '@/lib/server-auth';
import { StaffWorkspace } from './StaffWorkspace';

export default async function StaffPage() {
    const user = await requirePermission('users:read');
    return (
        <StaffWorkspace
            currentUserId={user.id}
            canInvite={canPermission(user, 'users:write')}
            canAdminister={canPermission(user, 'users:admin')}
            canReadRoles={canPermission(user, 'roles:read')}
            canAssignRoles={canPermission(user, 'roles:assign')}
            canManageRoles={canPermission(user, 'roles:write')}
            canManageSchedulingProfiles={canPermission(user, 'users:write')}
        />
    );
}
