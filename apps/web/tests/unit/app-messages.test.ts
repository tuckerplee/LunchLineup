import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogView, MessageList, PromptDialogView } from '@/components/messages/AppMessages';
import { createClientEventReporter, MAX_BATCH } from '@/lib/messages/reporter';
import { MessageStore, safeCode, trackableRoute } from '@/lib/messages/store';
import type { ClientEvent } from '@/lib/messages/types';

function harness(route = '/dashboard/lunch-breaks') {
  const events: ClientEvent[] = [];
  const store = new MessageStore({ getRoute: () => route, report: (event) => events.push(event) });
  return { store, events, api: store.api() };
}

describe('MessageStore', () => {
  it('records level, code, route and detail but never the message text', () => {
    const { api, events, store } = harness();
    api.error('lunch_breaks.generate.failed', 'Could not generate for Jane Doe', { detail: 'payment_required' });
    api.success('lunch_breaks.setup.saved', 'Saved 4 shifts');
    expect(events).toEqual([
      { code: 'lunch_breaks.generate.failed', level: 'error', kind: 'message', route: '/dashboard/lunch-breaks', detail: 'payment_required' },
      { code: 'lunch_breaks.setup.saved', level: 'success', kind: 'message', route: '/dashboard/lunch-breaks' },
    ]);
    expect(JSON.stringify(events)).not.toContain('Jane');
    expect(store.getSnapshot().messages).toHaveLength(2);
  });

  it('rejects free text as code or detail instead of tracking it', () => {
    const { api, events } = harness();
    api.info('Jane Doe was removed', 'x', { detail: 'Jane Doe was removed' });
    expect(events[0]).toEqual({ code: 'ui.invalid_code', level: 'info', kind: 'message', route: '/dashboard/lunch-breaks' });
    expect(safeCode('a.b')).toBe('a.b');
  });

  it('auto-dismisses success only and replaces an identical message instead of stacking', () => {
    const { api, store } = harness();
    api.success('a.ok', 'Done');
    api.error('a.bad', 'Failed');
    api.success('a.ok', 'Done');
    const { messages } = store.getSnapshot();
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.level === 'success')?.autoDismissMs).toBeGreaterThan(0);
    expect(messages.find((message) => message.level === 'error')?.autoDismissMs).toBe(0);
    api.error('a.bad', 'Failed', { autoDismissMs: 100 });
    expect(store.getSnapshot().messages.find((message) => message.level === 'error')?.autoDismissMs).toBe(0);
  });

  it('dismisses by id or code and clears transient messages on navigation', () => {
    const { api, store } = harness();
    const first = api.warning('a.warn', 'Careful');
    api.info('a.info', 'FYI', { persistAcrossRoutes: true });
    api.error('b.err', 'Broken');
    api.dismiss(first);
    api.dismissCode('b.err');
    expect(store.getSnapshot().messages.map((message) => message.code)).toEqual(['a.info']);
    api.error('c.err', 'Again');
    store.clearForNavigation();
    expect(store.getSnapshot().messages.map((message) => message.code)).toEqual(['a.info']);
  });

  it('resolves confirmations as promises and tracks the outcome', async () => {
    const { api, store, events } = harness('/dashboard/staff/668196db-7db2-4eb7-9808-5cd1a21717b7');
    const first = api.confirmAction({ code: 'staff.remove.confirm', title: 'Remove?', body: 'Gone.', tone: 'danger' });
    const second = api.confirmAction({ code: 'staff.reset.confirm', title: 'Reset?', body: 'Reset.' });
    const active = store.getSnapshot().dialog;
    expect(active?.kind).toBe('confirm');
    store.resolveConfirm(active!.id, true);
    await expect(first).resolves.toBe(true);
    const next = store.getSnapshot().dialog;
    expect(next?.request.code).toBe('staff.reset.confirm');
    store.resolveConfirm(next!.id, false);
    await expect(second).resolves.toBe(false);
    expect(store.getSnapshot().dialog).toBeNull();
    expect(events).toEqual([
      { code: 'staff.remove.confirm', level: 'warning', kind: 'confirm', route: '/dashboard/staff/:id', outcome: 'confirmed' },
      { code: 'staff.reset.confirm', level: 'info', kind: 'confirm', route: '/dashboard/staff/:id', outcome: 'cancelled' },
    ]);
  });

  it('resolves prompts with the value or null when cancelled', async () => {
    const { api, store, events } = harness();
    const entered = api.promptAction({ code: 'x.prompt', title: 'Reason', label: 'Reason' });
    store.resolvePrompt(store.getSnapshot().dialog!.id, 'because');
    await expect(entered).resolves.toBe('because');
    const cancelled = api.promptAction({ code: 'x.prompt', title: 'Reason', label: 'Reason' });
    store.resolvePrompt(store.getSnapshot().dialog!.id, null);
    await expect(cancelled).resolves.toBeNull();
    expect(events.map((event) => event.outcome)).toEqual(['confirmed', 'cancelled']);
    expect(JSON.stringify(events)).not.toContain('because');
  });

  it('never lets a failing reporter break the workflow', () => {
    const store = new MessageStore({ getRoute: () => '/dashboard', report: () => { throw new Error('boom'); } });
    expect(() => store.api().error('a.b', 'x')).not.toThrow();
  });

  it('normalizes tracked routes', () => {
    expect(trackableRoute('/admin/tenants/12345?x=1')).toBe('/admin/tenants/:id');
    expect(trackableRoute('/Dashboard/Staff')).toBe('/dashboard/staff');
  });
});

