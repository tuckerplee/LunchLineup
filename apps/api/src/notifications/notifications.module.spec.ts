import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../common/metrics.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { NotificationsModule } from './notifications.module';
import { NotificationsService } from './notifications.service';

describe('NotificationsModule', () => {
    it('injects the shared metrics service into notification outbox reporting', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
                NotificationsModule,
            ],
            providers: [MetricsService],
        })
            .overrideProvider(ConfigService)
            .useValue({ get: vi.fn().mockReturnValue(undefined) })
            .overrideProvider(TenantPrismaService)
            .useValue({})
            .compile();

        try {
            const notifications = moduleRef.get(NotificationsService);
            const metrics = moduleRef.get(MetricsService);
            const start = vi
                .spyOn((notifications as any).outbox, 'start')
                .mockImplementation(() => undefined);

            notifications.onModuleInit();

            (notifications as any).outbox.recordOutcome('delivered');
            (notifications as any).outbox.setDeadLetteredCount(2);

            const output = await metrics.getMetrics();
            expect(output).toContain(
                'lunchlineup_notification_outbox_total{status="delivered",app="lunchlineup-api"} 1',
            );
            expect(output).toContain(
                'lunchlineup_notification_outbox_dead_lettered{app="lunchlineup-api"} 2',
            );
            expect(start).toHaveBeenCalledOnce();
        } finally {
            await moduleRef.close();
        }
    });
});
