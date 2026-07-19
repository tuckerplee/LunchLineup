# Production Terraform

## Files

- `.gitignore`: blocks local Terraform state, plans, backend configuration, and working data from Git.
- `.terraform.lock.hcl`: pins verified provider package checksums for reproducible CI and operator initialization.
- `cloud-init.yaml.tftpl`: role-specific, secret-free cloud-init template that verifies an immutable bootstrap artifact.
- `compute.tf`: the protected provider-managed VM217 app host, cloned boot disk, and cloud-init attachment.
- `dns.tf`: conditional Cloudflare A record with explicit external-owner fallback.
- `firewall.tf`: default-drop VM217 firewall options and bounded administration/edge ingress rules; data-service ports are not host-exposed.
- `infrastructure-outputs.tf`: provisioned VM217, bootstrap, DNS ownership, and authoritative Compose-topology outputs.
- `infrastructure-variables.tf`: exact Proxmox, template, network, bootstrap, and DNS input contracts.
- `README.md`: this production Terraform folder guide.
- `main.tf`: production input contract, service contract metadata, and readiness gate.
- `production-contract.test.mjs`: static HCL completeness, fixture-safety, and readiness-contract checks that run without Terraform.
- `versions.tf`: pinned Terraform/provider requirements and the required encrypted S3 backend with native lockfiles.

## Directories

- `tests/`: mocked-provider Terraform plan tests that cannot contact production services.

## Readiness Gate

`main.tf` is intentionally non-deployable without real production inputs. A production plan must provide:

- `production_apply_enabled = true`
- `domain_name` with a real public production hostname, not `localhost`, `example`, or other placeholder text.
- immutable `image_digests` for `api`, `api-v2`, `web`, `engine`, `worker`, `control`, and `migrate`.
- exactly one `vm_targets` entry with role `app`, identifying VM217 with a non-empty SSH user, data volume, and real hostname or IP address; `proxmox_vms.app.vm_id` must be exactly `217`, and every other ID is rejected.
- `network_cidr` that is a valid RFC1918 private IPv4 production network (`10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`), not `0.0.0.0/0`, `::/0`, or a public CIDR. It must equal `proxmox_network.private_cidr`, and the app target name/address must match `proxmox_vms.app`.
- `secrets_backend` using an approved managed backend URI such as `vault://`, `op://`, `aws-secretsmanager://`, `gcp-secretmanager://`, `azure-keyvault://`, `sops://`, `age://`, `bitwarden://`, `doppler://`, or `infisical://`.
- `backup_repository` using a `backup.sh`-supported off-host repository: `s3://...` or `rclone:<remote:path>`.
- `backup_metrics_collector` using `node-exporter-textfile:/absolute/path/lunchlineup_backup.prom` or `authenticated-metrics:https://...` so backup freshness cannot be left uncollected.
- `alert_targets` with explicit routes such as `pagerduty:`, `opsgenie:`, `webhook:https://`, `slack:https://`, or `mailto:`. At least one target must be a paging route (`pagerduty:`, `opsgenie:`, `webhook:https://`, or `slack:https://`), not only an inbox.
- `operator_runbook_url` pointing at `docs/runbooks/*.md` in this repository or the matching GitHub URL.

Until those inputs are supplied, `terraform plan` fails at `terraform_data.production_readiness_gate` and reports the missing fields.

Use `docs/runbooks/production-readiness.md` as the default `operator_runbook_url` for public SaaS launch readiness.

## Authoritative Production Topology

The current topology is `vm217-compose-v1`. Terraform owns one protected VM217 host plus its network, firewall, bootstrap, and DNS contract. The production `docker-compose.yml` on VM217 is the sole data-plane owner: PgBouncer, PostgreSQL, Redis, and RabbitMQ run on its private Compose networks, and no Terraform data VM or data-service firewall ingress exists.

Both application database URLs must resolve to `postgres:5432/POSTGRES_DB`. The logical backup and PITR base-backup jobs also use `POSTGRES_HOST=postgres`, so runtime traffic, backup, WAL archiving, and restore evidence cover the same authoritative PostgreSQL service and named volume.

A future external data plane is a migration, not a parallel Terraform toggle. It requires a separately reviewed topology version, replicated data and queue cutover plan, new DSN/backup/PITR contracts, restore proof from the new owner, rollback proof, and removal of the VM217 Compose data services in the same promotion. Do not add a second data VM or expose ports 5432, 6379, or 5672 while `vm217-compose-v1` is active.

## Remote Backend

Every production plan and apply must use the S3 backend declared in `versions.tf`. The backend bucket is provisioned outside this stack and must have versioning enabled, public access blocked, TLS-only access, and server-side encryption. Operators authenticate with a short-lived workload identity or assumed role; never pass access keys in `-backend-config` or commit a backend configuration file.

The backend identity needs `s3:ListBucket`, state/lock `s3:GetObject` and `s3:PutObject`, and lockfile `s3:DeleteObject` on `lunchlineup/production/terraform.tfstate` and its `.tflock` sibling. State-object deletion is not needed. Verify versioning before initialization:

```bash
test "$(aws s3api get-bucket-versioning --bucket "$TF_STATE_BUCKET" --query Status --output text)" = Enabled
terraform init -reconfigure \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="region=$AWS_REGION"
```

`terraform init` must fail if the bucket or authenticated AWS region is not supplied. Do not use `-backend=false`, `-force-copy`, a `local` backend, or a local `.tfstate` file for a production plan or apply. See `docs/runbooks/production-readiness.md` for migration, recovery, and stale-lock procedures.

## Validation And Mocked Tests

From this directory, run:

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform test
node --test production-contract.test.mjs
```

`-backend=false` is allowed only for backend-independent `validate` and mocked `test` execution in CI or a disposable local checkout. It must never precede a production plan or apply. `terraform test` uses mocked providers, plan-only runs, reserved `.test` domains, and documentation-only addresses. Its fixture accepts exact VM ID 217 and proves a different ID is rejected, but it does not apply infrastructure or contact Proxmox, Cloudflare, DNS, or VM217. The Node test lexically checks every `.tf` and `.tftest.hcl` file for unterminated strings/comments and unbalanced delimiters, so truncated HCL fails even when Terraform is unavailable.

## Production Plan

After remote initialization and backend verification:

```bash
terraform plan -var-file=production.tfvars -out=production.tfplan
terraform show production.tfplan
```

Never run terraform apply with the fixture values. Production apply requires reviewed estate-owned values, protected provider credentials, an approved change window, and a verified recovery point.
