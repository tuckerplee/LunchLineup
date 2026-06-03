# Admin credits

Tenant credit-balance administration route.

## File map

- `README.md` - This route folder guide.
- `page.tsx` - Server route wrapper and admin access gate.
- `CreditsClient.tsx` - Client workspace for tenant balances, credit grants, projected balance review, and ledger history.

## UX notes

Credit grants require an explicit amount and reason, show the projected tenant balance, and ask for confirmation before posting to `/admin/credits/grant`.
