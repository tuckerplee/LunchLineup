# API Contract

`@lunchlineup/api-contract` is the source of truth for the new HTTP API's schemas and browser transport. Native scheduling, time cards, notifications, settings, and payroll use shared TypeBox schemas. API-01 application routes use one exact shared operation catalog so Fastify registration and browser path/method validation cannot drift while API-02 replaces their retained implementations with fully typed native modules.

## Files

- `README.md`: this package guide.
- `codegen/`: checked-in client generator and its file map.
- `package.json`: package metadata, dependency, build, typecheck, and test commands.
- `src/`: TypeBox schemas, shared types, and generated client output.
- `tsconfig.json`: strict TypeScript build settings inherited from the repository baseline.

Run `npm run generate --workspace @lunchlineup/api-contract` after changing a generated scheduling-client operation. The API-01 retained operation catalog is frozen: new product operations must be added as typed native v2 contracts rather than expanding the compatibility surface.