describe('client event reporter', () => {
  it('sends events in batches of at most 20 and flushes a timer batch', () => {
    const sent: ClientEvent[][] = [];
    let scheduled: (() => void) | null = null;
    const reporter = createClientEventReporter({
      send: (events) => { sent.push(events); },
      setTimer: (callback) => { scheduled = callback; return 1; },
      clearTimer: () => { scheduled = null; },
    });
    const event: ClientEvent = { code: 'a.b', level: 'info', kind: 'message', route: '/dashboard' };
    for (let index = 0; index < 45; index += 1) reporter.report(event);
    expect(sent.map((batch) => batch.length)).toEqual([MAX_BATCH, MAX_BATCH]);
    expect(scheduled).not.toBeNull();
    scheduled!();
    expect(sent.map((batch) => batch.length)).toEqual([20, 20, 5]);
  });

  it('swallows send failures', async () => {
    const reporter = createClientEventReporter({
      send: () => Promise.reject(new Error('offline')),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    reporter.report({ code: 'a.b', level: 'error', kind: 'message', route: '/dashboard' });
    expect(() => reporter.flush()).not.toThrow();
    await Promise.resolve();
  });
});

describe('message and dialog markup', () => {
  it('renders errors in an assertive region and everything else in a polite region with dismiss controls', () => {
    const { api, store } = harness();
    api.error('a.bad', 'Out of credits', { action: { label: 'Open Billing', href: '/dashboard/settings?tab=billing' } });
    api.success('a.ok', 'Saved');
    const html = renderToStaticMarkup(createElement(MessageList, { messages: store.getSnapshot().messages, onDismiss: vi.fn() }));
    expect(html).toMatch(/role="alert"[^>]*aria-live="assertive"[\s\S]*Out of credits/);
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"[\s\S]*Saved/);
    expect(html).toContain('href="/dashboard/settings?tab=billing"');
    expect(html).toContain('aria-label="Dismiss message"');
    expect(renderToStaticMarkup(createElement(MessageList, { messages: [], onDismiss: vi.fn() }))).toContain('aria-live="assertive"');
  });

  it('renders the confirm dialog as a labelled modal alertdialog with a safe default', () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialogView, {
      request: { code: 'a.confirm', title: 'Remove member?', body: 'This cannot be undone.', confirmLabel: 'Remove', tone: 'danger' },
      onResolve: vi.fn(),
    }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain('Remove member?');
    expect(html).toContain('Remove</button>');
    expect(html).toContain('Cancel');
  });

  it('renders the prompt dialog with a labelled input', () => {
    const html = renderToStaticMarkup(createElement(PromptDialogView, {
      request: { code: 'a.prompt', title: 'Reason', label: 'Reason for change', defaultValue: 'seed' },
      onResolve: vi.fn(),
    }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('Reason for change');
    expect(html).toContain('value="seed"');
    expect(html).toContain('type="submit"');
  });
});
