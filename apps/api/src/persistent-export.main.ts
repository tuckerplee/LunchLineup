import { NotificationOutboxProcessor } from './notifications/notification-outbox.processor';
import { AvailabilityImportPublisher } from './availability-imports/availability-imports.publisher';
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
    const effect = selectedPersistentProducer();
    const service = effect === 'generate-exact-export'
        ? new TenantExportService(database, undefined, { startWorker: false })
        : effect === 'publish-exact-schedule'
            ? new ScheduleSolveOutboxPublisher(database)
            : effect === 'publish-exact-import' || effect === 'reconcile-exact-import-acceptance'
                ? new AvailabilityImportPublisher(database)
                : new NotificationOutboxProcessor(database);
    try { await runPersistentExportConsumer(service); }
    finally { await database.onModuleDestroy(); }
}
void main().catch(() => { console.error('Persistent export consumer unresolved.'); process.exitCode = 1; });
