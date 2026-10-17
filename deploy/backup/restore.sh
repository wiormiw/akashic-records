#!/bin/sh
# Restores one backup into the database named by PGDATABASE, replacing what is in it.
#   /backup/restore.sh postgres/20261017T190000Z.dump
# Refuses while anything else is connected: pg_restore --clean cannot drop tables in use. The
# database must exist (an empty one is fine); see the backup service in compose.prod.yaml.
set -eu

[ $# -eq 1 ] || { echo "usage: $0 <object-key>   e.g. postgres/20261017T190000Z.dump" >&2; exit 2; }
key=$1
: "${BACKUP_BUCKET:?}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_S3_ACCESS_KEY_ID:?}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?}"

# Enforced, not just documented: a restore under a live API hangs on locks or half-applies. No
# override on purpose; stop the API. (The check sees only sessions this role may see.)
others=$(psql -d "$PGDATABASE" -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()")
if [ "$others" -gt 0 ]; then
	echo "refusing: $others other session(s) are connected to $PGDATABASE." >&2
	echo "Stop the API first (docker compose stop api), then run this again." >&2
	exit 1
fi

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
