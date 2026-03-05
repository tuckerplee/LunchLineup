import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaClient } from '@lunchlineup/db';

const prismaProvider = {
    provide: PrismaClient,
    useValue: new PrismaClient()
};

@Module({
    providers: [NotificationsService, prismaProvider],
    exports: [NotificationsService],
})
export class NotificationsModule { }
