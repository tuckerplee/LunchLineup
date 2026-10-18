# App messages

THE way to show a user message, confirmation or prompt in the web app. Do not add
ad-hoc status banners, and never call `window.alert`, `window.confirm` or
`window.prompt` (`tests/unit/no-native-dialogs.test.ts` fails the build if you do).

## Files

- `README.md`: this guide.
- `types.ts`: message, option, dialog and tracking-event types.
- `store.ts`: framework-free `MessageStore` (messages, dialog queue, route normalization, tracking hook).
- `reporter.ts`: batching reporter that sends tracking events to `POST /api/v2/client-events`.
- `billing.ts`: `BILLING_ACTION` link and `isBillingBlock()` for real out-of-credits / payment-required blocks.

The provider, hook and views live in `components/messages/AppMessages.tsx`. The
dashboard and admin layouts mount `AppMessagesProvider`, which renders one
consistent region at the top of the page content: errors in an assertive live
region, everything else polite, each dismissible. Only success messages auto-dismiss.

## Use

```tsx
const messages = useAppMessages();

messages.success('lunch_breaks.setup.saved', 'Shifts saved.');
messages.error('lunch_breaks.generate.failed', err.message, { detail: 'request_failed' });

const ok = await messages.confirmAction({
  code: 'staff.remove.confirm', title: 'Remove member?', body: '...',
  confirmLabel: 'Remove', tone: 'danger',
});
const reason = await messages.promptAction({
  code: 'admin.users.reset_mfa.reason', title: 'Support reason', label: 'Reason',
  validate: (value) => (value.trim().length >= 10 ? null : 'Enter at least 10 characters.'),
}); // string, or null when cancelled
```

To migrate an existing `error` / `notice` state string without touching its logic,
call `useStatusMessage('error', 'area.thing.failed', error)`; it shows the text when
set and dismisses it when cleared.

Rules:

- `code` is a stable, lowercase, dot-separated literal (`area.action.outcome`). It is
  required, is what gets tracked, and must never be built from user data.
- Confirmations are dialogs only for consequential or destructive actions. Do not
  confirm routine saves, and do not show per-action cost or credit warnings. A real
  block reported by the API (402, out of credits) is an `error` with
  `{ action: BILLING_ACTION, detail: 'payment_required' }`.
- `detail` is an optional short non-PII key (`[a-z0-9_.-]`, 48 chars). Message text is
  shown to the user but is never tracked.

## Tracking

Every message and every confirm/prompt outcome is reported as
`{ code, level, kind, route, outcome?, detail? }` (route has identifiers replaced by
`:id`). Events are batched (max 20, flushed after 2 s or on page hide) with a
same-origin keepalive `fetch` carrying the CSRF header. api-v2 validates, rate
limits per session, adds `tenantId` and `userId` from the session, and writes one
`event: "ui_message"` pino line per event to stdout, which the estate ships to Loki.
There is no database table and no third-party SDK.
