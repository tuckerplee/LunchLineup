# Scheduling calendar

## Files

- `README.md`: this scheduling route guide.
- `page.tsx`: tenant-scoped guided schedule builder and calendar workspace that loads real staff, locations, shifts, and lunch/break records.
- `print/`: old-style printable schedule route; see `print/README.md`.

## Notes

The calendar uses `/shifts/staff-roster`, `/locations`, `/shifts`, and `/lunch-breaks/generate` through session-authenticated API calls. The primary flow is a guided Build Schedule panel: managers choose location, role, coverage per day, time window, whether to auto-assign staff or create open shifts, and whether to generate breaks after creation. The panel previews the number of new shifts, planned hours, build mode, and sample assignments before writing tenant-scoped shift records.

Manual shift creation is intentionally behind the Manual Shift control. The manual form and staff-by-day grid remain available for exceptions; each cell opens a prefilled shift form for that staff member and date. Shift creation requires a selected staff member, location, role, date, and start/end time so Add Shift cannot silently create repeated open shifts. Table assignee controls and timeline drag edits update the same server-side tenant-scoped shift records rather than local dummy staff.

`?focus=open` filters the shift table and timeline to unassigned shifts, matching the dashboard "Assign open shifts" links. `?date=YYYY-MM-DD` seeds the initial calendar date when provided.
