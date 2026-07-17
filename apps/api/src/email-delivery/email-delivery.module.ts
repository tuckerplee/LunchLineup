import { Module } from '@nestjs/common';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { EmailDeliveryFeedbackController } from './email-delivery-feedback.controller';
import { EmailDeliveryFeedbackService } from './email-delivery-feedback.service';

@Module({
    controllers: [EmailDeliveryFeedbackController],
    providers: [TenantPrismaService, EmailDeliveryFeedbackService],
    exports: [EmailDeliveryFeedbackService],
})
export class EmailDeliveryModule {}
