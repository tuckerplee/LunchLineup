# Email setup (Resend)

LunchLineup sends all transactional email (login OTPs, password reset, staff invitations, schedule publication) through
Resend. Production will not start without a Resend key, webhook secret and sender.

## 1. Owner actions in Resend

1. Create the Resend account and add the **sending domain** (the domain used in `EMAIL_FROM`, for example `lunchlineup.com`
   or a subdomain such as `mail.lunchlineup.com`). Choose the region closest to the servers.
2. Publish the DNS records Resend shows for that domain (section 2) at the DNS host (Cloudflare) and wait until the domain shows **Verified**.
3. Create an API key with *sending access* limited to that domain. The key starts with `re_`. Do not use a test/dev key.
4. Add a webhook endpoint `https://<production-hostname>/api/webhooks/resend/delivery-events` subscribed to bounce, complaint and
   suppression events. Copy its signing secret (`whsec_...`).

## 2. DNS records (SPF, DKIM, DMARC)

Resend generates the exact names and values per domain and region; copy them from the domain page. The shape is:

| Purpose | Type | Name | Value |
| --- | --- | --- | --- |
| DKIM | TXT | `resend._domainkey.<domain>` | `p=<public key shown by Resend>` |
| SPF (return path) | MX | `send.<domain>` | `feedback-smtp.<region>.amazonses.com`, priority 10 |
| SPF | TXT | `send.<domain>` | `v=spf1 include:amazonses.com ~all` |
| DMARC | TXT | `_dmarc.<domain>` | `v=DMARC1; p=none; rua=mailto:<owner-monitored-mailbox>` |

Notes:

- SPF and the bounce MX live on Resend's `send.` subdomain, so they do not collide with an existing SPF record on the apex.
  If the same domain also sends mail from Google Workspace or similar, keep that record and do not merge Resend into it.
- DMARC is not issued by Resend; the owner adds it once per domain. Start at `p=none` with an `rua` mailbox that is read,
  move to `p=quarantine` after a clean reporting period.
- In Cloudflare set all three records to **DNS only** (grey cloud).
- `EMAIL_FROM` must be an address on the verified domain, for example `LunchLineup <no-reply@lunchlineup.com>`.

## 3. Runtime values

Put these in the production runtime env (template: `infrastructure/production/runtime.env.example`):

`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `RESEND_PREFLIGHT_RECIPIENT` (owner inbox that receives the test message),
`RESEND_PREFLIGHT_TIMEOUT_MS`, `SCHEDULE_PUBLISHED_EMAIL_ENABLED=true`.

## 4. The one operator command

```
node scripts/verify-resend-readiness.mjs <runtime-env-file> --to owner@your-domain.com
```

(also available as `npm run email:verify -- <runtime-env-file> --to owner@your-domain.com`)

What it does, in order:

1. Parses the env file (or `process.env` when no file is given) and validates `RESEND_API_KEY` (live key shape, not `re_dev_`/`re_test_`),
   `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM` (public domain, not an example/test domain) and the recipient.
2. Resolves the release id from `--release-sha`, else `DEPLOY_RELEASE_SHA`, else `git rev-parse HEAD`.
3. Sends exactly **one** email to `--to` (or `RESEND_PREFLIGHT_RECIPIENT`) with a fresh idempotency key and a 10 s timeout, and prints a JSON result without the recipient or provider response body.

Use `--check-only` to run only step 1 and 2 with no network call. A non-zero exit prints a short reason code (for example
`resend_api_key_not_live`, `email_from_invalid`, `provider_rejected_status_403`). A 403 usually means the domain is not verified yet or
the key is restricted to another domain.

After it succeeds, confirm the message arrives in the owner inbox, passes SPF/DKIM/DMARC in the message headers, and that the
Resend webhook shows a successful test delivery. The command is not run automatically anywhere except the production deploy preflight.
