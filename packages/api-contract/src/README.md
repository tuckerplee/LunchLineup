# API Contract Source

## Files

- `README.md`: this source-folder guide.
- `authentication.ts`: native session identity and current-session response schemas.
- `authentication.test.ts`: current-session envelope and MFA-state schema regression tests.
- `application.ts`: exact API-01 browser operation catalog and safe client matcher.
- `application.test.ts`: uniqueness, safety, and no-legacy-shift-mutation regression tests.
- `generated-client.ts`: deterministic browser client output; regenerate it instead of editing it.
- `index.ts`: package exports.
- `scheduling.ts`: scheduling schemas, request/response contracts, and RFC 9457 Problem Details.
- `scheduling.test.ts`: focused schema and generated-client contract tests.
