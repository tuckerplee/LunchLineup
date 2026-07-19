# API Client Code Generation

## Files

- `README.md`: this code-generation guide.
- `generate-client.mjs`: deterministic generator for `src/generated-client.ts`.

The generator owns endpoint path interpolation, session-neutral fetch calls, bounded JSON parsing, runtime response validation, and RFC 9457 error decoding. Authentication and refresh behavior are injected through the generated client's `fetch` option by the web application.
