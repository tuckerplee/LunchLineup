import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { StripeService } from './stripe.service';
import { StripeMeterEventsService } from './stripe-meter-events.service';
import { MeteringService } from './metering.service';
import { FeatureAccessService } from './feature-access.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { StripeMeterErrorService } from './stripe-meter-error.service';

@Module({
    controllers: [BillingController],
    providers: [TenantPrismaService, StripeService, StripeMeterEventsService, StripeMeterErrorService, MeteringService, FeatureAccessService],
    exports: [MeteringService, FeatureAccessService, StripeService],
})
export class BillingModule { }
