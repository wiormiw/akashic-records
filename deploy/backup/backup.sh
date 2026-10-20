#!/bin/sh
# One backup: dump both databases, check the dumps, upload, then prune what is older than
# BACKUP_KEEP_DAYS. The pair shares one timestamp, so restore takes it as a unit:
#   s3://$BACKUP_BUCKET/postgres/<stamp>.dump   the app database (PG* variables)
#   s3://$BACKUP_BUCKET/openfga/<stamp>.dump    OpenFGA's database (OPENFGA_PG* variables)
#   /backup/backup.sh
# Storage comes from BACKUP_*; see compose.prod.yaml.
set -eu

: "${BACKUP_BUCKET:?}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_S3_ACCESS_KEY_ID:?}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?}"
: "${OPENFGA_PGHOST:?}" "${OPENFGA_PGUSER:?}" "${OPENFGA_PGPASSWORD:?}" "${OPENFGA_PGDATABASE:?}"
keep_days=${BACKUP_KEEP_DAYS:-14}
case "$keep_days" in
	'' | *[!0-9]*) echo "BACKUP_KEEP_DAYS must be a whole number of days" >&2; exit 2 ;;
esac
# Zero would delete the backup this run just made.
[ "$keep_days" -ge 1 ] || { echo "BACKUP_KEEP_DAYS must be at least 1" >&2; exit 2; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
app_file="/tmp/app-$stamp.dump"
fga_file="/tmp/openfga-$stamp.dump"
trap 'rm -f "$app_file" "$fga_file"' EXIT

echo "dumping $PGDATABASE@$PGHOST"
# Custom format: compressed, and pg_restore can pick tables out of it.
pg_dump -Fc -f "$app_file"
echo "dumping $OPENFGA_PGDATABASE@$OPENFGA_PGHOST"
PGHOST=$OPENFGA_PGHOST PGUSER=$OPENFGA_PGUSER PGPASSWORD=$OPENFGA_PGPASSWORD \
	PGDATABASE=$OPENFGA_PGDATABASE pg_dump -Fc -f "$fga_file"
# A dump pg_restore cannot read is worse than none, because it looks like a backup.
pg_restore -l "$app_file" >/dev/null
pg_restore -l "$fga_file" >/dev/null

mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
	"$BACKUP_S3_SECRET_ACCESS_KEY" >/dev/null
mc cp --quiet "$app_file" "backup/$BACKUP_BUCKET/postgres/$stamp.dump"
mc cp --quiet "$fga_file" "backup/$BACKUP_BUCKET/openfga/$stamp.dump"
echo "uploaded s3://$BACKUP_BUCKET/{postgres,openfga}/$stamp.dump"

# After the uploads, so a failed run never leaves fewer backups than it found.
mc rm --recursive --force --older-than "${keep_days}d" "backup/$BACKUP_BUCKET/postgres/"
mc rm --recursive --force --older-than "${keep_days}d" "backup/$BACKUP_BUCKET/openfga/"
echo "pruned objects older than $keep_days days"

# A dead-man's switch (healthchecks.io style): silence, not an error, is what raises the alarm.
# Fail-soft, because a monitoring outage must not fail a backup that succeeded.
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
	wget -q -T 10 -O /dev/null "$BACKUP_HEARTBEAT_URL" || echo "heartbeat ping failed (ignored)" >&2
fi
