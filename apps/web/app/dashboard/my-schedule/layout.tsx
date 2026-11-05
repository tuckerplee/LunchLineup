import { redirect } from 'next/navigation';

import { hasSchedulingReadAccess } from '../../../lib/permissions';
import { requireAuth } from '../../../lib/server-auth';

export default async function MyScheduleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAuth();

  if (!hasSchedulingReadAccess(user.permissions)) {
    redirect('/dashboard');
  }

  return children;
}
