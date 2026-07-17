# Plan Administration

This folder owns platform plan and subscription configuration. Plans define subscription availability, monthly pricing, and location/user capacity only. Billable use also requires separately purchased or administratively granted wallet credits; plans never include recurring or unlimited credits.

## Files

- `README.md`: folder ownership and file inventory.
- `page.tsx`: server route entrypoint for plan administration.
- `PlansClient.tsx`: client plan catalog, create/edit forms, filters, and subscription-capacity display.
