import { getServerUser, requireRole } from '@/lib/server-auth';
import { AdminUsersWorkspace } from './AdminUsersWorkspace';

export default function AdminUsersPage() {
    const user = getServerUser();
    requireRole(['SUPER_ADMIN']);

    return <AdminUsersWorkspace currentUserId={user?.id ?? null} />;
}
