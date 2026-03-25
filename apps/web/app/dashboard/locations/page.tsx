import { requirePermission, canPermission } from '@/lib/server-auth';
import { LocationsWorkspace } from './LocationsWorkspace';

export default function LocationsPage() {
    const user = requirePermission('locations:read');
    const canAdd = canPermission(user, 'locations:write');

    return <LocationsWorkspace canAdd={canAdd} />;
}
