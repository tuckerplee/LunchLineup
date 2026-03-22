import { requireRole, can, type UserRole } from '@/lib/server-auth';
import { LocationsWorkspace } from './LocationsWorkspace';

export default function LocationsPage() {
    const user = requireRole(['ADMIN', 'MANAGER']);
    const canAdd = can(user.role as UserRole, 'manage_locations');

    return <LocationsWorkspace canAdd={canAdd} />;
}
