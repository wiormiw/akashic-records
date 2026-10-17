#!/bin/sh
# One backup: dump, check the dump, upload, then prune what is older than BACKUP_KEEP_DAYS.
#   /backup/backup.sh
# Connection comes from the PG* variables, storage from BACKUP_*; see compose.prod.yaml.
set -eu

: "${BACKUP_BUCKET:?}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_S3_ACCESS_KEY_ID:?}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?}"
keep_days=${BACKUP_KEEP_DAYS:-14}
case "$keep_days" in
	'' | *[!0-9]*) echo "BACKUP_KEEP_DAYS must be a whole number of days" >&2; exit 2 ;;
esac
# Zero would delete the backup this run just made.
[ "$keep_days" -ge 1 ] || { echo "BACKUP_KEEP_DAYS must be at least 1" >&2; exit 2; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
key="postgres/$stamp.dump"
file="/tmp/$stamp.dump"
trap 'rm -f "$file"' EXIT

echo "dumping $PGDATABASE@$PGHOST"
# Custom format: compressed, and pg_restore can pick tables out of it.
pg_dump -Fc -f "$file"
# A dump pg_restore cannot read is worse than none, because it looks like a backup.
pg_restore -l "$file" >/dev/null

mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
	"$BACKUP_S3_SECRET_ACCESS_KEY" >/dev/null
mc cp --quiet "$file" "backup/$BACKUP_BUCKET/$key"
echo "uploaded s3://$BACKUP_BUCKET/$key"

# After the upload, so a failed run never leaves fewer backups than it found.
mc rm --recursive --force --older-than "${keep_days}d" "backup/$BACKUP_BUCKET/postgres/"
echo "pruned objects older than $keep_days days"
