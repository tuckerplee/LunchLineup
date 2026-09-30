'use client';

import type { AnchorHTMLAttributes } from 'react';
import { handleLogoutNavigation } from '@/lib/logout-navigation';

type LogoutLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'target'>;

// Server layouts can use the same client session boundary without converting
// their permission checks or auth reads into client-side work.
export function LogoutLink(props: LogoutLinkProps) {
  return <a {...props} href="/auth/logout" onClick={handleLogoutNavigation} />;
}
