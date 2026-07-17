import { requirePermission, canPermission } from '@/lib/server-auth';
import { LocationsWorkspace } from './LocationsWorkspace';

export default async function LocationsPage() {
    const user = await requirePermission('locations:read');
    const canWrite = canPermission(user, 'locations:write');
    const canDelete = canPermission(user, 'locations:delete');

    return <LocationsWorkspace canWrite={canWrite} canDelete={canDelete} />;
}
