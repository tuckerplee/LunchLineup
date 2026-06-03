import { requirePermission, canPermission } from '@/lib/server-auth';
import { LocationsWorkspace } from './LocationsWorkspace';

export default async function LocationsPage() {
    const user = await requirePermission('locations:read');
    const canAdd = canPermission(user, 'locations:write');

    return <LocationsWorkspace canAdd={canAdd} />;
}
