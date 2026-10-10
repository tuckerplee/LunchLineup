import { PersistentCancellationObserver } from './billing/persistent-cancellation-observer';
import { PersistentCancellationObservationStore } from './admin/persistent-cancellation-observation-store';
import { PersistentCancellationProvider } from './billing/persistent-cancellation-provider';
import { PrismaTenantCancellationIntentStore } from './admin/tenant-cancellation-lifecycle.service';
import { ConfigService } from '@nestjs/config';
import { EmailDeliveryFeedbackService } from './email-delivery/email-delivery-feedback.service';
import { SchedulePublishedEmailService } from './email-delivery/schedule-published-email.service';
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
    const config = new ConfigService();
    const persistentEmail = effect === 'deliver-exact-notification-email'
        ? new SchedulePublishedEmailService(config, new EmailDeliveryFeedbackService(config, database))
        : undefined;
    const cancellationProvider = effect === 'apply-exact-customer-cancellation' ? new PersistentCancellationProvider(config) : undefined;
    const service = effect === 'observe-exact-customer-cancellation'
        ? new PersistentCancellationObservationStore(database, new PersistentCancellationObserver(config))
        : effect === 'record-exact-cancellation-request' || effect === 'apply-exact-customer-cancellation' || effect === 'finalize-exact-customer-cancellation' || effect === 'converge-exact-customer-cancellation'
        ? new PrismaTenantCancellationIntentStore(database, undefined, undefined, undefined, undefined, cancellationProvider)
        : effect === 'generate-exact-export'
        ? new TenantExportService(database, undefined, { startWorker: false })
        : effect === 'publish-exact-schedule'
            ? new ScheduleSolveOutboxPublisher(database)
            : effect === 'publish-exact-import' || effect === 'reconcile-exact-import-acceptance'
                ? new AvailabilityImportPublisher(database)
                : new NotificationOutboxProcessor(database, { persistentEmail });
    try { await runPersistentExportConsumer(service); }
    finally { await database.onModuleDestroy(); }
}
void main().catch(() => { console.error('Persistent export consumer unresolved.'); process.exitCode = 1; });
