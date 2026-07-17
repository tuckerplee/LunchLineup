import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { BillingModule } from '../billing/billing.module';
import { WebhookEndpointsController } from './webhook-endpoints.controller';
import { WebhookDeliveryCrypto } from './webhook-delivery.crypto';
import { WebhookDeliveryStore } from './webhook-delivery.store';
import { WebhooksService } from './webhooks.service';

@Module({
    imports: [AuthModule, BillingModule],
    controllers: [WebhookEndpointsController],
    providers: [TenantPrismaService, WebhookDeliveryCrypto, WebhookDeliveryStore, WebhooksService],
    exports: [WebhookDeliveryStore, WebhooksService],
})
export class WebhooksModule { }
