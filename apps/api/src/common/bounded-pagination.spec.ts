import { describe, expect, it } from 'vitest';
import {
    MAX_BOUNDED_LIST_LIMIT,
    assertBoundedListWindow,
    buildBoundedListPage,
    decodeBoundedListCursor,
    encodeBoundedListCursor,
    parseBoundedListLimit,
    parseOptionalBoundedDate,
} from './bounded-pagination';

describe('bounded list pagination', () => {
    it('uses a bounded default and enforces the public maximum', () => {
        expect(parseBoundedListLimit(undefined)).toBe(100);
        expect(parseBoundedListLimit(String(MAX_BOUNDED_LIST_LIMIT))).toBe(MAX_BOUNDED_LIST_LIMIT);
        expect(() => parseBoundedListLimit('0')).toThrow('Use 1 through 200');
        expect(() => parseBoundedListLimit('201')).toThrow('Use 1 through 200');
        expect(() => parseBoundedListLimit('1.5')).toThrow('positive integer');
    });

    it('accepts strict UTC windows and rejects reversed or ambiguous dates', () => {
        const startDate = parseOptionalBoundedDate('2026-03-09T07:00:00.000Z', 'startDate');
        const endDate = parseOptionalBoundedDate('2026-03-16T07:00:00.000Z', 'endDate');
        expect(startDate?.toISOString()).toBe('2026-03-09T07:00:00.000Z');
        expect(() => parseOptionalBoundedDate('2026-03-09', 'startDate')).toThrow('UTC ISO 8601');
        expect(() => assertBoundedListWindow({ startDate: endDate, endDate: startDate })).toThrow(
            'endDate must be after startDate',
        );
    });

    it('round-trips opaque timestamp and id cursors', () => {
        const timestamp = new Date('2026-03-09T16:00:00.000Z');
        const cursor = encodeBoundedListCursor(timestamp, 'row-2');
        expect(decodeBoundedListCursor(cursor)).toEqual({ timestamp, id: 'row-2' });
        expect(() => decodeBoundedListCursor('not-a-cursor')).toThrow('Invalid cursor');
    });

    it('returns one bounded page with deterministic continuation metadata', () => {
        const rows = [
            { id: 'row-1', at: new Date('2026-03-09T16:00:00.000Z') },
            { id: 'row-2', at: new Date('2026-03-09T17:00:00.000Z') },
            { id: 'row-3', at: new Date('2026-03-09T18:00:00.000Z') },
        ];
        const page = buildBoundedListPage(rows, 2, (row) => row.at, {
            startDate: new Date('2026-03-09T00:00:00.000Z'),
            endDate: new Date('2026-03-10T00:00:00.000Z'),
        });

        expect(page.data.map((row) => row.id)).toEqual(['row-1', 'row-2']);
        expect(page.pagination).toEqual(expect.objectContaining({
            limit: 2,
            maxLimit: 200,
            returned: 2,
            hasMore: true,
            nextCursor: expect.any(String),
            window: {
                startDate: '2026-03-09T00:00:00.000Z',
                endDate: '2026-03-10T00:00:00.000Z',
            },
        }));
        expect(decodeBoundedListCursor(page.pagination.nextCursor)).toEqual({
            timestamp: rows[1].at,
            id: 'row-2',
        });
    });
});
