# Dashboard time-cards

## Files

- `README.md`: this time-cards route guide.
- `page.tsx`: server route that requires `time_cards:read` and passes independent time-card, staff-roster, and location-catalog capabilities to the client workspace.
- `TimeCardsWorkspace.tsx`: client time clock UI for optional staff and location selection, read-only history review, clock-in, clock-out, active card status, and card history.
- `time-card-format.ts`: duration formatting helper shared by the timecard workspace and unit tests.
- `time-card-request.ts`: selected-employee ownership guard for active-card actions.

## Notes

The UI relies on the API for tenant and role enforcement. Team selection requires both `users:read` and the roster endpoint's `shifts:read`; the location selector requires `locations:read`. Time-card history remains available without either optional catalog, and clock-in and clock-out controls require `time_cards:write`. Employee changes immediately clear the prior employee's active card and history, and superseded responses cannot restore them. If entitlement is lost while a card is open, the workspace keeps the active-card recovery result, disables history and new clock-ins, and leaves clock-out available. Clock-out remains disabled unless the loaded active card belongs to the current selection.
