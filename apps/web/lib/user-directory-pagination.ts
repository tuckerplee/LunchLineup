export const USER_DIRECTORY_PAGE_LIMIT = 50;

export type UserDirectoryPageMetadata = {
  hasMore?: boolean;
  nextCursor?: string | null;
};

export function userDirectoryPagePath(cursor?: string | null): string {
  const params = new URLSearchParams({ limit: String(USER_DIRECTORY_PAGE_LIMIT) });
  if (cursor) params.set('cursor', cursor);
  return `/users?${params.toString()}`;
}

export function continuationCursor(metadata?: UserDirectoryPageMetadata): string | null {
  if (metadata?.hasMore !== true) return null;
  if (typeof metadata.nextCursor !== 'string' || !metadata.nextCursor) {
    throw new Error('User directory response did not provide a continuation cursor.');
  }
  return metadata.nextCursor;
}