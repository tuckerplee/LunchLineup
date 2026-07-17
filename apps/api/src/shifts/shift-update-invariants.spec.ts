import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
    assertShiftUpdateWindow,
    assertShiftUpdateWithinSchedule,
    mapShiftUpdateInvariantError,
    translateShiftBreakWindows,
} from './shift-update-invariants';

describe('shift update invariants', () => {
    it('translates every break by the shift-start delta', () => {
        const translated = translateShiftBreakWindows(
            [
                {
                    id: 'break-1',
                    startTime: new Date('2026-03-10T18:00:00.000Z'),
                    endTime: new Date('2026-03-10T18:15:00.000Z'),
                },
                {
                    id: 'lunch-1',
                    startTime: new Date('2026-03-10T19:00:00.000Z'),
                    endTime: new Date('2026-03-10T19:30:00.000Z'),
                },
            ],
            new Date('2026-03-10T17:00:00.000Z'),
            new Date('2026-03-10T19:00:00.000Z'),
            new Date('2026-03-10T23:00:00.000Z'),
        );

        expect(translated.map((row) => [row.startTime.toISOString(), row.endTime.toISOString()])).toEqual([
            ['2026-03-10T20:00:00.000Z', '2026-03-10T20:15:00.000Z'],
            ['2026-03-10T21:00:00.000Z', '2026-03-10T21:30:00.000Z'],
        ]);
    });

    it('rejects resize results that strand, overlap, or corrupt breaks', () => {
        const shiftStart = new Date('2026-03-10T17:00:00.000Z');
        const shiftEnd = new Date('2026-03-10T21:00:00.000Z');
        expect(() => translateShiftBreakWindows(
            [{ id: 'break-1', startTime: new Date('2026-03-10T20:00:00.000Z'), endTime: new Date('2026-03-10T20:30:00.000Z') }],
            shiftStart,
            shiftStart,
            new Date('2026-03-10T20:15:00.000Z'),
        )).toThrow(ConflictException);
        expect(() => translateShiftBreakWindows(
            [
                { id: 'break-1', startTime: new Date('2026-03-10T18:00:00.000Z'), endTime: new Date('2026-03-10T18:30:00.000Z') },
                { id: 'break-2', startTime: new Date('2026-03-10T18:15:00.000Z'), endTime: new Date('2026-03-10T18:45:00.000Z') },
            ],
            shiftStart,
            shiftStart,
            shiftEnd,
        )).toThrow(ConflictException);
    });

    it('uses conflicts for invalid update and schedule windows', () => {
        expect(() => assertShiftUpdateWindow(
            new Date('2026-03-10T17:00:00.000Z'),
            new Date('2026-03-10T16:00:00.000Z'),
        )).toThrow(ConflictException);
        expect(() => assertShiftUpdateWithinSchedule(
            new Date('2026-03-10T17:00:00.000Z'),
            new Date('2026-03-11T05:00:00.000Z'),
            {
                startDate: new Date('2026-03-10T04:00:00.000Z'),
                endDate: new Date('2026-03-11T04:00:00.000Z'),
            },
        )).toThrow(ConflictException);
    });

    it('maps known deferred database invariants to conflict without hiding unrelated errors', () => {
        const mapped = mapShiftUpdateInvariantError({
            code: 'P2004',
            meta: { database_error: 'Shift shift-1 cannot move outside one of its break windows' },
        });
        const unrelated = new BadRequestException('Unrelated request error');

        expect(mapped).toBeInstanceOf(ConflictException);
        expect((mapped as ConflictException).getStatus()).toBe(409);
        expect(mapShiftUpdateInvariantError(unrelated)).toBe(unrelated);
    });
});
