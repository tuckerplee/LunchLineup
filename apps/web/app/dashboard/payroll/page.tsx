import { redirect } from 'next/navigation';
import { getPayrollCapabilities } from '@/lib/permissions';
import { requireAuth } from '@/lib/server-auth';
import { PayrollWorkspace } from './PayrollWorkspace';

export default async function PayrollPage() {
  const user = await requireAuth();
  const capabilities = getPayrollCapabilities(user.permissions);
  if (!capabilities.canReadPayroll) redirect('/dashboard');
  return <PayrollWorkspace capabilities={capabilities} currentUserId={user.publicUserId} />;
}
