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

## October 8, 2026 selector-parser compatibility override

Two exact-parent overrides select `postcss-selector-parser@7.1.6` for
`tailwindcss@3.4.19` and `postcss-nested@6.2.0`, addressing
[GHSA-rj75-hqrm-r3gf](https://github.com/postcss/postcss-selector-parser/security/advisories/GHSA-rj75-hqrm-r3gf).
This is a reviewed compatibility override; the parents still declare 6.x.
The [upstream 6.1.4–7.1.6 comparison](https://github.com/postcss/postcss-selector-parser/compare/6.1.4...7.1.6)
changes only the parser among executable source files. The container iteration
behavior cited as a 7.0 breaking change is already present in installed 6.1.4;
the consumer APIs and Tailwind's deep unescape import remain available.

A clean install resolves both inspected parents to 7.1.6. Generating the current
application stylesheet with its existing Tailwind configuration produces
identical output before and after: 73,086 bytes, SHA-256
`d376fda2cc47abfd9a9e113679fe0d3e9fba541f8749f38f523baa916de67d73`.
Tailwind, its configuration, authored CSS and supported browser contract are unchanged.
Parser fixes can change handling of malformed or namespace selectors, so review
these exact-parent overrides when either parent changes and remove them once
the supported parent versions select a patched parser without overrides.

The advisory describes synchronous parsing of untrusted selectors. The
identified application use is trusted build-time CSS; this change does not
claim a demonstrated production exploit or dismiss the advisory.
