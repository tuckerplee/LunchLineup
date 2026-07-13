# Scheduling components

## Files

- `README.md`: this scheduling components guide.
- `SchedulingGrid.tsx`: reusable scheduling grid component.
- `scheduler-projection.ts`: pure compact-day interval projection and timeline offset conversion.
- `ShiftCard.tsx`: shift display card.
- `StaffScheduler.tsx`: location-timezone-aware staff timeline with shift/break overlays, inline actions, drag edits, and empty-slot callbacks.

## Notes

`StaffScheduler.tsx` is a presentational timeline. Tenant scoping and persistence live in the dashboard scheduling route and API controllers. Shift clicks open an inline action popover, the Edit action closes that popover before handing control to the caller, Delete appears only when the caller provides an `onEventDelete` handler and requires a second inline Confirm delete click, and empty staff-row slots call back with the selected resource and time window; callers decide whether that creates, edits, deletes, or assigns real shifts. The board status text describes the actual drag target: horizontal movement changes time, vertical movement reassigns staff, and releasing calls the persistence callback. The timeline body owns vertical scrolling and mirrors that scroll into the staff-name rail so larger rosters do not clip the final row. `SchedulingGrid.tsx` does not provide dummy staff fallbacks; callers pass real tenant staff rows or real shifts, and the component renders an empty state when no staff are loaded.

The compact multi-day board projects every selected day into its own visible window, clips overnight shifts into per-day segments, and uses the same offset conversion for events, empty-slot creation, and drag edits.
