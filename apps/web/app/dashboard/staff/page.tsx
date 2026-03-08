import { requireRole, can, type UserRole } from '@/lib/server-auth';
import { StaffWorkspace } from './StaffWorkspace';

export default function StaffPage() {
    const user = requireRole(['ADMIN', 'MANAGER']);
    const canManage = can(user.role as UserRole, 'manage_users');
    return <StaffWorkspace canManage={canManage} />;
}
