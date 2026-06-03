# Scheduling calendar

## Files

- `README.md`: this scheduling route guide.
- `page.tsx`: tenant-scoped calendar workspace that loads real staff, locations, shifts, and lunch/break records.
- `print/`: old-style printable schedule route; see `print/README.md`.

## Notes

The calendar uses `/shifts/staff-roster`, `/locations`, `/shifts`, and `/lunch-breaks/generate` through session-authenticated API calls. The shift input panel is a staff-by-day schedule builder for the selected Day, 3-Day, or Week range; each cell opens a prefilled shift form for that staff member and date. Shift creation requires a selected staff member, location, role, date, and start/end time so Add Shift cannot silently create repeated open shifts. Table assignee controls and timeline drag edits update the same server-side tenant-scoped shift records rather than local dummy staff.

`?focus=open` filters the shift table and timeline to unassigned shifts, matching the dashboard "Assign open shifts" links. `?date=YYYY-MM-DD` seeds the initial calendar date when provided.
