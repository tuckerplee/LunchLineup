import { requirePermission } from '@/lib/server-auth';
import { TenantsClient } from './TenantsClient';

export default async function AdminTenantsPage() {
    await requirePermission('admin_portal:access');

    return <TenantsClient />;
}
