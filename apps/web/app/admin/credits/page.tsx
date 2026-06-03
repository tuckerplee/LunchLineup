import { requirePermission } from '@/lib/server-auth';
import { CreditsClient } from './CreditsClient';

export default async function AdminCreditsPage() {
    await requirePermission('admin_portal:access');

    return <CreditsClient />;
}
