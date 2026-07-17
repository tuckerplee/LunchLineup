export type AdminListPagination = {
    hasMore: boolean;
    nextCursor: string | null;
};

export const EMPTY_ADMIN_LIST_PAGINATION: AdminListPagination = {
    hasMore: false,
    nextCursor: null,
};

export function parseAdminListPagination(value: unknown): AdminListPagination {
    if (!value || typeof value !== 'object') return EMPTY_ADMIN_LIST_PAGINATION;
    const pagination = value as { hasMore?: unknown; nextCursor?: unknown };
    const nextCursor = typeof pagination.nextCursor === 'string' && pagination.nextCursor
        ? pagination.nextCursor
        : null;
    return {
        hasMore: pagination.hasMore === true && nextCursor !== null,
        nextCursor,
    };
}

export function mergeAdminListPage<T extends { id: string }>(
    current: T[],
    incoming: T[],
    append: boolean,
): T[] {
    if (!append) return incoming;
    const rows = new Map(current.map((row) => [row.id, row]));
    for (const row of incoming) rows.set(row.id, row);
    return Array.from(rows.values());
}

export function retainAdminListSelection<T extends { id: string }>(
    rows: T[],
    selected: T | null | undefined,
): T[] {
    if (!selected || rows.some((row) => row.id === selected.id)) return rows;
    return [selected, ...rows];
}

export function buildAdminListPath(
    pathname: string,
    values: Record<string, string | number | null | undefined>,
): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value !== null && String(value) !== '') {
            params.set(key, String(value));
        }
    }
    const query = params.toString();
    return query ? pathname + '?' + query : pathname;
}