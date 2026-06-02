#!/usr/bin/env bash
set -euo pipefail

expected_sha="${1:-}"
deployed_sha_file="${DEPLOYED_SHA_FILE:-DEPLOYED_GIT_SHA}"

current_sha="$(git rev-parse HEAD)"
status="$(git status --porcelain)"
if [[ -n "$status" ]]; then
  echo "Working tree is dirty; commit and push before deploying." >&2
  exit 1
fi

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
upstream_sha="$(git rev-parse '@{u}')"
if [[ "$current_sha" != "$upstream_sha" ]]; then
  echo "HEAD $current_sha does not match upstream $upstream at $upstream_sha." >&2
  exit 1
fi

if [[ -n "$expected_sha" && "$expected_sha" != "$current_sha" ]]; then
  echo "Expected SHA $expected_sha does not match HEAD $current_sha." >&2
  exit 1
fi

if [[ -f "$deployed_sha_file" ]]; then
  deployed_sha="$(tr -d '[:space:]' < "$deployed_sha_file")"
  if [[ -n "$deployed_sha" && "$deployed_sha" != "$current_sha" ]]; then
    echo "DEPLOYED_GIT_SHA $deployed_sha does not match HEAD $current_sha." >&2
    exit 1
  fi
fi

echo "deploy_source_ok sha=$current_sha upstream=$upstream deployed_sha_file=$deployed_sha_file"
