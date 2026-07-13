import { requirePermission, canPermission } from '@/lib/server-auth';
import { TimeCardsWorkspace } from './TimeCardsWorkspace';

export default async function TimeCardsPage() {
    const user = await requirePermission('time_cards:read');
    return (
        <TimeCardsWorkspace
            canManageTeam={canPermission(user, 'users:read') && canPermission(user, 'shifts:read')}
            canReadLocations={canPermission(user, 'locations:read')}
            canWriteTimeCards={canPermission(user, 'time_cards:write')}
            currentUserId={user.id}
        />
    );
}
