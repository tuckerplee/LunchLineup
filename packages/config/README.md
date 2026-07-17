# Shared configuration

## Files

- `README.md`: this shared configuration package inventory.
- `defaults.d.ts`: generated declarations for the checked-in default resolver compatibility build.
- `defaults.d.ts.map`: declaration source map for `defaults.d.ts`.
- `defaults.js`: generated JavaScript for the checked-in default resolver compatibility build.
- `defaults.js.map`: JavaScript source map for `defaults.js`.
- `defaults.ts`: environment-aware platform default resolution.
- `index.d.ts`: generated declarations for the checked-in package barrel compatibility build.
- `index.d.ts.map`: declaration source map for `index.d.ts`.
- `index.js`: generated JavaScript for the checked-in package barrel compatibility build.
- `index.js.map`: JavaScript source map for `index.js`.
- `index.ts`: package barrel for configuration schemas, defaults, headers, rate limits, and the public legal manifest.
- `legal-manifest.ts`: immutable Terms and Privacy versions plus the fail-closed self-service legal-approval gate shared by API and web.
- `loader.d.ts`: generated declarations for the checked-in configuration loader compatibility build.
- `loader.d.ts.map`: declaration source map for `loader.d.ts`.
- `loader.js`: generated JavaScript for the checked-in configuration loader compatibility build.
- `loader.js.map`: JavaScript source map for `loader.js`.
- `loader.ts`: validated configuration loading.
- `package.json`: `@lunchlineup/config` workspace package metadata and build commands.
- `rate-limits.d.ts`: generated declarations for the checked-in rate-limit compatibility build.
- `rate-limits.d.ts.map`: declaration source map for `rate-limits.d.ts`.
- `rate-limits.js`: generated JavaScript for the checked-in rate-limit compatibility build.
- `rate-limits.js.map`: JavaScript source map for `rate-limits.js`.
- `rate-limits.ts`: plan-aware request limit policy.
- `schema.d.ts`: generated declarations for the checked-in platform schema compatibility build.
- `schema.d.ts.map`: declaration source map for `schema.d.ts`.
- `schema.js`: generated JavaScript for the checked-in platform schema compatibility build.
- `schema.js.map`: JavaScript source map for `schema.js`.
- `schema.ts`: Zod platform configuration schema.
- `security-headers.d.ts`: generated declarations for the checked-in security-header compatibility build.
- `security-headers.d.ts.map`: declaration source map for `security-headers.d.ts`.
- `security-headers.js`: generated JavaScript for the checked-in security-header compatibility build.
- `security-headers.js.map`: JavaScript source map for `security-headers.js`.
- `security-headers.ts`: shared CSP and security-header construction.
- `tsconfig.json`: package TypeScript build configuration.

## Legal Manifest

`PUBLIC_LEGAL_MANIFEST` is the single owner of public Terms and Privacy versions and self-service approval state. API and web consumers import it through `@lunchlineup/config`; production self-service remains closed unless counsel approval, production enablement, and both approved versions match the rendered documents.