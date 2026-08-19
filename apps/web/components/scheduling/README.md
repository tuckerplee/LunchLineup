# Scheduling components

## Files

- `README.md`: this scheduling components guide.
- `SchedulingGrid.tsx`: reusable scheduling grid component.
- `scheduler-gesture.ts`: pure pointer-threshold, board-scoped droppable-ID, time-delta, and callback-safe drop-decision contract.
- `scheduler-projection.ts`: pure compact-day interval projection, timeline offset conversion, and responsive timeline sizing.
- `ShiftCard.tsx`: shift display card.
- `StaffScheduler.tsx`: location-timezone-aware staff timeline with shift/break overlays, inline actions, move/copy drag callbacks, empty-slot callbacks, and fail-closed DST ambiguity reporting before mutation callbacks.

## Notes

`StaffScheduler.tsx` is a presentational timeline. Tenant scoping and persistence live in the dashboard scheduling route and API controllers. Shift cards remain details/edit controls; a separate visible handle owns pointer gestures and opens the keyboard Move-or-copy dialog. Pointer movement must reach eight pixels before activation, touch handles require a deliberate hold, and the remainder of each card keeps native scrolling. Targets carry board-specific semantic IDs and are resolved only through refs owned by that mounted board. Active gestures show the source ghost, exact person/time move-or-copy preview, and valid/invalid row state. Outside release, Escape, pointer cancellation, lost capture, handle blur, and window blur clear gesture state without invoking the existing `onEventChange` or `onEventCopy` callback. `locked` or `published` events keep their details button enabled while their move handle and destructive popover action remain unavailable.

Shift clicks open an inline action popover when the caller does not provide its own selector. Delete appears only when the caller provides an `onEventDelete` handler and requires a second inline Confirm delete click. Empty staff-row slots call back with the selected resource and time window; callers decide whether that creates, edits, deletes, or assigns real shifts. Graphical time changes, copies, keyboard moves, and slot selection reject nonexistent or repeated DST wall times before mutation callbacks; staff-only reassignment preserves the original persisted instants. Break and meal markers expose their type, exact time, and conflict text to assistive technology. The timeline body owns vertical scrolling and mirrors that scroll into the staff-name rail so larger rosters do not clip the final row. `SchedulingGrid.tsx` does not provide dummy staff fallbacks; callers pass real tenant staff rows or real shifts, and the component renders an empty state when no staff are loaded.

The compact multi-day board projects every selected day into its own visible window, clips overnight shifts into per-day segments, and uses the same offset conversion for events, empty-slot creation, and drag edits. Narrow timeline panes use stable per-hour widths with focusable horizontal scrolling; desktop day and three-day panes continue to fit their available width. Team labels and timeline rows expose named list semantics for assistive technology.

Maintenance note: pointer thresholds, semantic target IDs, quantization, and fail-closed drop decisions now live in `scheduler-gesture.ts`, while responsive sizing and date projection stay in `scheduler-projection.ts`. `StaffScheduler.tsx` remains an oversized render/style owner: the next safe extraction is the Move dialog and shift-card presentation, retaining the focused Storybook gesture contract plus unit, slot-selection, scroll-sync, and accessibility coverage.
