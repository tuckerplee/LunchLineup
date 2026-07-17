import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
    assertClockOutWithinPayrollPeriod,
    isPayrollLockConstraint,
    lockTimeCardPayrollContext,
    resolveTimeCardPayrollAssignment,
} from './time-card-payroll-lock';

describe('time-card payroll context', () => {
    it('keeps pre-policy cards operational while snapshotting the location timezone', async () => {
        const tx = {
            payrollPolicyVersion: { findMany: vi.fn().mockResolvedValue([]) },
        } as any;

        await expect(resolveTimeCardPayrollAssignment(
            tx,
            'tenant-1',
            new Date('2026-07-01T16:00:00.000Z'),
            { id: 'location-1', timezone: 'America/Los_Angeles' },
        )).resolves.toEqual({ payrollPeriodId: null, workTimeZone: 'America/Los_Angeles' });
    });

    it('requires a location after an immutable policy becomes effective', async () => {
        const tx = {
            payrollPolicyVersion: {
                findMany: vi.fn().mockResolvedValue([{
                    id: 'policy-1',
                    version: 1,
                    timeZone: 'America/Los_Angeles',
                    effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
                }]),
            },
        } as any;

        await expect(resolveTimeCardPayrollAssignment(
            tx,
            'tenant-1',
            new Date('2026-07-02T16:00:00.000Z'),
            null,
        )).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assigns the effective policy period with a stable work-timezone snapshot', async () => {
        const findFirst = vi.fn().mockResolvedValue({ id: 'period-1' });
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'period-1' }]),
            payrollPolicyVersion: {
                findMany: vi.fn().mockResolvedValue([{
                    id: 'policy-1',
                    version: 1,
                    timeZone: 'America/Los_Angeles',
                    effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
                }]),
            },
            payrollPeriod: { findFirst },
        } as any;

        await expect(resolveTimeCardPayrollAssignment(
            tx,
            'tenant-1',
            new Date('2026-07-02T16:00:00.000Z'),
            { id: 'location-1', timezone: 'America/Los_Angeles' },
        )).resolves.toEqual({ payrollPeriodId: 'period-1', workTimeZone: 'America/Los_Angeles' });
        expect(findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                policyVersionId: 'policy-1',
                status: 'OPEN',
                startsAt: { lte: new Date('2026-07-02T16:00:00.000Z') },
                endsAt: { gt: new Date('2026-07-02T16:00:00.000Z') },
            },
            select: { id: true },
        });
    });

    it('rejects assignment when review wins the shared payroll lock', async () => {
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn().mockResolvedValue([]),
            payrollPolicyVersion: {
                findMany: vi.fn().mockResolvedValue([{
                    id: 'policy-1',
                    version: 1,
                    timeZone: 'UTC',
                    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
                }]),
            },
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue({ id: 'period-1' }) },
        } as any;

        await expect(resolveTimeCardPayrollAssignment(
            tx,
            'tenant-1',
            new Date('2026-07-02T16:00:00.000Z'),
            { id: 'location-1', timezone: 'UTC' },
        )).rejects.toThrow('Payroll period changed while the time card was being created.');
        expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('finds an effective policy beyond the first bounded page of future versions', async () => {
        const futurePolicies = Array.from({ length: 100 }, (_, index) => ({
            id: `future-policy-${index}`,
            version: 200 - index,
            timeZone: 'UTC',
            effectiveFrom: new Date(`2027-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
        }));
        const effectivePolicy = {
            id: 'effective-policy',
            version: 1,
            timeZone: 'UTC',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        };
        const findMany = vi.fn()
            .mockResolvedValueOnce(futurePolicies)
            .mockResolvedValueOnce([effectivePolicy]);
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'period-1' }]),
            payrollPolicyVersion: { findMany },
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue({ id: 'period-1', timeZone: 'UTC' }) },
        } as any;

        await expect(resolveTimeCardPayrollAssignment(
            tx,
            'tenant-1',
            new Date('2026-07-02T16:00:00.000Z'),
            { id: 'location-1', timezone: 'UTC' },
        )).resolves.toEqual({ payrollPeriodId: 'period-1', workTimeZone: 'UTC' });
        expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            cursor: { id: 'future-policy-99' },
            skip: 1,
            take: 100,
        }));
    });

    it('locks period before card and break rows and rejects terminal periods', async () => {
        const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'period-1', status: 'LOCKED' }]);
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: queryRaw,
        } as any;

        await expect(lockTimeCardPayrollContext(
            tx,
            'tenant-1',
            'card-1',
            ['period-1'],
        )).rejects.toBeInstanceOf(ConflictException);
        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    });

    it('allows the exact cutoff and rejects clock-out after the assigned period cutoff', () => {
        const periods = [{
            id: 'period-1',
            startsAt: new Date('2026-07-01T00:00:00.000Z'),
            endsAt: new Date('2026-07-08T00:00:00.000Z'),
        }];

        expect(() => assertClockOutWithinPayrollPeriod(
            'period-1',
            new Date('2026-07-08T00:00:00.000Z'),
            periods,
        )).not.toThrow();
        expect(() => assertClockOutWithinPayrollPeriod(
            'period-1',
            new Date('2026-07-08T00:00:00.001Z'),
            periods,
        )).toThrow('cannot cross');
    });

    it('recognizes database trigger failures without exposing raw details', () => {
        expect(isPayrollLockConstraint(new Error('constraint TimeCard_payroll_period_locked'))).toBe(true);
        expect(isPayrollLockConstraint({ meta: { constraint: 'TimeCardBreak_payroll_period_locked' } })).toBe(true);
        expect(isPayrollLockConstraint(new Error('unrelated'))).toBe(false);
    });
});
