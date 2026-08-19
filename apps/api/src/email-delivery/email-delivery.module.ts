import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { EmailDeliveryFeedbackController } from './email-delivery-feedback.controller';
import { EmailDeliveryFeedbackService } from './email-delivery-feedback.service';
import { SchedulePublishedEmailService } from './schedule-published-email.service';

@Module({
    imports: [ConfigModule],
    controllers: [EmailDeliveryFeedbackController],
    providers: [TenantPrismaService, EmailDeliveryFeedbackService, SchedulePublishedEmailService],
    exports: [EmailDeliveryFeedbackService, SchedulePublishedEmailService],
})
export class EmailDeliveryModule {}
