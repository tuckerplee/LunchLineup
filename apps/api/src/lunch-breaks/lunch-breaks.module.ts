import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { AuthModule } from '../auth/auth.module';
import { LunchBreaksController } from './lunch-breaks.controller';
import { LunchBreaksService } from './lunch-breaks.service';

@Module({
    imports: [BillingModule, AuthModule],
    controllers: [LunchBreaksController],
    providers: [LunchBreaksService],
})
export class LunchBreaksModule { }
