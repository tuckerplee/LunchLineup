import { TenantPrismaService } from './database/tenant-prisma.service';
import { TenantExportService } from './admin/tenant-export.service';
import { runPersistentExportConsumer } from './admin/persistent-export-consumer';
import { installProcessShutdownDeadline } from './common/shutdown-deadline';

async function main(): Promise<void> {
    if (process.env.TENANT_EXPORT_PILOT_MODE !== 'true') throw new Error('Closed pilot mode required.');
    installProcessShutdownDeadline();
    const database = new TenantPrismaService();
    // No Nest/AppModule, routes, other outboxes, timer or cleanup producer starts here.
    const exportService = new TenantExportService(database, undefined, { startWorker: false });
    try { await runPersistentExportConsumer(exportService); }
    finally { await database.onModuleDestroy(); }
}
void main().catch(() => { console.error('Persistent export consumer unresolved.'); process.exitCode = 1; });
