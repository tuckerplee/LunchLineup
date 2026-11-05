import { requireAuth } from '@/lib/server-auth';
import { MyScheduleWorkspace } from './MyScheduleWorkspace';

export default async function MySchedulePage() {
  const user = await requireAuth();
  return <MyScheduleWorkspace currentUserId={user.publicUserId} />;
}
