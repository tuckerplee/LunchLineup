# Lunch and breaks route

## Files

- `README.md`: this route guide.
- `page.tsx`: lunch and break planner for tenant-scoped schedule rows.

## Notes

`page.tsx` loads shared schedule rows from the authenticated API and uses them as the source of truth for lunch and break planning. Manual planning starts empty and requires explicit user-entered rows; it does not seed local dummy staff.
