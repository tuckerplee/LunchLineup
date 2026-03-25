import { requirePermission, canPermission } from '@/lib/server-auth';
import { StaffWorkspace } from './StaffWorkspace';

export default function StaffPage() {
    const user = requirePermission('users:read');
    return (
        <StaffWorkspace
            canManage={canPermission(user, 'users:write')}
            canManageRoles={canPermission(user, 'roles:write') || canPermission(user, 'roles:assign')}
        />
    );
}
