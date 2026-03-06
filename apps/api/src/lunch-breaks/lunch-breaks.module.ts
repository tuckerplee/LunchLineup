import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { LunchBreaksController } from './lunch-breaks.controller';
import { LunchBreaksService } from './lunch-breaks.service';

@Module({
    imports: [BillingModule],
    controllers: [LunchBreaksController],
    providers: [LunchBreaksService],
})
export class LunchBreaksModule { }

