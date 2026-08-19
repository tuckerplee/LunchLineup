'use client';

import Link from 'next/link';
import { Ellipsis, LogOut } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { DashboardMobileNavGroups, DashboardNavItem } from './dashboard-navigation';

type DashboardMobileNavigationProps = DashboardMobileNavGroups & {
  pathname: string;
};

function isActive(pathname: string, item: DashboardNavItem): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}

export function DashboardMobileNavigation({ pathname, primary, more }: DashboardMobileNavigationProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreIsActive = more.some((item) => isActive(pathname, item));

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress);
  }, [moreOpen]);

  function focusMenuItem(position: 'first' | 'last') {
    window.requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
      const target = position === 'first' ? items?.[0] : items?.[Math.max(0, (items?.length ?? 1) - 1)];
      target?.focus();
    });
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && moreOpen) {
      event.preventDefault();
      setMoreOpen(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setMoreOpen(true);
    focusMenuItem(event.key === 'ArrowDown' ? 'first' : 'last');
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setMoreOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  return (
    <nav className="workspace-mobile-navigation" aria-label="Mobile primary navigation">
      {primary.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`workspace-mobile-nav-link ${active ? 'active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={19} aria-hidden="true" />
            <span>{item.mobileLabel}</span>
          </Link>
        );
      })}

      <div className="workspace-mobile-more" ref={wrapperRef}>
        <button
          ref={triggerRef}
          type="button"
          className={`workspace-mobile-nav-link workspace-mobile-more-trigger ${moreIsActive ? 'active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-controls="dashboard-mobile-more-menu"
          onClick={() => setMoreOpen((open) => !open)}
          onKeyDown={handleTriggerKeyDown}
        >
          <Ellipsis size={20} aria-hidden="true" />
          <span>More</span>
        </button>

        {moreOpen ? (
          <div
            ref={menuRef}
            id="dashboard-mobile-more-menu"
            className="workspace-mobile-more-menu"
            role="menu"
            aria-label="More workspace destinations"
            onKeyDown={handleMenuKeyDown}
          >
            {more.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  className={`workspace-mobile-more-item ${active ? 'active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setMoreOpen(false)}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
            <Link
              href="/auth/logout"
              prefetch={false}
              role="menuitem"
              className="workspace-mobile-more-item"
              onClick={() => setMoreOpen(false)}
            >
              <LogOut size={18} aria-hidden="true" />
              <span>Sign out</span>
            </Link>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
