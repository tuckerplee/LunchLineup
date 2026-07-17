export type BoundedPage<T> = {
  data?: T[];
  pagination?: {
    hasMore?: boolean;
    nextCursor?: string | null;
  };
};

export const MAX_BOUNDED_PAGE_REQUESTS = 100;

export async function fetchAllBoundedPages<T>(
  initialPath: string,
  fetchPage: (path: string) => Promise<BoundedPage<T>>,
  maxRequests = MAX_BOUNDED_PAGE_REQUESTS,
): Promise<T[]> {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_BOUNDED_PAGE_REQUESTS) {
    throw new Error(`maxRequests must be between 1 and ${MAX_BOUNDED_PAGE_REQUESTS}.`);
  }

  const rows: T[] = [];
  const seenCursors = new Set<string>();
  let path = initialPath;
  for (let request = 0; request < maxRequests; request += 1) {
    const page = await fetchPage(path);
    if (Array.isArray(page.data)) rows.push(...page.data);
    if (page.pagination?.hasMore !== true) return rows;

    const cursor = page.pagination.nextCursor;
    if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) {
      throw new Error('Paginated response did not provide a new continuation cursor.');
    }
    seenCursors.add(cursor);
    path = withCursor(initialPath, cursor);
  }

  throw new Error('Paginated response exceeded the client continuation limit.');
}

function withCursor(path: string, cursor: string): string {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  const params = new URLSearchParams(queryIndex >= 0 ? path.slice(queryIndex + 1) : '');
  params.set('cursor', cursor);
  return `${pathname}?${params.toString()}`;
}
