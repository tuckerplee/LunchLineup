import { prepareForLogout } from './client-api';

type NavigationClick = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

// A server logout changes credentials and must finish as document navigation.
// Cancel the old document's session work only for a same-tab activation.
export function handleLogoutNavigation(event: NavigationClick): void {
  if (event.defaultPrevented || event.button !== 0
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  prepareForLogout();
}
