# Production infrastructure inputs

## Files

- `README.md`: this folder guide.
- `runtime.env.example`: production runtime env template with no secrets; `OWNER:` and `GENERATE_ME` markers must be replaced and the result validated with `node scripts/check-production-env.mjs`.
- `compose.production-proxy.yml`: binds Caddy to the production VM private IP (`PROXY_HTTP_BIND`), serves only lunchlineup.com, requires offsite backups. Used by `scripts/deploy-release.sh --target production`.
