# Dashboard Settings

Tenant settings route for organization defaults, team policy, billing status, and security controls.

## Files

- `AccountLifecyclePanel.tsx`: account status, requester-scoped export recovery across long runs and reloads, period-end renewal cancellation, and deletion-request controls for tenant admins.
- `BillingSettingsPanel.tsx`: render-only billing tab panel for plan state, feature access, Checkout, capacity-checked plan changes, Stripe-confirmed paused-subscription resume, and portal delinquency recovery controls.
- `billing-settings-contract.ts`: pure billing feature-response normalization, management-mode, explicit recovery-action, and HTTPS Stripe redirect contract helpers.
- `MfaEnrollmentPanel.tsx`: personal MFA enrollment, verification, recovery-code display, and disable controls.
- `README.md`: this settings folder guide.
- `SettingsWorkspace.tsx`: client settings workspace with fail-closed settings hydration and retry, general, team, account lifecycle, permission-aware Checkout, safe billing portal, plan-change, hosted resumption-payment redirect, and security actions.
- `mfa-enrollment-contract.ts`: pure MFA enrollment/status/setup/recovery-code client contract normalizers.
- `page.tsx`: dashboard settings route entry that requires `settings:read` and passes settings, billing, tenant export, and account lifecycle capabilities.

Full tenant export requires `account:data_export`; `settings:write` continues to control ordinary settings and account status without exposing the full workspace data set. The account panel recovers the caller's unexpired recent jobs on reload, polls an active job without a client timeout, retries transient status failures, and hands the ready NDJSON attachment to the browser's native download path so the browser never assembles the export in memory.
