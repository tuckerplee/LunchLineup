import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fetchAllBoundedPages } from '../../lib/bounded-pagination';

describe('bounded pagination client', () => {
  it('preserves explicit window filters while following continuation cursors', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: 'row-1' }],
        pagination: { hasMore: true, nextCursor: 'cursor-1' },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'row-2' }],
        pagination: { hasMore: false, nextCursor: null },
      });

    const rows = await fetchAllBoundedPages(
      '/shifts?startDate=start&endDate=end&locationId=loc-1&limit=200',
      fetchPage,
    );

    expect(rows).toEqual([{ id: 'row-1' }, { id: 'row-2' }]);
    expect(fetchPage).toHaveBeenNthCalledWith(
      2,
      '/shifts?startDate=start&endDate=end&locationId=loc-1&limit=200&cursor=cursor-1',
    );
  });

  it('keeps backward compatibility with list responses that omit pagination metadata', async () => {
    await expect(fetchAllBoundedPages('/schedules?limit=100', async () => ({
      data: [{ id: 'schedule-1' }],
    }))).resolves.toEqual([{ id: 'schedule-1' }]);
  });

  it('rejects missing or repeated continuation cursors', async () => {
    await expect(fetchAllBoundedPages('/schedules?limit=100', async () => ({
      data: [],
      pagination: { hasMore: true, nextCursor: null },
    }))).rejects.toThrow('new continuation cursor');

    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ data: [], pagination: { hasMore: true, nextCursor: 'same' } })
      .mockResolvedValueOnce({ data: [], pagination: { hasMore: true, nextCursor: 'same' } });
    await expect(fetchAllBoundedPages('/schedules?limit=100', fetchPage)).rejects.toThrow(
      'new continuation cursor',
    );
  });

  it('caps continuation work even when the server keeps returning new cursors', async () => {
    let next = 0;
    await expect(fetchAllBoundedPages(
      '/shifts?limit=200',
      async () => ({ data: [], pagination: { hasMore: true, nextCursor: `cursor-${next += 1}` } }),
      2,
    )).rejects.toThrow('continuation limit');
  });

  it('uses the bounded v2 board for scheduling while retained list screens keep bounded continuation', () => {
    const schedulingPage = readFileSync(
      new URL('../../app/dashboard/scheduling/page.tsx', import.meta.url),
      'utf8',
    );
    expect(schedulingPage).toContain('apiV2.getScheduleBoard(');
    expect(schedulingPage).not.toContain('fetchAllBoundedPages(');
    expect(schedulingPage).not.toContain("'/shifts/staff-roster?limit=200'");
    expect(schedulingPage).not.toContain('/api/v1');

    const lunchPage = readFileSync(
      new URL('../../app/dashboard/lunch-breaks/page.tsx', import.meta.url),
      'utf8',
    );
    expect(lunchPage).toContain('fetchAllBoundedPages(');
    expect(lunchPage).toContain("'/shifts/staff-roster?limit=200'");

    const timeCardApi = readFileSync(
      new URL('../../app/dashboard/time-cards/time-card-api.ts', import.meta.url),
      'utf8',
    );
    expect(timeCardApi).toContain('fetchAllBoundedPages(');
    expect(timeCardApi).toContain('const LOCATION_PAGE_SIZE = 200;');
    expect(timeCardApi).toContain("'/shifts/staff-roster?limit=' + LOCATION_PAGE_SIZE");

    expect(lunchPage).toContain("query.set('limit', '200')");
    expect(lunchPage).toContain('const pageRows = await fetchAllBoundedPages(');

    const dashboard = readFileSync(
      new URL('../../app/dashboard/DashboardWorkspace.tsx', import.meta.url),
      'utf8',
    );
    expect(dashboard).toContain("dashboardWindowPath('/lunch-breaks', 0, 7)");
    expect(dashboard).toContain('fetchBoundedJsonResult<ApiLunchBreak>(lunchBreakPath)');
  });
});
