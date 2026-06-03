'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarDays, CreditCard, LayoutDashboard, MapPin, Package, Shield, Users, UtensilsCrossed } from 'lucide-react';

const NAV_GROUPS = [
    {
        label: 'Team operations',
        items: [
            { href: '/dashboard/scheduling', label: 'Calendar', icon: CalendarDays },
            { href: '/dashboard', label: 'Team Dashboard', icon: LayoutDashboard, exact: true },
            { href: '/dashboard/lunch-breaks', label: 'Lunch & Breaks', icon: UtensilsCrossed },
            { href: '/dashboard/staff', label: 'Staff', icon: Users },
            { href: '/dashboard/locations', label: 'Locations', icon: MapPin },
        ],
    },
    {
        label: 'Platform admin',
        items: [
            { href: '/admin', label: 'Admin Overview', icon: Shield, exact: true },
            { href: '/admin/tenants', label: 'Tenants', icon: LayoutDashboard },
            { href: '/admin/users', label: 'Users', icon: Users },
            { href: '/admin/credits', label: 'Credits', icon: CreditCard },
            { href: '/admin/plans', label: 'Plans', icon: Package },
        ],
    },
];

export function AdminNav() {
    const pathname = usePathname();

    return (
        <nav style={{ flex: 1, padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {NAV_GROUPS.map((group) => (
                <div key={group.label} style={{ display: 'grid', gap: 4 }}>
                    <div className="workspace-kicker" style={{ padding: '0.35rem 0.55rem', color: 'var(--text-soft)' }}>
                        {group.label}
                    </div>
                    {group.items.map((item) => {
                        const Icon = item.icon;
                        const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`workspace-nav-link ${isActive ? 'active' : ''}`}
                                aria-current={isActive ? 'page' : undefined}
                            >
                                <Icon aria-hidden="true" size={16} />
                                {item.label}
                            </Link>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}
