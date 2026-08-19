import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { EmailDeliveryModule } from '../email-delivery/email-delivery.module';

@Module({
    imports: [EmailDeliveryModule],
    controllers: [NotificationsController],
    providers: [TenantPrismaService, NotificationsService],
    exports: [NotificationsService],
})
export class NotificationsModule { }
