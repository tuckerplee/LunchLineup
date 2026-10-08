import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientComponentHarness } from './client-component-harness';

const m = vi.hoisted(() => ({ hooks: null as any }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useRef: (...args: any[]) => m.hooks.useRef(...args),
  useEffect: (...args: any[]) => m.hooks.useEffect(...args),
  useCallback: (...args: any[]) => m.hooks.useCallback(...args),
}));
import { useDialogFocus } from '../../components/ui/use-dialog-focus';

// Controlled HTMLElement collaborators exercise the actual hook's behavior.
// This does not establish real DOM, portal, screen-reader or browser focus proof.
class Element {
  isConnected = true;
  tabIndex = 0;
  disabled = false;
  hidden = false;
  visibility = 'visible';
  rendered = true;
  children: Element[] = [];
  modal: Element | null = null;
  focus = vi.fn(() => { doc.activeElement = this; });
  matches() { return this.disabled; }
  closest(selector: string) { return selector.includes('[hidden]') ? (this.hidden ? this : null) : this.modal; }
  getClientRects() { return this.rendered ? [{}] : []; }
  querySelectorAll() { return this.children; }
  contains(value: unknown) { return value === this || this.children.includes(value as Element); }
}
let doc: { activeElement: unknown; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
let listeners: Map<string, (event: any) => void>;
let microtasks: Array<() => void>;
let h: ReturnType<typeof clientComponentHarness>;
let open: boolean;
let control: ReturnType<typeof useDialogFocus>;
let dialog: Element;
let trigger: Element;
let fallback: Element;
function renderEffects() { h.render(); h.flushEffects(); }
function show(children = [new Element(), new Element()]) {
  control.captureTrigger(trigger as unknown as HTMLElement, fallback as unknown as HTMLElement);
  open = true; h.render(); dialog.children = children; control.dialogRef.current = dialog as unknown as HTMLDivElement; h.flushEffects();
  return children;
}
function close() { open = false; renderEffects(); }
function flushMicrotasks() { for (const task of microtasks.splice(0)) task(); }
const tab = (shiftKey = false) => ({ key: 'Tab', shiftKey, preventDefault: vi.fn() });
beforeEach(() => {
  listeners = new Map(); microtasks = []; open = false;
  doc = { activeElement: null,
    addEventListener: vi.fn((name, callback) => listeners.set(name, callback)),
    removeEventListener: vi.fn((name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); }),
  };
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('getComputedStyle', (element: Element) => ({ visibility: element.visibility }));
  vi.stubGlobal('queueMicrotask', (callback: () => void) => microtasks.push(callback));
  dialog = new Element(); dialog.tabIndex = -1; trigger = new Element(); fallback = new Element();
  h = clientComponentHarness(() => { control = useDialogFocus(open); return null; }); m.hooks = h.hooks;
  renderEffects();
});
afterEach(() => { h?.unmount(); flushMicrotasks(); vi.unstubAllGlobals(); });

describe('dialog focus ownership', () => {
  it('does not steal focus on initial closed mount', () => {
    expect(doc.activeElement).toBeNull(); expect(listeners.size).toBe(0);
    expect(trigger.focus).not.toHaveBeenCalled(); expect(fallback.focus).not.toHaveBeenCalled();
  });
  it('focuses the first available control and traps both Tab edges', () => {
    const first = new Element(); const last = new Element();
    const disabled = new Element(); disabled.disabled = true;
    const hidden = new Element(); hidden.hidden = true;
    const invisible = new Element(); invisible.visibility = 'hidden';
    const removed = new Element(); removed.isConnected = false;
    const negative = new Element(); negative.tabIndex = -1;
    show([disabled, hidden, invisible, removed, negative, first, last]);
    expect(doc.activeElement).toBe(first);
    const reverse = tab(true); listeners.get('keydown')!(reverse);
    expect(reverse.preventDefault).toHaveBeenCalledOnce(); expect(doc.activeElement).toBe(last);
    const forward = tab(); listeners.get('keydown')!(forward);
    expect(forward.preventDefault).toHaveBeenCalledOnce(); expect(doc.activeElement).toBe(first);
    const interior = tab(); listeners.get('keydown')!(interior); expect(interior.preventDefault).not.toHaveBeenCalled();
  });
  it('contains external focus and handles a dialog with no usable controls', () => {
    show([]); expect(doc.activeElement).toBe(dialog);
    const outside = new Element(); doc.activeElement = outside;
    listeners.get('focusin')!({ target: outside }); expect(doc.activeElement).toBe(dialog);
    const event = tab(); listeners.get('keydown')!(event);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(doc.activeElement).toBe(dialog);
  });
  it('restores the exact trigger on cancel and removes its listeners', () => {
    show(); close(); expect(doc.activeElement).toBe(trigger); expect(listeners.size).toBe(0);
    expect(doc.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    flushMicrotasks(); expect(trigger.focus).toHaveBeenCalledOnce();
  });
  it.each(['disabled', 'removed', 'hidden'] as const)('uses the supplied fallback when the trigger is %s', condition => {
    show();
    if (condition === 'disabled') trigger.disabled = true;
    if (condition === 'removed') trigger.isConnected = false;
    if (condition === 'hidden') trigger.hidden = true;
    close(); expect(doc.activeElement).toBe(fallback); expect(trigger.focus).not.toHaveBeenCalled();
  });
  it('preserves deliberate focus in a replacement modal after success', () => {
    show(); const replacement = new Element(); const nextControl = new Element();
    replacement.children = [nextControl]; nextControl.modal = replacement; doc.activeElement = nextControl;
    close(); expect(doc.activeElement).toBe(nextControl);
    expect(trigger.focus).not.toHaveBeenCalled(); expect(fallback.focus).not.toHaveBeenCalled();
  });
  it('does not restore during connected effect cleanup, but restores after actual removal', () => {
    const [first] = show(); h.unmount(); flushMicrotasks();
    expect(doc.activeElement).toBe(first); expect(trigger.focus).not.toHaveBeenCalled();
    // A later actual removal, not the connected StrictMode-like cleanup, owns restoration.
    dialog.isConnected = false; h.unmount(); flushMicrotasks();
    expect(doc.activeElement).toBe(trigger); expect(trigger.focus).toHaveBeenCalledOnce();
  });
});
