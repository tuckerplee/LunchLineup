# Scheduling calendar

## Files

- `README.md`: this scheduling route guide.
- `page.tsx`: tenant-scoped calendar workspace that loads real staff, locations, shifts, and lunch/break records.
- `print/`: old-style printable schedule route; see `print/README.md`.

## Notes

The calendar uses `/shifts/staff-roster`, `/locations`, `/shifts`, and `/lunch-breaks/generate` through session-authenticated API calls. The primary first-load anchor is the drag/drop schedule board, so managers see the working calendar without default Build Schedule or Breaks cards competing for attention. Break generation remains temporarily available behind the advanced gear until that workflow is rebuilt.

Schedule editing is board-triggered. Clicking an empty time slot in a staff member row opens the shift form prefilled for that person and time. Clicking an existing shift opens an inline board popover with shift actions; Edit Shift opens the form in update mode instead of creating a duplicate. Shift creation requires a selected staff member, location, role, date, and start/end time so Add Shift cannot silently create repeated open shifts. Board drag edits update the same server-side tenant-scoped shift records rather than local dummy staff.

`?focus=open` filters the shift table and schedule board to unassigned shifts, matching the dashboard "Assign open shifts" links. `?date=YYYY-MM-DD` seeds the initial calendar date when provided.
