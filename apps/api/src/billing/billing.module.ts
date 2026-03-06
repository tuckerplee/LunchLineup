import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { StripeService } from './stripe.service';
import { MeteringService } from './metering.service';
import { FeatureAccessService } from './feature-access.service';

@Module({
    controllers: [BillingController],
    providers: [StripeService, MeteringService, FeatureAccessService],
    exports: [MeteringService, FeatureAccessService],
})
export class BillingModule { }
