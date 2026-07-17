# Admin credits

Tenant credit-balance administration route.

## File map

- `README.md` - This route folder guide.
- `page.tsx` - Server route wrapper and admin access gate.
- `CreditsClient.tsx` - Client workspace with server-side tenant search, independent manual balance/history continuations, credit grants, projected balance review, and ledger history.
- `credit-grant-submission.ts` - Payload-bound credit-grant attempt lifecycle and concurrent-submit guard.

## UX notes

Credit grants require an explicit amount and reason, show the projected tenant balance, and ask for confirmation before posting to `/admin/credits/grant`. Each normalized tenant, amount, and reason payload retains one opaque `Idempotency-Key` across authentication refresh, ambiguous network failure, and deliberate retry. A changed payload or confirmed successful response rotates the key, and concurrent duplicate submissions are rejected before transport.

Tenant balances and credit history use independent stable cursors with 50-row pages. Search is server-side for tenant name/slug, and operators explicitly load each additional balance or ledger page; the client never auto-chases continuations or labels partial sums as global totals.
