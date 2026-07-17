# Tenant Admin Route

Platform-admin tenant lifecycle management.

## Files

- `README.md`: this tenant admin route guide.
- `page.tsx`: server route that requires `admin_portal:access`.
- `TenantsClient.tsx`: client tenant directory with server search and explicit bounded continuation, credit-free create/edit forms, read-only wallet output, Admin Credits routing, and lifecycle actions.
- `tenant-edit-contract.ts`: tenant create/edit payload allowlists and read-only plan, status, and wallet workflow guidance.
- `tenant-lifecycle-confirmation.ts`: typed confirmation helpers for destructive tenant lifecycle actions.
- `tenant-provisioning-contract.ts`: pure UI policy for FREE active versus paid bounded-trial starting states.

## Notes

Tenant create requires a valid owner name and email. The form shows the only truthful initial entitlement state: FREE workspaces start `ACTIVE` with free-tier access, while paid plans start `TRIAL` with a bounded end returned by the API. Paid `ACTIVE` provisioning remains unavailable until Stripe or a real manual entitlement mechanism supplies proof. The API provisions the owner as the tenant Admin in the same transaction as the workspace and default roles. Existing tenant plan and status are read-only in the generic edit form. Plan changes belong to the tenant billing workflow so Stripe subscription and entitlement state remain coordinated; suspend, activate, archive, restore, permanent delete, and archived-tenant bulk delete stay on explicit lifecycle actions. Destructive lifecycle actions require typed confirmation in the browser before the client calls the admin API. Activation and restore remain one-click because they return access rather than remove or interrupt it.

Generic tenant create and edit requests never send wallet-balance or plan-credit quota fields. Tenant creation leaves the wallet at the API default, and the selected tenant's current wallet balance is read-only. Operators must use Admin Credits for audited grants and corrections.

Paid access requires an active paid subscription and separately purchased or granted credits. Plans never include recurring credits or unlimited credits. These client allowlists do not replace API-side rejection of direct balance or quota fields.

The tenant directory requests at most 50 rows at a time, searches tenant names/slugs on the server, and follows the stable cursor only after an operator selects Load more. Counts and wallet summaries are explicitly labeled as loaded-row values rather than global totals.
