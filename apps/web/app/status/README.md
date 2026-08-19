# Status Route

Public beta status and incident-history page for LunchLineup customers. The route server-renders a no-store API health probe using the required production runtime value `LUNCHLINEUP_STATUS_HEALTH_URL`; non-production development may fall back to `INTERNAL_API_V2_URL` plus `/ready`. A missing production value produces a neutral not-configured signal without a network request. Automated degraded or unavailable signals remain separate from the reviewed incident log and never invent a durable incident on render. Public support contact copy uses `apps/web/app/legal-config.ts`.

## Files

- `health.ts`: server-side API health probe, payload normalization, derived component states, and display helpers.
- `README.md`: this status route guide.
- `page.tsx`: dynamic public status page with automated web/API health signals, component availability, incident history, and support links.
