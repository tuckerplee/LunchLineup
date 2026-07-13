import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { TenantPrismaService } from '../database/tenant-prisma.service';

@Module({
    controllers: [NotificationsController],
    providers: [TenantPrismaService, NotificationsService],
    exports: [NotificationsService],
})
export class NotificationsModule { }
