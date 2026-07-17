import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  continuationCursor,
  USER_DIRECTORY_PAGE_LIMIT,
  userDirectoryPagePath,
} from '../../lib/user-directory-pagination';

describe('user directory pagination', () => {
  it('builds fixed-size initial and cursor continuation requests', () => {
    expect(USER_DIRECTORY_PAGE_LIMIT).toBe(50);
    expect(userDirectoryPagePath()).toBe('/users?limit=50');
    expect(userDirectoryPagePath('cursor value')).toBe(
      '/users?limit=50&cursor=cursor+value',
    );
  });

  it('requires a fresh cursor whenever the server reports another page', () => {
    expect(continuationCursor({ hasMore: false, nextCursor: 'ignored' })).toBeNull();
    expect(continuationCursor({ hasMore: true, nextCursor: 'next-page' })).toBe('next-page');
    expect(() => continuationCursor({ hasMore: true, nextCursor: null }))
      .toThrow('continuation cursor');
  });

  it('keeps staff continuation explicit and dashboard totals aggregate-backed', () => {
    const staffSource = readFileSync(
      resolve(process.cwd(), 'app/dashboard/staff/StaffWorkspace.tsx'),
      'utf8',
    );
    const dashboardSource = readFileSync(
      resolve(process.cwd(), 'app/dashboard/DashboardWorkspace.tsx'),
      'utf8',
    );

    expect(staffSource).toContain('fetchWithSession(userDirectoryPagePath())');
    expect(staffSource).toContain('parseDirectorySummary(usersPayload.summary)');
    expect(staffSource).toContain('loadDirectoryPage(nextCursor, userPageIndex + 1)');
    expect(staffSource).toContain('userPageCursors[userPageIndex - 1] ?? null');
    expect(staffSource).toContain('Previous');
    expect(staffSource).toContain("isChangingUserPage ? 'Loading...' : 'Next'");
    expect(staffSource).not.toContain('fetchAllBoundedPages');
    expect(dashboardSource).toContain(
      "fetchJsonResult<ApiUserDirectoryResponse>('/users?limit=1')",
    );
    expect(dashboardSource).not.toContain("fetchJsonResult<{ data?: ApiUser[] }>('/users')");
    expect(staffSource + dashboardSource).not.toContain('/users/directory-summary');
    expect(dashboardSource).not.toContain('const staffRows = userRows.filter');
    expect(dashboardSource).toContain("'Staff totals could not be loaded.'");
  });
});
