import { TenantPrismaService } from './database/tenant-prisma.service';
import { TenantExportService } from './admin/tenant-export.service';
import { runPersistentExportConsumer, selectedPersistentProducer } from './admin/persistent-export-consumer';
import { ScheduleSolveOutboxPublisher } from './schedules/schedule-solve-outbox.publisher';
import { installProcessShutdownDeadline } from './common/shutdown-deadline';

async function main(): Promise<void> {
    if (process.env.TENANT_EXPORT_PILOT_MODE !== 'true') throw new Error('Closed pilot mode required.');
    installProcessShutdownDeadline();
    const database = new TenantPrismaService();
    // No Nest/AppModule, routes, other outboxes, timer or cleanup producer starts here.
    const service = selectedPersistentProducer() === 'generate-exact-export'
        ? new TenantExportService(database, undefined, { startWorker: false })
        : new ScheduleSolveOutboxPublisher(database);
    try { await runPersistentExportConsumer(service); }
    finally { await database.onModuleDestroy(); }
}
void main().catch(() => { console.error('Persistent export consumer unresolved.'); process.exitCode = 1; });
