# Owner checklist: production launch

Everything below is an input only the owner can supply. Fill the value where indicated, then run
`node scripts/check-production-env.mjs /etc/lunchlineup/runtime.env --verify-local-secret-files` until it prints `"ok": true`.
`RUNTIME` = the production runtime env (template `infrastructure/production/runtime.env.example`, kept outside Git, mode 0600).
`BUILD` = compiled into the web image at build time.

| # | Input or decision | Where it goes | Detail |
| --- | --- | --- | --- |
| 1 | Production hostname and Cloudflare DNS/proxy | RUNTIME: `DOMAIN`, `APP_ORIGIN`, `ALLOWED_*`, `CADDY_SITE_ADDRESSES`, `PRODUCTION_API_HEALTH_URL`, `LUNCHLINEUP_STATUS_HEALTH_URL`; BUILD: `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_APP_URL` | Not `beta.` or `dev.`; HTTPS only. |
| 2 | Operations mailbox | RUNTIME: `ADMIN_EMAIL` | Monitored; on the production domain. |
| 3 | Stripe live account | RUNTIME: `STRIPE_SECRET_KEY` (`sk_live_`), `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_ENDPOINT_ID`, `STRIPE_METER_*`, `STRIPE_PRICE_STARTER/GROWTH/ENTERPRISE` | Webhook endpoint must be created for the production host. |
| 4 | Resend account and verified domain | RUNTIME: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `RESEND_PREFLIGHT_RECIPIENT` | DNS and test command: `docs/launch/email-setup.md`. |
| 5 | Send the one test email | Run `node scripts/verify-resend-readiness.mjs <runtime.env> --to <owner inbox>` | Confirm receipt and SPF/DKIM/DMARC pass. |
| 6 | Legal entity, address, governing law, effective date | `packages/config/legal-launch.json` `business.*` | `docs/launch/legal-review-packet.md` A. |
| 7 | Public contact mailboxes (privacy, support, DPA) | BUILD: `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, `NEXT_PUBLIC_DPA_CONTACT_EMAIL` | Must be monitored. |
| 8 | Counsel review and DPA | `PAID_GA_*` in RUNTIME (11 values); approval record in storage you control | Packet sections C and D. |
| 9 | Approval switch | `packages/config/legal-launch.json` `approval` | Packet section E. Required for every production launch (the checker ties `PAID_GA_LEGAL_APPROVED=true` to it) and for `invite_only`/`open`. |
| 10 | Signup mode decision | RUNTIME `PUBLIC_SIGNUP_MODE` and BUILD `NEXT_PUBLIC_SIGNUP_MODE` (identical) | `docs/launch/signup-modes.md`. Default `closed_beta`. |
| 11 | Turnstile keys (only for `open`) | BUILD `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; RUNTIME `TURNSTILE_SECRET_KEY` | Cloudflare account. |
| 12 | Invite codes (only for `invite_only`) | RUNTIME `PUBLIC_SIGNUP_INVITE_CODES` | Treat as secrets. |
| 13 | Backups and point-in-time recovery | `PGBACKREST_*` (runtime env section 9); provide the NAS chroot user, SFTP key file, NAS host keys (`known_hosts`) and repository passphrase file on the VM | pgBackRest inside the postgres container (repository on the NAS over SFTP; `infrastructure/postgres/README.md`) for Postgres, backups scheduled by estate-infra, and host restic for files. Confirm `pgbackrest check` and a full backup pass and that a restore drill (`postgres-pitr-recovery.md`) has passed. |
| 14 | Alert delivery and dashboards | Estate systems; no RUNTIME keys | Estate Alertmanager (`alertmanager.int.tuckerl.ee`) owns routing and mail; estate Prometheus and Grafana use `docs/estate/`. Confirm estate-infra loaded `lunchlineup-rules.yml`, `lunchlineup-targets.yml` and the dashboards, and that the metrics token file exists at the path in the scrape job. No webhook URL is configured in the app. |
| 15 | Generated secrets | RUNTIME every `GENERATE_ME` key; host secret files under `/run/secrets` | `openssl rand -hex 32` each; never reuse. Operator can do this, owner only stores them safely. |
| 16 | Launch proof evidence | RUNTIME `LAUNCH_PROOF_*` | DAST, load test, DR drill (estate pgBackRest restore), alert-route test (estate Alertmanager), external health check references. |
| 17 | Organizational evidence (policy, access review, incident roster, vendor agreements) | Protected storage outside Git | `docs/compliance/owner-input-register.md` (C13-*). |
| 18 | Final go/no-go | Owner | Re-run the checker, then the deploy preflight (it runs the email probe and launch policy). |

Not owner inputs (already handled in the repository): production-mode startup gates, the signup fail-closed rules, the env checker, the email probe.
Currently unfilled in the repository: all `OWNER` markers in `legal-launch.json` and in the env template, and `approval.approved=false`.
