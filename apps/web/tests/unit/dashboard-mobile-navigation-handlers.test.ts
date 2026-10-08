import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, clientComponentHarness, nodes } from './client-component-harness';

const m = vi.hoisted(() => ({ hooks: null as any }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => m.hooks.useState(...args),
  useRef: (...args: any[]) => m.hooks.useRef(...args),
  useEffect: (...args: any[]) => m.hooks.useEffect(...args),
}));
vi.mock('next/link', () => ({ default: 'a' }));
import { DashboardMobileNavigation } from '../../app/dashboard/DashboardMobileNavigation';
import { getDashboardMobileNavGroups } from '../../app/dashboard/dashboard-navigation';

// Actual handlers with controlled focus/animation-frame collaborators. Browser
// native Enter/Space activation, tab order, pointer layout and focus visibility
// require the separate admitted C06 browser matrix.
let h: ReturnType<typeof clientComponentHarness>;
let pathname: string;
let frames: Array<() => void>;
let doc: { activeElement: unknown; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
let items: Array<{ focus: ReturnType<typeof vi.fn> }>;
const groups = getDashboardMobileNavGroups(['locations:read', 'settings:read', 'time_cards:read']);
function focusable() { const item = { focus: vi.fn(() => { doc.activeElement = item; }) }; return item; }
let trigger: ReturnType<typeof focusable>;
const render = () => h.render();
const menu = () => nodes(render()).find(n => n.props.role === 'menu');
function attachRef(node: unknown, value: unknown) { (node as { ref: { current: unknown } }).ref.current = value; }
function attachMenu() { attachRef(menu(), { querySelectorAll: () => items }); }
function flushFrames() { for (const frame of frames.splice(0)) frame(); }
const key = (value: string, shiftKey = false) => ({ key: value, shiftKey, preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => items } });
beforeEach(() => {
  frames = []; pathname = '/dashboard/locations';
  doc = { activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('document', doc); vi.stubGlobal('window', { requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; } });
  items = Array.from({ length: groups.more.length + 1 }, focusable); trigger = focusable();
  h = clientComponentHarness(() => DashboardMobileNavigation({ pathname, ...groups })); m.hooks = h.hooks;
  render(); h.flushEffects(); attachRef(button(render(), 'More'), trigger);
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });

describe('mobile navigation focus and ARIA controls', () => {
  it('exposes the active destination and expands the controlled menu on activation', () => {
    expect(button(render(), 'More').props['aria-expanded']).toBe(false);
    expect(button(render(), 'More').props['aria-controls']).toBe('dashboard-mobile-more-menu');
    button(render(), 'More').props.onClick(); attachMenu(); flushFrames();
    expect(button(render(), 'More').props['aria-expanded']).toBe(true);
    expect(menu()?.props.id).toBe('dashboard-mobile-more-menu');
    expect(doc.activeElement).toBe(items[0]);
    const links = nodes(menu()).filter(n => n.props.role === 'menuitem');
    expect(links.map(n => n.props.href)).toEqual([...groups.more.map(n => n.href), '/auth/logout']);
    expect(links.find(n => n.props.href === '/dashboard/locations')?.props['aria-current']).toBe('page');
    expect(links.every(n => n.props.tabIndex === -1)).toBe(true);
  });
  it.each([['ArrowDown', 0], ['ArrowUp', -1]] as const)('opens from %s with focus on the corresponding edge', (name, index) => {
    const event = key(name); button(render(), 'More').props.onKeyDown(event); attachMenu(); flushFrames();
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(doc.activeElement).toBe(items.at(index));
  });
  it('moves through Arrow/Home/End and restores the trigger on Escape', () => {
    button(render(), 'More').props.onClick(); attachMenu(); flushFrames();
    for (const [name, expected] of [['End', -1], ['ArrowDown', 0], ['ArrowUp', -1], ['Home', 0]] as const) {
      menu()!.props.onKeyDown(key(name)); expect(doc.activeElement).toBe(items.at(expected));
    }
    menu()!.props.onKeyDown(key('Escape'));
    expect(menu()).toBeUndefined(); expect(doc.activeElement).toBe(trigger);
    expect(button(render(), 'More').props['aria-expanded']).toBe(false);
  });
  it.each([false, true])('defers Tab closure until browser focus movement (shift=%s)', shift => {
    button(render(), 'More').props.onClick(); attachMenu(); flushFrames();
    const event = key('Tab', shift); menu()!.props.onKeyDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(menu()).toBeDefined();
    flushFrames(); expect(menu()).toBeUndefined();
  });
  it('closes on external blur and route change without adding unavailable destinations', () => {
    button(render(), 'More').props.onClick(); attachMenu(); flushFrames();
    nodes(render()).find(n => n.props.className === 'workspace-mobile-more')!.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
    expect(menu()).toBeUndefined();
    button(render(), 'More').props.onClick(); attachMenu(); flushFrames();
    pathname = '/dashboard/settings'; render(); h.flushEffects(); expect(menu()).toBeUndefined();
    expect(groups.more.some(n => n.href.startsWith('/admin'))).toBe(false);
  });
});
