# Scheduling calendar

## Files

- `README.md`: this scheduling route guide.
- `page.tsx`: tenant-scoped calendar workspace that loads real staff, locations, shifts, and lunch/break records.
- `print/`: old-style printable schedule route; see `print/README.md`.

## Notes

The calendar uses `/shifts/staff-roster`, `/locations`, `/shifts`, and `/lunch-breaks/generate` through session-authenticated API calls. Shift creation requires a selected staff member, location, role, and start/end time from the route form so Add Shift cannot silently create repeated open shifts. Table assignee controls and timeline drag edits update the same server-side tenant-scoped shift records rather than local dummy staff.

`?focus=open` filters the shift table and timeline to unassigned shifts, matching the dashboard "Assign open shifts" links. `?date=YYYY-MM-DD` seeds the initial calendar date when provided.
