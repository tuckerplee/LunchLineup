# Production compose overlay

- `compose.production-proxy.yml`: binds Caddy to the production VM private IP (`PROXY_HTTP_BIND`), serves only lunchlineup.com, requires offsite backups. Used by `scripts/deploy-release.sh --target production`.
