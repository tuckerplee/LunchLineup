import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { PayrollAmendmentService } from './payroll-amendment.service';
import { PayrollCardService } from './payroll-card.service';
import { PayrollController } from './payroll.controller';
import { PayrollExportService } from './payroll-export.service';
import { PayrollLockService } from './payroll-lock.service';
import { PayrollPeriodService } from './payroll-period.service';
import { PayrollPolicyService } from './payroll-policy.service';
import { PayrollReadService } from './payroll-read.service';
import { PayrollReconciliationService } from './payroll-reconciliation.service';

@Module({
    imports: [BillingModule],
    controllers: [PayrollController],
    providers: [
        TenantPrismaService,
        PayrollPolicyService,
        PayrollPeriodService,
        PayrollCardService,
        PayrollAmendmentService,
        PayrollReadService,
        PayrollLockService,
        PayrollExportService,
        PayrollReconciliationService,
    ],
    exports: [
        PayrollPolicyService,
        PayrollPeriodService,
        PayrollCardService,
        PayrollAmendmentService,
        PayrollReadService,
        PayrollLockService,
        PayrollExportService,
        PayrollReconciliationService,
    ],
})
export class PayrollModule {}
