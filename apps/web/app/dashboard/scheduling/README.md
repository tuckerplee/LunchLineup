# Scheduling calendar

## Files

- `README.md`: this scheduling route guide.
- `page.tsx`: tenant-scoped guided schedule builder and calendar workspace that loads real staff, locations, shifts, and lunch/break records.
- `print/`: old-style printable schedule route; see `print/README.md`.

## Notes

The calendar uses `/shifts/staff-roster`, `/locations`, `/shifts`, and `/lunch-breaks/generate` through session-authenticated API calls. The primary first-load anchor is the drag/drop schedule board, so managers see the working calendar before any form-heavy tools. The guided Build Schedule panel sits below the board inside the same workspace surface, not as a competing card stack. First load shows only location, coverage per day, time window, and the build action. Role, auto-assign vs open shifts, gap filling, break generation, planned hours, and sample assignments live behind Scheduling Rules so managers are not forced through a wall of inputs before building.

Manual shift creation is intentionally behind the Manual Shift control. The manual form and staff-by-day grid remain available for exceptions; each cell opens a prefilled shift form for that staff member and date. The current-shifts table and break-assignment list are collapsed by default behind explicit detail controls, while the schedule board stays visible for calendar-first editing. Shift creation requires a selected staff member, location, role, date, and start/end time so Add Shift cannot silently create repeated open shifts. Table assignee controls and board drag edits update the same server-side tenant-scoped shift records rather than local dummy staff.

`?focus=open` filters the shift table and schedule board to unassigned shifts, matching the dashboard "Assign open shifts" links. `?date=YYYY-MM-DD` seeds the initial calendar date when provided.
