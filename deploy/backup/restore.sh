#!/bin/sh
# Restores one backup into the database named by PGDATABASE, replacing what is in it.
#   /backup/restore.sh postgres/20261017T190000Z.dump
# Run it with the API stopped: pg_restore --clean cannot drop tables that are in use. The
# database must exist (an empty one is fine); see the backup service in compose.prod.yaml.
set -eu

[ $# -eq 1 ] || { echo "usage: $0 <object-key>   e.g. postgres/20261017T190000Z.dump" >&2; exit 2; }
key=$1
: "${BACKUP_BUCKET:?}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_S3_ACCESS_KEY_ID:?}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?}"

file=$(mktemp /tmp/restore.XXXXXX)
trap 'rm -f "$file"' EXIT

mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
	"$BACKUP_S3_SECRET_ACCESS_KEY" >/dev/null
mc cp --quiet "backup/$BACKUP_BUCKET/$key" "$file"

echo "restoring s3://$BACKUP_BUCKET/$key into $PGDATABASE@$PGHOST"
# --no-owner: the dump's owner is the role that made it; here the connecting role owns it all.
# --single-transaction: a failed restore leaves the database as it was, not half replaced.
pg_restore --clean --if-exists --no-owner --single-transaction -d "$PGDATABASE" "$file"
echo "restored"
