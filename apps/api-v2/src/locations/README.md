# API v2 Locations

## Files

- `README.md`: this locations-module guide.
- `identifier-translation.ts`: exact-field public/internal location-ID anti-corruption translator for declared retained browser domains.
- `identifier-translation.test.ts`: retained request/response mapping, non-location field preservation, and fail-closed regression tests.
- `locations.service.ts`: tenant-RLS location lifecycle, capacity, idempotency, public-ID serialization, and retained-route identifier resolution.
- `locations.service.test.ts`: public-ID pagination, idempotent create, capacity-lock, timezone-history, and identifier-resolution regression tests.
- `routes.ts`: typed native API-02 location HTTP routes, permission checks, and CSRF enforcement.

## Notes

Every public `/api/v2/locations` identifier is `Location.publicId`; the storage primary key remains private. Lists paginate by `name, publicId`, backed by the matching tenant/deletion/public-ID composite index. Create uses a tenant advisory lock around capacity and durable idempotency checks. Updates and deletion lock the active location, reject timezone rewrites after published history, and increment only affected draft schedule revisions.
