# Schedule print route

## Files

- `README.md`: this print route guide.
- `page.tsx`: authenticated browser-print schedule view that resolves one UUID location from the v2 board before projecting the selected day.
- `print-schedule-scope.ts`: pure date/location request-scope helpers used to gate printable data and actions.

## Notes

`page.tsx` performs one tenant-scoped v2 board read, filters the selected schedule's full shift set to the requested location-local date, and formats shift/break times in that location timezone. Date or location-scope changes clear prior rows immediately; superseded responses are discarded, and print actions stay disabled until the current scope has loaded. It renders the old paper layout: Schedule on the left, Tip Tracker and Training on the right, with the legacy Employee, Shift, POS #, Break 1, Lunch, Break 2, and Chores columns. The route is designed for browser printing on Letter landscape paper.
