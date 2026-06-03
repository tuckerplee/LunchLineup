# Caddy

## Files

- `README.md`: this Caddy folder guide.
- `Caddyfile`: active Caddy reverse proxy config mounted by `docker-compose.yml`.
- `Caddyfile.template`: template Caddy config retained for environment-specific rendering.

## Dev Route

`Caddyfile` is configured for HTTP-only VM107 private development routes:

- `dev.lunchlineup.com`
- `lunchlineup-dev.proxmox1.lan`
- `lunchlineup-dev-vm.proxmox1.lan`
- `10.231.10.108`

The proxy forwards `/health`, `/api/health`, and `/api/v1/*` to the API service, `/ws/*` to the engine service, and all other paths to the Next.js web service.
