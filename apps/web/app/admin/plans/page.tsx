import { requirePermission } from '@/lib/server-auth';
import { AdminPlansWorkspace } from './PlansClient';

export default async function AdminPlansPage() {
    await requirePermission('admin_portal:access');

    return <AdminPlansWorkspace />;
}
