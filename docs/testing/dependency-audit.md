# Dependency Audit Gate

Run the launch gate with:

```bash
npm run audit:prod
```

The gate runs `npm audit --omit=dev --json` and fails every production advisory, regardless of severity or whether it is direct or transitive. It also fails closed when npm exits unexpectedly or returns an incomplete, malformed, unsupported-version, or metadata-inconsistent report. There is no advisory allowlist.

## July 16, 2026 Next/PostCSS Resolution

Stable `next@16.2.10` still declares nested `postcss@8.4.31`, which is affected by `GHSA-qx2v-qp2m-jg93`. npm proposes the production-breaking downgrade `next@9.3.3`; the first Next release line observed using patched PostCSS is canary, not stable.

The root `package.json` therefore makes every PostCSS edge use the root direct dependency through npm's `$postcss` override. The current lock resolves that dependency to `postcss@8.5.19`; every other consumer already selected that release, so the only resolved-package change is Next's nested copy. This keeps stable Next and avoids a second PostCSS version. Do not downgrade Next, move production to canary only for audit output, or add an advisory allowlist.

Resolve and validate the dependency tree with the root `packageManager` version (`npm@10.8.1` at this review). `corepack npm` selects that version; an unrelated globally installed npm must not regenerate the lock.

## Override Removal Rule

Remove the PostCSS override after a supported stable Next upgrade declares `postcss >=8.5.10`. Review the override whenever Next changes so it does not outlive the compatibility proof. Validate dependency changes with:

```bash
corepack npm ci
corepack npm audit --omit=dev
corepack npm run audit:prod
corepack npm run typecheck --workspace @lunchlineup/web
corepack npm run build --workspace @lunchlineup/web
```
