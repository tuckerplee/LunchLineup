# API Contract

`@lunchlineup/api-contract` is the source of truth for the new HTTP API's schemas and browser client. Fastify routes consume the same TypeBox schemas that describe OpenAPI, and the web app consumes the generated client instead of constructing endpoint paths itself.

## Files

- `README.md`: this package guide.
- `codegen/`: checked-in client generator and its file map.
- `package.json`: package metadata, dependency, build, typecheck, and test commands.
- `src/`: TypeBox schemas, shared types, and generated client output.
- `tsconfig.json`: strict TypeScript build settings inherited from the repository baseline.

Run `npm run generate --workspace @lunchlineup/api-contract` after changing a client operation. CI and the package build rerun generation and fail on TypeScript drift.
