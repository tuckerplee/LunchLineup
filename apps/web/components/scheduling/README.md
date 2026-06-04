# Scheduling components

## Files

- `README.md`: this scheduling components guide.
- `SchedulingGrid.tsx`: reusable scheduling grid component.
- `ShiftCard.tsx`: shift display card.
- `StaffScheduler.tsx`: staff timeline view with shift and lunch/break overlays, inline shift action popovers, drag edits, and empty-slot selection callbacks.

## Notes

`StaffScheduler.tsx` is a presentational timeline. Tenant scoping and persistence live in the dashboard scheduling route and API controllers. Shift clicks open an inline action popover, the Edit action closes that popover before handing control to the caller, and empty staff-row slots call back with the selected resource and time window; callers decide whether that creates, edits, or assigns real shifts. `SchedulingGrid.tsx` does not provide dummy staff fallbacks; callers pass real tenant staff rows or real shifts, and the component renders an empty state when no staff are loaded.
