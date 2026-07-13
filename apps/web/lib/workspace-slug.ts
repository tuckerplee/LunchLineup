export const WORKSPACE_SLUG_STORAGE_KEY = 'lunchlineup:last-workspace-slug';

type WorkspaceSlugStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function normalizeWorkspaceSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

export function rememberWorkspaceSlug(storage: WorkspaceSlugStorage, value: string): string {
  const workspaceSlug = normalizeWorkspaceSlug(value);
  if (workspaceSlug) {
    try {
      storage.setItem(WORKSPACE_SLUG_STORAGE_KEY, workspaceSlug);
    } catch {
      // The completion screen still exposes the slug when browser storage is unavailable.
    }
  }
  return workspaceSlug;
}

export function readRememberedWorkspaceSlug(storage: WorkspaceSlugStorage): string {
  try {
    return normalizeWorkspaceSlug(storage.getItem(WORKSPACE_SLUG_STORAGE_KEY) ?? '');
  } catch {
    return '';
  }
}
