#!/bin/sh
# Local drill only. Runs inside the backup image against the drill MinIO with
# the MinIO root credential, which never leaves this step: it creates the two
# Object-Locked buckets, least-privilege identities, and writes only the scoped
# credentials into /secrets using the same layout production mounts.
set -eu

: "${DRILL_ENDPOINT:?}" "${DRILL_STS_ENDPOINT:?}" "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}"
BACKUP_BUCKET="${DRILL_BACKUP_BUCKET:-ll-drill-backups}"
BACKUP_PREFIX="${DRILL_BACKUP_PREFIX:-drill/db-backups}"
PITR_BUCKET="${DRILL_PITR_BUCKET:-ll-drill-pitr}"
PITR_PREFIX="${DRILL_PITR_PREFIX:-cluster-drill}"
BACKUP_RETENTION_DAYS="${DRILL_BACKUP_RETENTION_DAYS:-35}"
PITR_RETENTION_DAYS="${DRILL_PITR_RETENTION_DAYS:-14}"
PITR_LIFECYCLE_DAYS="${DRILL_PITR_LIFECYCLE_DAYS:-30}"
SECRETS=/secrets
MC=/opt/lunchlineup/tools/mc
export MC_CONFIG_DIR=/tmp/ll-drill-mc

AWS_ACCESS_KEY_ID="${MINIO_ROOT_USER}"
AWS_SECRET_ACCESS_KEY="${MINIO_ROOT_PASSWORD}"
AWS_DEFAULT_REGION=us-east-1
AWS_ENDPOINT_URL_S3="${DRILL_ENDPOINT}"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION AWS_ENDPOINT_URL_S3

rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

"${MC}" alias set root "${DRILL_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null

make_bucket() {
  bucket="$1"; days="$2"
  aws s3api create-bucket --bucket "${bucket}" --object-lock-enabled-for-bucket >/dev/null
  aws s3api put-bucket-versioning --bucket "${bucket}" --versioning-configuration Status=Enabled
  aws s3api put-object-lock-configuration --bucket "${bucket}" \
    --object-lock-configuration "{\"ObjectLockEnabled\":\"Enabled\",\"Rule\":{\"DefaultRetention\":{\"Mode\":\"COMPLIANCE\",\"Days\":${days}}}}"
}

# Logical-backup bucket: versioned, default COMPLIANCE lock, exact-prefix
# lifecycle (current + noncurrent) and an unconditional delete-deny policy.
make_bucket "${BACKUP_BUCKET}" "${BACKUP_RETENTION_DAYS}"
aws s3api put-bucket-lifecycle-configuration --bucket "${BACKUP_BUCKET}" --lifecycle-configuration \
  "{\"Rules\":[{\"ID\":\"expire-db-backups\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"${BACKUP_PREFIX}/\"},\"Expiration\":{\"Days\":${BACKUP_RETENTION_DAYS}},\"NoncurrentVersionExpiration\":{\"NoncurrentDays\":${BACKUP_RETENTION_DAYS}}}]}"
aws s3api put-bucket-policy --bucket "${BACKUP_BUCKET}" --policy \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DenyDelete\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":[\"s3:DeleteObject\",\"s3:DeleteObjectVersion\"],\"Resource\":[\"arn:aws:s3:::${BACKUP_BUCKET}/${BACKUP_PREFIX}/*\"]}]}"

# PITR bucket: versioned, default COMPLIANCE lock, lifecycle on the cluster prefix.
make_bucket "${PITR_BUCKET}" "${PITR_RETENTION_DAYS}"
aws s3api put-bucket-lifecycle-configuration --bucket "${PITR_BUCKET}" --lifecycle-configuration \
  "{\"Rules\":[{\"ID\":\"expire-pitr\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"${PITR_PREFIX}/\"},\"Expiration\":{\"Days\":${PITR_LIFECYCLE_DAYS}},\"NoncurrentVersionExpiration\":{\"NoncurrentDays\":1}},{\"ID\":\"expire-pitr-delete-markers\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"${PITR_PREFIX}/\"},\"Expiration\":{\"ExpiredObjectDeleteMarker\":true}}]}"

