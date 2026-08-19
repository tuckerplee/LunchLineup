# Caddy

## Files

- `README.md`: this Caddy folder guide.
- `Caddyfile`: active Caddy reverse proxy config mounted by `docker-compose.yml`.
- `Caddyfile.template`: template Caddy config retained for environment-specific rendering.

## Route Contract

`Caddyfile` reads `CADDY_SITE_ADDRESSES` from the Compose environment. Production should set it to one or more HTTPS hostnames so Caddy can manage certificates automatically. CI and private dev can keep explicit HTTP localhost/private addresses.

Default addresses:

- `localhost`
- `127.0.0.1`
- `proxy` for Docker-internal CI smoke checks

The proxy forwards `/health` and `/api/health` to API-v2 readiness, while `/api/v2/*` is routed to the contract-first Fastify service. Public `/api/v1/*` is terminal `410 Gone` with no upstream. The only retained-service ingress exceptions are raw-provider endpoints with fixed rewrites: `POST /api/webhooks/stripe`, `POST /api/webhooks/stripe/meter-errors`, and `POST /api/webhooks/resend/delivery-events`; these preserve provider signature bytes while hiding the private `/v1` handlers. All other paths go to Next.js. Compose healthchecks use the unexposed `http://127.0.0.1:2015/health` listener, so container health is independent of public host routing. Compose passes the explicit immutable deployment SHA as `DEPLOY_RELEASE_SHA`, and Caddy returns it in `X-LunchLineup-Release`. The canonical public root `/` is the deploy-time web probe: its release header must match the source SHA, and its body must contain the rendered LunchLineup heading plus a `/_next/static/` asset reference. This prevents an API response, generic proxy page, or stale prior-release page from satisfying the gate. The proxy also applies a 10 MB request body cap plus baseline browser security headers, including HSTS for public HTTPS deployments. API responses receive `Cache-Control: no-store` at the edge to avoid caching tenant data or metrics.
