#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${1:-}" == --source-context && -n "${2:-}" && "${3:-}" == --inventory && -n "${4:-}" && "${5:-}" == --image-directory && -n "${6:-}" && $# == 6 ]] || { echo 'Usage: export-internal-ci-release-images.sh --source-context <context> --inventory <json> --image-directory <dir>' >&2; exit 64; }
context=$2; inventory=$4; image_dir=$6; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; build_root="$source_root/build"; temporary="$RUNNER_TEMP/lunchlineup-image-export-$CI_RUN_ID"; test "$context" = "$source_root/source-context.json"; test ! -e "$temporary"; mkdir -p "$temporary" "$image_dir"; trap 'rm -rf -- "$temporary"' EXIT
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1]));for(const [name,v] of Object.entries(x.images)) process.stdout.write([name,v.resolvedRef,Buffer.from(JSON.stringify(v.composeServices)).toString("base64")].join("\t")+"\n")' "$inventory" | while IFS=$'\t' read -r name ref services64; do
  [[ "$name" =~ ^[a-z0-9-]+$ ]] || exit 1; archive="$image_dir/$name.tar.gz"; metadata="$image_dir/$name.image.json"; test ! -e "$archive"; test ! -e "$metadata"
  local_id=$(docker image inspect --format '{{.Id}}' "$ref")
  if [[ "$local_id" =~ ^[a-f0-9]{64}$ ]]; then local_id="sha256:$local_id"; fi
  [[ "$local_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
  docker image save --output "$temporary/$name.tar" "$ref"; gzip -n -9 <"$temporary/$name.tar" >"$archive"; rm -f -- "$temporary/$name.tar"
  archive_sha=$(sha256sum "$archive" | awk '{print $1}'); archive_bytes=$(stat -c %s "$archive")
  node - "$metadata" "$name" "$services64" "$ref" "$local_id" "images/$name.tar.gz" "$archive_sha" "$archive_bytes" <<'NODE'
const {writeFileSync}=require('node:fs'); const [output,artifactName,services64,imageRef,localImageId,archiveFile,archiveSha256,bytes]=process.argv.slice(2); const composeServices=JSON.parse(Buffer.from(services64,'base64').toString()); writeFileSync(output,JSON.stringify({artifactName,composeServices,imageRef,localImageId,archiveFile,archiveSha256,archiveBytes:Number(bytes)},null,2)+'\n',{flag:'wx',mode:0o600});
NODE
done
