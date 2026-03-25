import { requirePermission } from '@/lib/server-auth';
import { TenantsClient } from './TenantsClient';

export default function AdminTenantsPage() {
    requirePermission('admin_portal:access');

    return <TenantsClient />;
}
