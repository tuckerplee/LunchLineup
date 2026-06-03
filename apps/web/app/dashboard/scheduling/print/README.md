# Schedule print route

## Files

- `README.md`: this print route guide.
- `page.tsx`: authenticated browser-print schedule view using the legacy landscape layout.

## Notes

`page.tsx` fetches tenant-scoped shifts from `/shifts` for the selected date and renders the old paper layout: Schedule on the left, Tip Tracker and Training on the right, with the legacy Employee, Shift, POS #, Break 1, Lunch, Break 2, and Chores columns. The route is designed for browser printing on Letter landscape paper.
