import { requirePermission, canPermission } from '@/lib/server-auth';
import { StaffWorkspace } from './StaffWorkspace';

export default async function StaffPage() {
    const user = await requirePermission('users:read');
    return (
        <StaffWorkspace
            canManage={canPermission(user, 'users:write')}
            canManageRoles={canPermission(user, 'roles:write') || canPermission(user, 'roles:assign')}
        />
    );
}
