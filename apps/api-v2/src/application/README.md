# Application API v2

## Files

- `README.md`: this module guide.
- `routes.ts`: exact API-01 browser operation registration; `GET /auth/me` is native and the remaining operations retain explicit API-02 compatibility ownership.

The route catalog is shared from `@lunchlineup/api-contract`. There is no wildcard or caller-supplied upstream path. Scheduling calendar mutations are deliberately absent because the native scheduling module owns them as revision-fenced aggregate change sets.
