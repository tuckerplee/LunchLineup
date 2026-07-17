import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILLING_OPERATION_POLICY } from './operation-billing-policy';

const readSource = (relativePath: string) => readFileSync(resolve(__dirname, relativePath), 'utf8');

function section(source: string, start: string, end: string): string {
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end, startAt + start.length);
    if (startAt < 0 || endAt < 0) throw new Error(`Missing policy source section: ${start} -> ${end}`);
    return source.slice(startAt, endAt);
}

describe('billing operation policy inventory', () => {
    it('never classifies value-producing work as an entitlement-only control', () => {
        const valueOperations = Object.entries(BILLING_OPERATION_POLICY)
            .filter(([, policy]) => policy.classification === 'value');

        expect(valueOperations.length).toBeGreaterThan(0);
        for (const [operation, policy] of valueOperations) {
            expect(policy.accessPattern, operation).not.toBe('entitlement_only');
            expect(policy.accessPattern, operation).not.toBe('permission_only');
            expect(policy.feature, operation).not.toBeNull();
        }
    });

    it('keeps demand-window mutation, draft creation, and reopen entitlement-only with zero settlement', () => {
        const source = readSource('../schedules/schedules.controller.ts');
        const controls = [
            section(source, 'async replaceDemandWindows(', '@Get(":id/auto-schedule/jobs/:jobId")'),
            section(source, 'async create(@Body()', '@Delete(":id")'),
            section(source, 'async reopen(', 'private normalizeAutoScheduleConstraints'),
        ];

        for (const control of controls) {
            expect(control).toContain('assertFeatureEntitledInTransaction');
            expect(control).not.toContain('assertFeatureEnabledInTransaction');
            expect(control).not.toContain('recordFeatureUsageInTransaction');
            expect(control).not.toContain('creditTransaction.create');
        }
    });

    it('proves schedule generation and publication own exact positive-credit settlement', () => {
        const source = readSource('../schedules/schedules.controller.ts');
        const autoSchedule = section(source, 'async autoSchedule(', '@Post(":id/reopen")');
        const publishSettlement = section(
            source,
            'private async settleSchedulePublishInTransaction(',
            'private async assertDemandWindowsCovered(',
        );

        expect(autoSchedule).toContain('assertFeatureEnabledInTransaction');
        expect(autoSchedule).toContain('reserveAutoScheduleCredit');
        expect(source).toMatch(/reserveAutoScheduleCredit[\s\S]*creditTransaction\.create\([\s\S]*balanceAfter/);
        expect(publishSettlement).toContain('recordFeatureUsageInTransaction');
    });

    it('proves payroll export owns an enabled paid-and-credit gate and exact settlement', () => {
        const source = readSource('../payroll/payroll-export.service.ts');
        const policy = BILLING_OPERATION_POLICY['payroll.export.create'];

        expect(policy).toMatchObject({
            classification: 'value',
            accessPattern: 'exact_credit',
            launchStatus: 'verified',
        });
        expect(source).toMatch(/assertFeatureEnabledInTransaction[\s\S]*recordFeatureUsageInTransaction/);
        expect(source).not.toContain('assertFeatureEntitledInTransaction');
    });

    it('registers manual shifts, clock-in, and availability import with exact settlement owners', () => {
        const cases = [
            {
                operations: ['shifts.create', 'shifts.update', 'shifts.bulk_assign'],
                source: readSource('../shifts/shifts.controller.ts'),
            },
            {
                operations: ['time_cards.clock_in'],
                source: readSource('../time-cards/time-cards.controller.ts'),
            },
            {
                operations: ['availability_imports.create'],
                source: readSource('../availability-imports/availability-imports.service.ts'),
            },
        ] as const;

        for (const entry of cases) {
            expect(entry.source).toContain('assertFeatureEnabledInTransaction');
            expect(entry.source).toContain('recordFeatureUsageInTransaction');
            for (const operation of entry.operations) {
                expect(BILLING_OPERATION_POLICY[operation]).toMatchObject({
                    classification: 'value',
                    accessPattern: 'exact_credit',
                    launchStatus: 'verified',
                });
            }
        }
    });
});
