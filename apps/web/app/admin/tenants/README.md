# Tenant Admin Route

Platform-admin tenant lifecycle management.

## Files

- `README.md`: this tenant admin route guide.
- `page.tsx`: server route that requires `admin_portal:access`.
- `TenantsClient.tsx`: client tenant directory, create/edit form, and lifecycle actions.
- `tenant-edit-contract.ts`: generic edit payload allowlist and read-only plan/status workflow guidance.
- `tenant-lifecycle-confirmation.ts`: typed confirmation helpers for destructive tenant lifecycle actions.
- `tenant-provisioning-contract.ts`: pure UI policy for FREE active versus paid bounded-trial starting states.

## Notes

Tenant create requires a valid owner name and email. The form shows the only truthful initial entitlement state: FREE workspaces start `ACTIVE` with free-tier access, while paid plans start `TRIAL` with a bounded end returned by the API. Paid `ACTIVE` provisioning remains unavailable until Stripe or a real manual entitlement mechanism supplies proof. The API provisions the owner as the tenant Admin in the same transaction as the workspace and default roles. Existing tenant plan and status are read-only in the generic edit form. Plan changes belong to the tenant billing workflow so Stripe subscription and entitlement state remain coordinated; suspend, activate, archive, restore, permanent delete, and archived-tenant bulk delete stay on explicit lifecycle actions. Destructive lifecycle actions require typed confirmation in the browser before the client calls the admin API. Activation and restore remain one-click because they return access rather than remove or interrupt it.
