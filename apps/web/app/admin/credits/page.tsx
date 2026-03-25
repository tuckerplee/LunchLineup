import { requirePermission } from '@/lib/server-auth';
import { CreditsClient } from './CreditsClient';

export default function AdminCreditsPage() {
    requirePermission('admin_portal:access');

    return <CreditsClient />;
}
