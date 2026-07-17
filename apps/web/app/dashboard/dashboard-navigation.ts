import {
  CalendarDays,
  Clock3,
  HandCoins,
  LayoutGrid,
  MapPin,
  Settings,
  Shield,
  Users,
  UtensilsCrossed,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { getWorkspaceCapabilities, type PermissionList } from '../../lib/permissions';

export type DashboardNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact: boolean;
  priority?: 'strong';
};

type DashboardProfileSummary = {
  email?: string | null;
  name?: string | null;
  username?: string | null;
};

const NAV_ITEMS: DashboardNavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutGrid, exact: true },
  { href: '/dashboard/scheduling', label: 'Calendar', icon: CalendarDays, exact: false, priority: 'strong' },
  { href: '/dashboard/lunch-breaks', label: 'Lunch & Breaks', icon: UtensilsCrossed, exact: false },
  { href: '/dashboard/time-cards', label: 'Time Cards', icon: Clock3, exact: false },
  { href: '/dashboard/payroll', label: 'Payroll', icon: HandCoins, exact: false },
  { href: '/dashboard/staff', label: 'Staff', icon: Users, exact: false },
  { href: '/dashboard/locations', label: 'Locations', icon: MapPin, exact: false },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, exact: false },
];

const ADMIN_NAV_ITEM: DashboardNavItem = { href: '/admin', label: 'Admin Console', icon: Shield, exact: false };

export function getVisibleDashboardNavItems(permissions: PermissionList): DashboardNavItem[] {
  const capabilities = getWorkspaceCapabilities(permissions);
  const navItems = NAV_ITEMS.filter((item) => {
    if (item.href === '/dashboard/scheduling') return capabilities.canReadScheduling;
    if (item.href === '/dashboard/lunch-breaks') return capabilities.canReadLunchBreaks;
    if (item.href === '/dashboard/staff') return capabilities.canReadUsers;
    if (item.href === '/dashboard/time-cards') return capabilities.canReadTimeCards;
    if (item.href === '/dashboard/payroll') return capabilities.canReadPayroll;
    if (item.href === '/dashboard/locations') return capabilities.canReadLocations;
    if (item.href === '/dashboard/settings') return capabilities.canReadSettings;
    return true;
  });

  return capabilities.hasAdminPortal ? [...navItems, ADMIN_NAV_ITEM] : navItems;
}

export function canOpenDashboardAccountSettings(permissions: PermissionList): boolean {
  return getWorkspaceCapabilities(permissions).canReadSettings;
}

export function getDashboardCurrentPage(pathname: string, navItems: readonly DashboardNavItem[]): string {
  const match = navItems.find((item) => (item.exact ? pathname === item.href : pathname.startsWith(item.href)));
  return match?.label ?? 'Workspace';
}

export function getDashboardUserInitials(profile: DashboardProfileSummary | null | undefined): string {
  const source = (profile?.name || profile?.username || profile?.email || 'User').trim();
  const parts = source.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
  }

  return source.slice(0, 2).toUpperCase();
}
