import { requireRole } from '@/lib/server-auth';
import { AdminPlansWorkspace } from './PlansClient';

export default function AdminPlansPage() {
    requireRole(['SUPER_ADMIN']);

    return <AdminPlansWorkspace />;
}
