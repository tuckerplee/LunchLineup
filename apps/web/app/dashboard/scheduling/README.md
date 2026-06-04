# Scheduling calendar

## Files

- `README.md`: this scheduling route guide.
- `page.tsx`: tenant-scoped guided schedule builder and calendar workspace that loads real staff, locations, shifts, and lunch/break records.
- `print/`: old-style printable schedule route; see `print/README.md`.

## Notes

The calendar uses `/shifts/staff-roster`, `/locations`, `/shifts`, and `/lunch-breaks/generate` through session-authenticated API calls. The primary flow is a quiet guided Build Schedule panel inside one workspace surface, not a stack of mismatched cards. First load shows only location, coverage per day, time window, and the build action. Role, auto-assign vs open shifts, gap filling, break generation, planned hours, and sample assignments live behind Options so managers are not forced through a wall of inputs before building.

Manual shift creation is intentionally behind the Manual Shift control. The manual form and staff-by-day grid remain available for exceptions; each cell opens a prefilled shift form for that staff member and date. The current-shifts table, break-assignment list, and drag timeline are also collapsed by default behind explicit detail controls. Shift creation requires a selected staff member, location, role, date, and start/end time so Add Shift cannot silently create repeated open shifts. Table assignee controls and timeline drag edits update the same server-side tenant-scoped shift records rather than local dummy staff.

`?focus=open` filters the shift table and timeline to unassigned shifts, matching the dashboard "Assign open shifts" links. `?date=YYYY-MM-DD` seeds the initial calendar date when provided.
