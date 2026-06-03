# Scheduling calendar

## Files

- `README.md`: this scheduling route guide.
- `page.tsx`: tenant-scoped calendar workspace that loads real staff, locations, shifts, and lunch/break records.

## Notes

The calendar uses `/shifts/staff-roster`, `/locations`, `/shifts`, and `/lunch-breaks/generate` through session-authenticated API calls. Add-shift, drag-time edits, refresh, and break generation operate on server-side tenant-scoped records rather than local dummy staff.
