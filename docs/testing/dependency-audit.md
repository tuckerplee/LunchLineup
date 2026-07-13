# Dependency Audit Gate

This document records the production dependency audit triage for the rebuild.
Run the launch gate with:

```bash
npm run audit:prod
```

The gate runs `npm audit --omit=dev --json`, fails any high or critical production advisory, fails unexpected production advisories, and allows only the documented Next/PostCSS moderate advisory below.

The allowlist is intentionally exact. The `next` vulnerability object must contain only the nested `postcss` via entry with npm's documented downgrade fix, and the `postcss` vulnerability object must contain only advisory `GHSA-qx2v-qp2m-jg93` for `node_modules/next/node_modules/postcss`. If npm adds another advisory to either object, `npm run audit:prod` must fail until the new advisory is triaged.

## July 9, 2026 Next/PostCSS Triage

Local npm evidence:

- `npm view next dist-tags --json`: `latest` is `16.2.10`; `canary` is `16.3.0-canary.81`.
- `npm view next@latest dependencies.postcss version --json`: `next@16.2.10` still declares `postcss: 8.4.31`.
- `npm view next@canary dependencies.postcss version --json`: `next@16.3.0-canary.81` declares `postcss: 8.5.10`.
- `npm audit --omit=dev --json`: production advisories are moderate `next` via `postcss` and nested `node_modules/next/node_modules/postcss`, advisory `GHSA-qx2v-qp2m-jg93`.
- `npm audit fix --omit=dev --dry-run --json`: npm's available fix is `next@9.3.3` with `isSemVerMajor: true`, which is a production-breaking downgrade for this rebuild.

Do not run `npm audit fix --force` for this advisory. Do not move production to a Next canary only to clear audit output.

## Removal Rule

Remove the triage from `scripts/audit-prod.mjs` after a stable `next@latest` release keeps this project on the supported Next major and resolves the nested PostCSS range with `postcss >=8.5.10`. Validate removal with:

```bash
npm install
npm audit --omit=dev
npm run audit:prod
npm run build --workspace @lunchlineup/web
```
