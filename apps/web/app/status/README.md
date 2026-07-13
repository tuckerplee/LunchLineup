# Status Route

Public beta status and incident-history page for LunchLineup customers. The route server-renders a no-store API health probe using `LUNCHLINEUP_STATUS_HEALTH_URL` when set, otherwise `INTERNAL_API_URL` with a trailing URI-version suffix removed plus `/health`, and falls back to explicit reachability/unknown states when dependency details are unavailable. Degraded or unavailable health creates an active incident from the automated probe result; passing or partially reachable health preserves the reviewed no-active-incidents history entry. Public support contact copy uses `apps/web/app/legal-config.ts`.

## Files

- `health.ts`: server-side API health probe, payload normalization, derived component states, and display helpers.
- `README.md`: this status route guide.
- `page.tsx`: dynamic public status page with automated web/API health signals, component availability, incident history, and support links.
