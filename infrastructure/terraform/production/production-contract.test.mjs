import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mainTf = readFileSync(join(here, 'main.tf'), 'utf8');
const versionsTf = readFileSync(join(here, 'versions.tf'), 'utf8');
const readme = readFileSync(join(here, 'README.md'), 'utf8');
const runbook = readFileSync(join(here, '..', '..', '..', 'docs', 'runbooks', 'production-readiness.md'), 'utf8');
const localIgnore = readFileSync(join(here, '.gitignore'), 'utf8');
const terraformFiles = readdirSync(here)
  .filter((name) => name.endsWith('.tf'))
  .map((name) => ({ name, source: readFileSync(join(here, name), 'utf8') }));
const terraformTestFiles = readdirSync(join(here, 'tests'))
  .filter((name) => name.endsWith('.tftest.hcl'))
  .map((name) => ({ name: `tests/${name}`, source: readFileSync(join(here, 'tests', name), 'utf8') }));
const allTf = terraformFiles.map(({ source }) => source).join('\n');

function assertBalancedHcl(source, name) {
  const pairs = new Map([['}', '{'], [']', '['], [')', '(']]);
  const delimiters = [];
  const stringReturnStates = [];
  let state = 'code';

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'string') {
      if (character === '\\') index += 1;
      else if ((character === '$' || character === '%') && next === '{') {
        delimiters.push({ character: '{', returnsToString: true });
        state = 'code';
        index += 1;
      } else if (character === '"') state = stringReturnStates.pop();
      continue;
    }
    if (character === '#') state = 'line-comment';
    else if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
    } else if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
    } else if (character === '"') {
      stringReturnStates.push('code');
      state = 'string';
    } else if ('{[('.includes(character)) delimiters.push({ character, returnsToString: false });
    else if (pairs.has(character)) {
      const opening = delimiters.pop();
      assert.equal(opening?.character, pairs.get(character), `${name}:${index + 1} has an unmatched ${character}`);
      if (opening.returnsToString) state = 'string';
    }
  }

  if (state === 'line-comment') state = 'code';
  assert.equal(state, 'code', `${name} ends inside ${state}`);
  assert.deepEqual(stringReturnStates, [], `${name} has an unterminated string`);
  assert.deepEqual(delimiters, [], `${name} has unclosed delimiters`);
}

test('every Terraform source and mocked test has complete lexical structure', () => {
  const hclFiles = [...terraformFiles, ...terraformTestFiles];
  for (const { name, source } of hclFiles) assertBalancedHcl(source, name);
  for (const { name, source } of hclFiles) {
    const finalBrace = source.lastIndexOf('}');
    assert.notEqual(finalBrace, -1, `${name} must contain a complete HCL block`);
    assert.throws(() => assertBalancedHcl(source.slice(0, finalBrace), `${name} truncated fixture`), /unclosed delimiters/);
  }
});

test('production Terraform contains provider-backed rebuild resources', () => {
  assert.doesNotMatch(allTf, /Architecture Part IX|docker_container|:latest/i);
  assert.match(mainTf, /variable "image_digests"/);
  assert.match(mainTf, /variable "vm_targets"/);
  assert.match(mainTf, /variable "backup_repository"/);
  assert.match(mainTf, /variable "backup_metrics_collector"/);
  assert.match(mainTf, /variable "secrets_backend"/);
  assert.match(allTf, /source\s*=\s*"bpg\/proxmox"/);
  assert.match(allTf, /resource "proxmox_virtual_environment_vm" "app"/);
  assert.match(allTf, /resource "proxmox_virtual_environment_vm" "data"/);
  assert.match(allTf, /resource "proxmox_virtual_environment_file" "cloud_init"/);
  assert.match(allTf, /resource "proxmox_virtual_environment_firewall_options" "app"/);
  assert.match(allTf, /resource "proxmox_virtual_environment_firewall_rules" "data"/);
  assert.match(allTf, /resource "cloudflare_dns_record" "production"/);
  assert.match(allTf, /prevent_destroy\s*=\s*true/);
  assert.match(allTf, /interface\s*=\s*"scsi1"/);

  for (const service of ['api', 'web', 'engine', 'worker', 'control', 'migrate']) {
    assert.match(mainTf, new RegExp(`"${service}"`));
  }
});

test('production Terraform blocks plan until real readiness inputs exist', () => {
  assert.match(mainTf, /variable "production_apply_enabled"/);
  assert.match(mainTf, /resource "terraform_data" "production_readiness_gate"/);
  assert.match(mainTf, /missing_required_inputs/);
  assert.match(mainTf, /condition\s*=\s*length\(local\.missing_required_inputs\) == 0/);
  assert.match(mainTf, /Supply real production inputs before claiming readiness/);
});

test('mocked Terraform tests remain plan-only and use reserved fixture values', () => {
  assert.ok(terraformTestFiles.length > 0, 'at least one mocked Terraform test is required');
  for (const { name, source } of terraformTestFiles) {
    assert.match(source, /mock_provider\s+"proxmox"\s*{}/, `${name} must mock Proxmox`);
    assert.match(source, /mock_provider\s+"cloudflare"\s*{}/, `${name} must mock Cloudflare`);
    assert.match(source, /command\s*=\s*plan/, `${name} must exercise planning`);
    assert.doesNotMatch(source, /command\s*=\s*apply/, `${name} must never apply`);
    assert.match(source, /[.]terraform[.]test/, `${name} must use reserved test domains`);
    assert.match(source, /192[.]0[.]2[.][0-9]+/, `${name} must use a documentation-only public address`);
    assert.doesNotMatch(source, /(?:^|[^0-9])217(?:[^0-9]|$)/, `${name} must not reference VM217`);
  }
});

