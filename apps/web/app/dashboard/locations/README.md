# Locations route

Tenant location management for users with `locations:read`.

## Files

- `README.md`: this locations route guide.
- `LocationLifecycleActions.tsx`: permission-gated location editing with persisted-draft resets plus focus-trapped, Escape-closeable exact-name deactivation confirmation and trigger-focus restoration.
- `LocationTimeZoneInput.tsx`: reusable searchable IANA timezone input backed by browser-supported suggestions.
- `LocationsWorkspace.tsx`: deterministic bounded location loading with explicit Load more continuation, lost-response-safe mobile-safe creation, browser-timezone defaults, empty/error states, and active location cards.
- `location-form.ts`: shared create/update payload normalization, persisted edit-draft restoration, IANA validation, browser-timezone resolution, and timezone option generation.
- `page.tsx`: server permission gate for read, write, and delete capabilities.

Location creation retains its `Idempotency-Key` after an ambiguous failure and rotates it only when the payload changes or creation succeeds. Create and edit payloads always include a valid IANA timezone. The create form defaults to the browser-resolved timezone only when `Intl` recognizes it, stays within a 375px viewport while open, and offers supported zones while permitting a valid legacy IANA identifier. Canceling or reopening an edit restores every field from the persisted location. Deactivation requires `locations:delete`, traps keyboard focus, closes on Escape, restores the trigger on dismissal, removes the location from active scheduling, and preserves published history through the API lifecycle contract.

The workspace never drains location pages automatically. Refresh replaces the visible first page; Load more appends and de-duplicates the next opaque-cursor page, preserving first-location creation and recovery behavior.
