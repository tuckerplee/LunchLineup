import { requirePermission, canPermission } from '@/lib/server-auth';
import { SettingsWorkspace } from './SettingsWorkspace';

export default async function SettingsPage() {
    const user = await requirePermission('settings:read');

    return (
        <SettingsWorkspace
            canWriteSettings={canPermission(user, 'settings:write')}
            canReadBilling={canPermission(user, 'billing:read')}
            canManageBilling={canPermission(user, 'billing:write')}
            canExportAccount={canPermission(user, 'account:data_export')}
            canManageAccountLifecycle={canPermission(user, 'tenant_account:lifecycle')}
        />
    );
}
