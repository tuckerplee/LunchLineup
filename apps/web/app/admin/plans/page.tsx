import { requirePermission } from '@/lib/server-auth';
import { AdminPlansWorkspace } from './PlansClient';

export default function AdminPlansPage() {
    requirePermission('admin_portal:access');

    return <AdminPlansWorkspace />;
}
