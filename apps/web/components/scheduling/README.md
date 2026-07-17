# Scheduling components

## Files

- `README.md`: this scheduling components guide.
- `SchedulingGrid.tsx`: reusable scheduling grid component.
- `scheduler-projection.ts`: pure compact-day interval projection, timeline offset conversion, and responsive timeline sizing.
- `ShiftCard.tsx`: shift display card.
- `StaffScheduler.tsx`: location-timezone-aware staff timeline with shift/break overlays, inline actions, drag edits, empty-slot callbacks, and fail-closed DST ambiguity reporting before mutation callbacks.

## Notes

`StaffScheduler.tsx` is a presentational timeline. Tenant scoping and persistence live in the dashboard scheduling route and API controllers. Shift clicks open an inline action popover, the Edit action closes that popover before handing control to the caller, Delete appears only when the caller provides an `onEventDelete` handler and requires a second inline Confirm delete click, and empty staff-row slots call back with the selected resource and time window; callers decide whether that creates, edits, deletes, or assigns real shifts. The board status text describes the actual drag target: horizontal movement changes time, vertical movement reassigns staff, and releasing calls the persistence callback. Graphical time changes and slot selection reject nonexistent or repeated DST wall times before invoking mutation callbacks; staff-only reassignment preserves the original persisted instants. The timeline body owns vertical scrolling and mirrors that scroll into the staff-name rail so larger rosters do not clip the final row. `SchedulingGrid.tsx` does not provide dummy staff fallbacks; callers pass real tenant staff rows or real shifts, and the component renders an empty state when no staff are loaded.

The compact multi-day board projects every selected day into its own visible window, clips overnight shifts into per-day segments, and uses the same offset conversion for events, empty-slot creation, and drag edits. Narrow timeline panes use stable per-hour widths with focusable horizontal scrolling; desktop day and three-day panes continue to fit their available width. Team labels and timeline rows expose named list semantics for assistive technology.

Maintenance note: `StaffScheduler.tsx` remains large because its interaction state and component-scoped styles are co-located. Responsive sizing and date projection stay in the pure `scheduler-projection.ts` boundary; split rendered sections only with focused drag, slot-selection, scroll-sync, and accessibility regression coverage.
