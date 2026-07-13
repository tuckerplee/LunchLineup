# Scheduling calendar

## Files

- `README.md`: this scheduling route guide.
- `auto-schedule-recovery.ts`: tab-session persistence for auto-schedule attempt, job, and polling identity across reloads.
- `DemandWindowEditor.tsx`: compact draft-schedule demand editor for exact date/time, required staffing, and optional skill windows.
- `break-generation-recovery.ts`: payload-bound lunch-generation idempotency and post-commit read-reconciliation state machine.
- `demand-window-contract.ts`: pure demand editor hydration, validation, and location-timezone serialization helpers.
- `layout.tsx`: server-side route guard requiring the complete scheduling read capability contract.
- `location-shift-scope.ts`: pure tenant-visible location resolution, active-location query, loaded-scope matching, response filtering, and break-generation context helpers.
- `local-time-window.ts`: shared location-timezone shift and demand-window serializer that advances earlier end times to the next local calendar day and rejects ambiguous fallback wall times.
- `manual-shift-schedule.ts`: pure containing-draft selection and complete local-day fallback-window helpers for manual shift creation.
- `page.tsx`: tenant-scoped calendar workspace that loads real staff, locations, shifts, and lunch/break records.
- `publish-result.ts`: pure publish-notification outcome mapping used by the workspace status banner.
- `print/`: old-style printable schedule route; see `print/README.md`.

## Notes

The calendar uses `/shifts/staff-roster`, `/locations`, `/shifts`, `/schedules/:id/demand-windows`, and `/lunch-breaks/generate` through session-authenticated API calls. Every range shift load includes the active `locationId`, responses are filtered to that location before entering UI state, and superseded location loads are discarded. Location-scoped writes remain disabled until the selected location, date, and view have current data. Break generation sends both the selected `locationId` and only that location's shift IDs, validates any response scope, and discards a post-generation refresh if the operator has switched locations. Persisted timestamps remain UTC ISO instants. First use creates a draft schedule, then requires at least one saved demand window before auto-scheduling. Auto-scheduling a nonblank draft requires a second confirmation before replacement. Auto-schedule polling remains active after a location, date, or view change so the server job can finish, but a solve-generation and captured-scope guard prevents that stale poll from changing the current status or reloading its old calendar scope. Each auto-schedule and calendar break-generation attempt keeps one payload-bound `Idempotency-Key` through response loss and authentication refresh so a retry reuses the original job, break outcome, and credit charge. An ambiguous break-generation POST replays that same key; after the POST is confirmed, a failed response reconciliation or calendar refresh retains the confirmed response and retries only the scoped read reconciliation without another charged POST. Auto-schedule attempt and job identity are retained in `sessionStorage`; reload resends only an unresolved original request with the same key or resumes the known job status URL, then clears recovery state on terminal completion.

Calendar route access and navigation require `schedules:read`, `shifts:read`, and `locations:read`, matching its unconditional schedule, roster, location, and shift reads. `admin_portal:access` does not bypass missing tenant read permissions. Any failed required read leaves the calendar in an explicit error state; schedule failures are never converted into an empty schedule. Shift editing requires `shifts:write`; `schedules:write` alone only exposes schedule-level actions.

Schedule editing is board-triggered. Published rows expose a two-step Reopen action for authorized publishers; reopening returns the schedule to draft, hides it from staff, and re-enables corrections until republish. Publish results explicitly warn when staff notification delivery is partial or failed even though the schedule commit succeeded. Clicking an empty time slot opens the shift form prefilled for that person and time. Existing shifts expose edit and two-step delete actions. Shift creation requires staff, location, role, date, and times, and board drag edits persist through tenant-scoped shift endpoints. Shift and demand-window end times earlier than their start time serialize on the next local calendar day; equal times remain invalid. Ambiguous wall times during daylight-saving fallback are rejected with validation instead of silently selecting a fold. Persisted overnight records hydrate back to the start date with their next-day end wall-clock time.

`?focus=open` filters the shift table and schedule board to unassigned shifts, matching the dashboard "Assign open shifts" links. `?date=YYYY-MM-DD` seeds the initial calendar date when provided. `?location=<id>` selects that location only when it appears in the tenant-scoped location response; missing or inaccessible IDs fall back to the first visible location before shift loads begin.

Manual shift creation passes the tenant-visible, location-matched `DRAFT` schedule whose window contains the complete shift interval. When no containing draft is loaded, the API fallback may create one spanning every touched local calendar day; overnight fallback state mirrors that complete window instead of synthesizing a one-day schedule.
