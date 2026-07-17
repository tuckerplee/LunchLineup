import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ADMIN_LIST_PAGINATION,
  buildAdminListPath,
  mergeAdminListPage,
  parseAdminListPagination,
} from '../../app/admin/admin-list-pagination';

describe('admin list pagination', () => {
  it('accepts only a usable continuation contract', () => {
    expect(parseAdminListPagination({ hasMore: true, nextCursor: 'next-page' })).toEqual({
      hasMore: true,
      nextCursor: 'next-page',
    });
    expect(parseAdminListPagination({ hasMore: true, nextCursor: '' })).toEqual(
      EMPTY_ADMIN_LIST_PAGINATION,
    );
    expect(parseAdminListPagination(null)).toEqual(EMPTY_ADMIN_LIST_PAGINATION);
  });

  it('deduplicates explicit page appends without automatic continuation', () => {
    expect(mergeAdminListPage(
      [{ id: 'a', value: 1 }, { id: 'b', value: 2 }],
      [{ id: 'b', value: 3 }, { id: 'c', value: 4 }],
      true,
    )).toEqual([
      { id: 'a', value: 1 },
      { id: 'b', value: 3 },
      { id: 'c', value: 4 },
    ]);
    expect(mergeAdminListPage([{ id: 'a' }], [{ id: 'b' }], false)).toEqual([{ id: 'b' }]);
  });

  it('builds encoded server-search and named-cursor paths', () => {
    expect(buildAdminListPath('/admin/credits', {
      tenantLimit: 50,
      tenantCursor: 'a/b+c',
      q: 'Acme & West',
      ignored: undefined,
    })).toBe('/admin/credits?tenantLimit=50&tenantCursor=a%2Fb%2Bc&q=Acme+%26+West');
  });

  it('wires explicit tenant and credit continuations without automatic page loops', () => {
    const tenantSource = readFileSync(
      resolve(process.cwd(), 'app/admin/tenants/TenantsClient.tsx'),
      'utf8',
    );
    const creditSource = readFileSync(
      resolve(process.cwd(), 'app/admin/credits/CreditsClient.tsx'),
      'utf8',
    );

    expect(tenantSource).toContain('Load more tenants');
    expect(tenantSource).toContain('pagination.nextCursor');
    expect(tenantSource).toContain('organizations loaded');
    expect(creditSource).toContain('Load more tenant balances');
    expect(creditSource).toContain('Load more ledger history');
    expect(creditSource).toContain('tenantPagination.nextCursor');
    expect(creditSource).toContain('historyPagination.nextCursor');
    expect(tenantSource + creditSource).not.toContain('fetchAllBoundedPages');
  });});