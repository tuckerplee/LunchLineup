import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaClient } from '@lunchlineup/db';
import { NOTIFICATIONS_PRISMA } from './notifications.constants';
import { NotificationsController } from './notifications.controller';

const prismaProvider = {
    provide: NOTIFICATIONS_PRISMA,
    useFactory: () => new PrismaClient()
};

@Module({
    controllers: [NotificationsController],
    providers: [NotificationsService, prismaProvider],
    exports: [NotificationsService],
})
export class NotificationsModule { }
