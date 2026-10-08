import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { AvailabilityImportsController } from './availability-imports.controller';
import { AvailabilityImportPublisher } from './availability-imports.publisher';
import { AvailabilityImportsService } from './availability-imports.service';

@Module({
    imports: [AuthModule, BillingModule],
    controllers: [AvailabilityImportsController],
    providers: [TenantPrismaService, AvailabilityImportPublisher, AvailabilityImportsService],
})
export class AvailabilityImportsModule {}
