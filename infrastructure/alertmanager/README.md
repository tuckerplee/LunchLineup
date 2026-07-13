# Alertmanager

## Files

- `README.md`: this Alertmanager folder guide.
- `alertmanager.yml`: private Alertmanager routing config loaded by Docker Compose.

## Purpose

Alertmanager receives paging events on the internal `management` network and publishes no host ports, so its HTTP UI/API is not publicly reachable. It is also the only service attached to the dedicated `alertmanager-egress` bridge. That network disables inter-container communication and is selected as Alertmanager's default gateway with `gw_priority`, allowing outbound HTTPS paging webhooks through Docker NAT without joining the shared public-edge network. This requires Docker Compose 2.33.1 or later. The production paging webhook URL is supplied through the `alertmanager_webhook_url` Docker secret, not environment variables or checked-in plaintext.
