import { getServerUser, requirePermission } from '@/lib/server-auth';
import { AdminUsersWorkspace } from './AdminUsersWorkspace';

export default function AdminUsersPage() {
    const user = getServerUser();
    requirePermission('admin_portal:access');

    return <AdminUsersWorkspace currentUserId={user?.id ?? null} />;
}
