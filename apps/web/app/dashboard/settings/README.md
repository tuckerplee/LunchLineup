# Dashboard Settings

Tenant settings route for organization defaults, team policy, billing status, and security controls.

## Files

- `AccountLifecyclePanel.tsx`: account status with authoritative scheduled-cancellation/effective-date reload projection, requester-scoped export recovery, duplicate-safe renewal cancellation, and deletion flow that preserves finalized or pending DELETE receipts, stops authenticated polling, clears browser cookies locally, and opens the public confirmation page.
- `BillingSettingsPanel.tsx`: render-only billing panel for subscription state, feature access, fixed 100/500/2000 credit packs with pack-specific accessible purchase names, Stripe-authoritative pricing, capacity-checked plan changes, and recovery controls.
- `billing-settings-contract.ts`: pure billing/credit-pack normalization, active-paid gating, currency-aware price formatting, checkout-return parsing, recovery-action, and HTTPS Stripe redirect helpers.
- `MfaEnrollmentPanel.tsx`: personal MFA enrollment, verification, recovery-code display, and disable controls.
- `README.md`: this settings folder guide.
- `SettingsWorkspace.tsx`: client settings workspace composing fail-closed general, team, account lifecycle, billing, and security state with keyboard-operable ARIA tabs.
- `settings-tabs.ts`: pure tab identifiers and ArrowLeft/ArrowRight/Home/End navigation resolution for the settings tablist.
- `use-billing-settings.ts`: owns provider-independent feature loading, settings-only live subscription recovery lookup, pack loading, billing mutations, pending credit-checkout state, sanitized return handling, and bounded post-return balance refresh.
- `mfa-enrollment-contract.ts`: pure MFA enrollment/status/setup/recovery-code client contract normalizers.
- `page.tsx`: dashboard settings route entry that requires `settings:read` and passes settings, billing, tenant export, and account lifecycle capabilities.

Full tenant export requires `account:data_export`; `settings:write` continues to control ordinary settings and account status without exposing the full workspace data set. The account panel recovers the caller's unexpired recent jobs on reload, polls an active job without a client timeout, retries transient status failures, and hands the ready NDJSON attachment to the browser's native download path so the browser never assembles the export in memory.
