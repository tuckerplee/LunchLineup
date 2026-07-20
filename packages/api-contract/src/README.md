# API Contract Source

## Files

- `README.md`: this source-folder guide.
- `authentication.ts`: native session identity and current-session response schemas.
- `authentication.test.ts`: current-session envelope and MFA-state schema regression tests.
- `application.ts`: exact API-01 browser operation catalog and safe client matcher.
- `application.test.ts`: uniqueness, safety, and no-legacy-shift-mutation regression tests.
- `generated-client.ts`: deterministic browser client output; regenerate it instead of editing it.
- `index.ts`: package exports.
- `locations.ts`: native API-02 location records, request schemas, pagination, and Problem Details responses.
- `locations.test.ts`: public-ID, pagination-envelope, and strict location-write schema regression tests.
- `operations.ts`: native operational read-model and lunch/break planning schemas.
- `scheduling.ts`: scheduling schemas, request/response contracts, and RFC 9457 Problem Details.
- `scheduling.test.ts`: focused schema and generated-client contract tests.
- `time-cards.ts`: native time-card records, public-identifier paths, lifecycle requests, pagination, and Problem Details responses.
- `time-cards.test.ts`: public time-card and break-record contract regressions.
