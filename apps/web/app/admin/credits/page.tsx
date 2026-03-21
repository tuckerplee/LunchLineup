import { requireRole } from '@/lib/server-auth';
import { CreditsClient } from './CreditsClient';

export default function AdminCreditsPage() {
    requireRole(['SUPER_ADMIN']);

    return <CreditsClient />;
}
