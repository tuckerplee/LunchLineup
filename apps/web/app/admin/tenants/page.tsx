import { requireRole } from '@/lib/server-auth';
import { TenantsClient } from './TenantsClient';

export default function AdminTenantsPage() {
    requireRole(['SUPER_ADMIN']);

    return <TenantsClient />;
}