write_policy() {
  name="$1"; bucket="$2"; write="$3"; config="$4"
  actions='"s3:GetObject","s3:GetObjectVersion","s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetBucketVersioning","s3:GetBucketObjectLockConfiguration","s3:GetObjectRetention"'
  [ "${write}" = true ] && actions="${actions},\"s3:PutObject\",\"s3:PutObjectRetention\""
  [ "${config}" = true ] && actions="${actions},\"s3:GetLifecycleConfiguration\",\"s3:GetBucketPolicy\""
  cat >"/tmp/${name}.json" <<POLICY
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":[${actions}],"Resource":["arn:aws:s3:::${bucket}","arn:aws:s3:::${bucket}/*"]},
 {"Effect":"Deny","Action":["s3:DeleteObject","s3:DeleteObjectVersion","s3:BypassGovernanceRetention","s3:PutLifecycleConfiguration","s3:PutBucketPolicy","s3:DeleteBucket"],"Resource":["arn:aws:s3:::${bucket}","arn:aws:s3:::${bucket}/*"]}]}
POLICY
  "${MC}" admin policy create root "${name}" "/tmp/${name}.json" >/dev/null
}

make_identity() {
  # make_identity <name> <policy> <access-var-file-dir>
  user="$1"; policy="$2"; dir="$3"
  access="drill${user}$(rand 6)"; secret="$(rand 32)"
  "${MC}" admin user add root "${access}" "${secret}" >/dev/null
  "${MC}" admin policy attach root "${policy}" --user "${access}" >/dev/null
  mkdir -p "${SECRETS}/${dir}"
  printf '%s' "${access}" >"${SECRETS}/${dir}/access_key"
  printf '%s' "${secret}" >"${SECRETS}/${dir}/secret_key"
  chmod 0755 "${SECRETS}/${dir}"; chmod 0644 "${SECRETS}/${dir}/access_key" "${SECRETS}/${dir}/secret_key"
}

write_policy ll-drill-backup-writer "${BACKUP_BUCKET}" true true
write_policy ll-drill-pitr-writer "${PITR_BUCKET}" true false
write_policy ll-drill-pitr-restore "${PITR_BUCKET}" false false
write_policy ll-drill-backup-restore "${BACKUP_BUCKET}" false false
cat >/tmp/ll-drill-pitr-lifecycle-audit.json <<POLICY
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:GetLifecycleConfiguration","s3:GetBucketVersioning","s3:GetBucketObjectLockConfiguration","s3:ListBucket"],"Resource":["arn:aws:s3:::${PITR_BUCKET}"]}]}
POLICY
"${MC}" admin policy create root ll-drill-pitr-lifecycle-audit /tmp/ll-drill-pitr-lifecycle-audit.json >/dev/null

# Logical backup writer -> aws-credentials/aws-config (the Compose backup mount).
access="drillbackup$(rand 6)"; secret="$(rand 32)"
"${MC}" admin user add root "${access}" "${secret}" >/dev/null
"${MC}" admin policy attach root ll-drill-backup-writer --user "${access}" >/dev/null
mkdir -p "${SECRETS}/backup-offsite"
printf '[default]\naws_access_key_id=%s\naws_secret_access_key=%s\n' "${access}" "${secret}" >"${SECRETS}/backup-offsite/aws-credentials"
printf '[default]\nregion = us-east-1\nservices = drill-endpoints\n\n[services drill-endpoints]\ns3 =\n  endpoint_url = %s\n  addressing_style = path\nsts =\n  endpoint_url = %s\n' \
  "${DRILL_ENDPOINT}" "${DRILL_STS_ENDPOINT}" >"${SECRETS}/backup-offsite/aws-config"

# Read-only identity used to fetch the offsite copy for the restore drill.
access="drillfetch$(rand 6)"; secret="$(rand 32)"
"${MC}" admin user add root "${access}" "${secret}" >/dev/null
"${MC}" admin policy attach root ll-drill-backup-restore --user "${access}" >/dev/null
mkdir -p "${SECRETS}/backup-offsite-restore"
printf '[default]\naws_access_key_id=%s\naws_secret_access_key=%s\n' "${access}" "${secret}" >"${SECRETS}/backup-offsite-restore/aws-credentials"
printf '[default]\nregion = us-east-1\nservices = drill-endpoints\n\n[services drill-endpoints]\ns3 =\n  endpoint_url = %s\n  addressing_style = path\n' \
  "${DRILL_ENDPOINT}" >"${SECRETS}/backup-offsite-restore/aws-config"

make_identity wal ll-drill-pitr-writer pitr-wal-object-store
make_identity basebackup ll-drill-pitr-writer pitr-base-backup-object-store
make_identity restore ll-drill-pitr-restore pitr-restore-object-store
make_identity lifecycle ll-drill-pitr-lifecycle-audit pitr-lifecycle-audit-object-store

chmod -R a+rX "${SECRETS}/backup-offsite" "${SECRETS}/backup-offsite-restore"
[ -s "${SECRETS}/backup_key" ] || { printf '%s' "$(rand 48)" >"${SECRETS}/backup_key"; chmod 0644 "${SECRETS}/backup_key"; }
echo "drill_object_store_ready backup=s3://${BACKUP_BUCKET}/${BACKUP_PREFIX}/ pitr=s3://${PITR_BUCKET}/${PITR_PREFIX}/"
