# Scheduling components

## Files

- `README.md`: this scheduling components guide.
- `SchedulingGrid.tsx`: reusable scheduling grid component.
- `ShiftCard.tsx`: shift display card.
- `StaffScheduler.tsx`: staff timeline view with shift and lunch/break overlays.

## Notes

`StaffScheduler.tsx` is a presentational timeline. Tenant scoping and persistence live in the dashboard scheduling route and API controllers. `SchedulingGrid.tsx` does not provide dummy staff fallbacks; callers pass real tenant staff rows or real shifts, and the component renders an empty state when no staff are loaded.