test('production plans require an encrypted, lockfile-enabled remote S3 backend', () => {
  assert.match(versionsTf, /required_version\s*=\s*">= 1[.]10[.]0"/);
  assert.match(versionsTf, /backend\s+"s3"\s*{/);
  assert.match(versionsTf, /key\s*=\s*"lunchlineup\/production\/terraform[.]tfstate"/);
  assert.match(versionsTf, /encrypt\s*=\s*true/);
  assert.match(versionsTf, /use_lockfile\s*=\s*true/);
  assert.doesNotMatch(allTf, /backend\s+"local"/);

  for (const pattern of ['[.]terraform/', '[*][.]tfstate', '[*][.]tfstate[.][*]', '[*][.]tfplan', 'backend[.]hcl']) {
    assert.match(localIgnore, new RegExp(pattern));
  }
});

test('production guidance confines backend=false to validation and mocked tests', () => {
  for (const document of [readme, runbook]) {
    assert.doesNotMatch(document, /terraform init -backend=false[^`]*terraform plan/);
    assert.doesNotMatch(document, /terraform apply[^\n]*-(?:state|state-out)(?:=|\s)/);
    const commandBlocks = [...document.matchAll(/```(?:bash|powershell)\r?\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .filter((block) => /terraform (?:plan|apply)/.test(block));
    assert.ok(commandBlocks.length > 0, 'production guidance must contain a plan/apply command block');
    for (const block of commandBlocks) {
      assert.doesNotMatch(block, /(?:^|\s)-(?:backend=false|lock=false|force-copy|state(?:-out)?(?:=|\s))/);
    }
  }
  assert.match(readme, /versioning enabled/);
  assert.match(readme, /get-bucket-versioning/);
  assert.match(readme, /terraform init -reconfigure/);
  assert.match(readme, /short-lived workload identity or assumed role/);
  assert.match(readme, /`-backend=false` is allowed only for backend-independent `validate` and mocked `test`/);
  assert.match(runbook, /## Existing State Migration/);
  assert.match(runbook, /## State And Lock Recovery/);
});

test('production Terraform rejects local-only or vague production controls', () => {
  for (const expected of [
    'domain_name_ready',
    'vm_targets_ready',
    'network_cidr_ready',
    'secrets_backend_ready',
    'backup_repository_ready',
    'backup_metrics_collector_ready',
    'critical_alert_route_ready',
    'alert_targets_ready',
    'operator_runbook_ready',
  ]) {
    assert.match(mainTf, new RegExp(expected));
  }

  assert.match(allTf, /input_policy\s*=\s*"DROP"/);
  assert.match(allTf, /source\s*=\s*split\("\/", var\.proxmox_vms\["app"\]\.ipv4_cidr\)\[0\]/);
  assert.match(allTf, /dport\s*=\s*"5432,6379,5672"/);
  assert.match(allTf, /CLOUDFLARE_API_TOKEN/);
  assert.match(allTf, /PROXMOX_VE_API_TOKEN/);
  assert.doesNotMatch(allTf, /variable "(api_token|password|private_key|cloudflare_api_token)"/);
  assert.match(allTf, /bootstrap_sha256/);
  assert.match(allTf, /release_source_sha/);
  assert.match(allTf, /secrets_backend_uri/);
  assert.match(allTf, /trimspace\(var\.network_cidr\) == trimspace\(var\.proxmox_network\.private_cidr\)/);
  assert.match(allTf, /declared_target\.address == split\("\/", target\.ipv4_cidr\)\[0\]/);
  assert.match(mainTf, /10\[\.\]\|172\[\.\]\(1\[6-9\]\|2\[0-9\]\|3\[01\]\)\[\.\]\|192\[\.\]168/);
  assert.match(mainTf, /vault\|op\|aws-secretsmanager\|gcp-secretmanager\|azure-keyvault/);
  assert.match(mainTf, /\^\(s3:\/\/\[\^ \]\+\|rclone:\[\^ \]\+\)\$/);
  assert.match(readme, /RFC1918 private IPv4/);
  assert.match(readme, /`s3:\/\/\.\.\.` or `rclone:<remote:path>`/);
  assert.doesNotMatch(mainTf, /b2\|gs\|azure\|ssh\|sftp\|restic/);
  assert.doesNotMatch(readme, /b2:\/\/|gs:\/\/|azure:\/\/|ssh:\/\/|sftp:\/\/|restic:/);
  assert.match(mainTf, /node-exporter-textfile/);
  assert.match(mainTf, /authenticated-metrics:https/);
  assert.match(mainTf, /pagerduty\|opsgenie/);
  assert.match(mainTf, /webhook\|slack/);
  assert.match(mainTf, /mailto:/);
  assert.doesNotMatch(mainTf, /can\(regex\("\^\[\^@ \]\+@\[\^@ \]\+\[\.\]\[\^@ \]\+\$"/);
  assert.match(mainTf, /docs\/runbooks\//);
  assert.match(mainTf, /public_unauthenticated_metrics_ok\s*=\s*false/);
  assert.match(readme, /terraform test/);
  assert.match(readme, /Never run terraform apply/);
});
