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

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  if [[ "${GITHUB_EVENT_NAME:-}" != "push" ]]; then
    echo "GitHub Actions deploy-source verification requires a push event." >&2
    exit 1
  fi
  if [[ "${GITHUB_REF:-}" != refs/heads/* ]]; then
    echo "GitHub Actions deploy-source verification requires a branch ref." >&2
    exit 1
  fi
  if [[ "${GITHUB_SHA:-}" != "$current_sha" ]]; then
    echo "GitHub Actions SHA ${GITHUB_SHA:-unset} does not match HEAD $current_sha." >&2
    exit 1
  fi
  upstream="${GITHUB_REF}"
  upstream_sha="$(git ls-remote origin "$GITHUB_REF" | awk '{print $1}')"
else
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
  upstream_sha="$(git rev-parse '@{u}')"
fi

if [[ -z "$upstream_sha" || "$current_sha" != "$upstream_sha" ]]; then
  echo "HEAD $current_sha does not match upstream $upstream at ${upstream_sha:-missing}." >&2
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
