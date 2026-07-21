import { getServerUser, requirePermission } from '@/lib/server-auth';
import { AdminUsersWorkspace } from './AdminUsersWorkspace';

export default async function AdminUsersPage() {
    const user = await getServerUser();
    await requirePermission('admin_portal:access');

    return <AdminUsersWorkspace currentUserId={user?.publicUserId ?? null} />;
}
