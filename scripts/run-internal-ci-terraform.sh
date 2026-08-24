#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${1:-}" == --source-context && -n "${2:-}" && $# == 2 ]] || { echo 'Usage: run-internal-ci-terraform.sh --source-context <context.json>' >&2; exit 64; }
context=$2; workspace=$PWD; artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; build_root="$source_root/build"; tf_data_dir="$RUNNER_TEMP/lunchlineup-terraform-$CI_RUN_ID"
test "$context" = "$source_root/source-context.json"; test -d "$build_root"; test ! -e "$tf_data_dir"
node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build >/dev/null
mkdir -p "$artifact_root/terraform" "$artifact_root/results" "$artifact_root/details"
cleanup(){ rm -rf -- "$tf_data_dir"; }; trap cleanup EXIT
export TF_DATA_DIR="$tf_data_dir"; started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
terraform version -json >"$artifact_root/terraform/version.json"; test "$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(v.terraform_version)' "$artifact_root/terraform/version.json")" = 1.13.5
terraform fmt -check -recursive "$build_root/infrastructure/terraform" >"$artifact_root/terraform/fmt.log" 2>&1
terraform -chdir="$build_root/infrastructure/terraform/production" init -backend=false -input=false >"$artifact_root/terraform/init.log" 2>&1
terraform -chdir="$build_root/infrastructure/terraform/production" validate >"$artifact_root/terraform/validate.log" 2>&1
terraform -chdir="$build_root/infrastructure/terraform/production" test >"$artifact_root/terraform/test.log" 2>&1
printf '{"sourceSha":"%s","terraformVersion":"1.13.5"}\n' "$CI_COMMIT_SHA" >"$artifact_root/details/terraform-validation.json"
node "$build_root/scripts/write-internal-ci-command-result.mjs" --name terraform-validation --source-context "$context" --started-at "$started_at" --output "$artifact_root/results/terraform-validation.json"
node "$build_root/scripts/record-internal-ci-gate.mjs" --name terraform-validation --source-context "$context" --started-at "$started_at" --command-result "$artifact_root/results/terraform-validation.json" --details "$artifact_root/details/terraform-validation.json" --output "$artifact_root/gates/terraform-validation.json" --evidence "$artifact_root/terraform/version.json" --evidence "$artifact_root/terraform/fmt.log" --evidence "$artifact_root/terraform/init.log" --evidence "$artifact_root/terraform/validate.log" --evidence "$artifact_root/terraform/test.log"
