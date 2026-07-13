import { describe, expect, it, vi } from 'vitest';

import {
  normalizeWorkspaceSlug,
  readRememberedWorkspaceSlug,
  rememberWorkspaceSlug,
  WORKSPACE_SLUG_STORAGE_KEY,
} from '../../lib/workspace-slug';

describe('workspace slug persistence', () => {
  it('normalizes and persists the generated workspace slug', () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() };

    expect(rememberWorkspaceSlug(storage, ' Acme-Dining-ABC123 ')).toBe('acme-dining-abc123');
    expect(storage.setItem).toHaveBeenCalledWith(WORKSPACE_SLUG_STORAGE_KEY, 'acme-dining-abc123');
  });

  it('reads a canonical remembered slug and tolerates unavailable storage', () => {
    expect(readRememberedWorkspaceSlug({
      getItem: vi.fn().mockReturnValue(' Demo Workspace! '),
      setItem: vi.fn(),
    })).toBe('demoworkspace');
    expect(readRememberedWorkspaceSlug({
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      setItem: vi.fn(),
    })).toBe('');
    expect(rememberWorkspaceSlug({
      getItem: vi.fn(),
      setItem: vi.fn(() => { throw new Error('blocked'); }),
    }, 'fallback-slug')).toBe('fallback-slug');
  });

  it('does not persist empty or invalid slug values', () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() };

    expect(normalizeWorkspaceSlug(' !!! ')).toBe('');
    expect(rememberWorkspaceSlug(storage, ' !!! ')).toBe('');
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
