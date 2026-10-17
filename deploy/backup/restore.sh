#!/bin/sh
# Restores one backup pair, the app database and OpenFGA's, from one timestamp:
#   /backup/restore.sh 20261017T190000Z
# Each target database is dropped and recreated first, because pg_restore --clean only drops
# what the dump holds: restoring over a newer schema leaves its extra tables and a rolled-back
# migrations table behind, and the next migrate fails with "already exists". So run migrate
# after this (the API image does that; this one has no bun), then start the API.
# Refuses while any client is connected, so stop the API and OpenFGA first.
set -eu

[ $# -eq 1 ] || { echo "usage: $0 <timestamp>   e.g. 20261017T190000Z" >&2; exit 2; }
stamp=$1
case "$stamp" in
	*[!0-9TZ]* | '') echo "timestamp looks like 20261017T190000Z, not a key" >&2; exit 2 ;;
esac
: "${BACKUP_BUCKET:?}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_S3_ACCESS_KEY_ID:?}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?}"
: "${OPENFGA_PGHOST:?}" "${OPENFGA_PGUSER:?}" "${OPENFGA_PGPASSWORD:?}" "${OPENFGA_PGDATABASE:?}"

# Enforced, not just documented: dropping a database under a live API or OpenFGA fails or
# breaks them. No override on purpose. Only client backends count, so autovacuum doesn't cause
# a spurious refusal. (The check sees only sessions this role may see.)
# $1 host, $2 user, $3 password, $4 database.
sessions() {
	PGHOST=$1 PGUSER=$2 PGPASSWORD=$3 psql -d postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname = '$4' AND backend_type = 'client backend' AND pid <> pg_backend_pid()"
}
refuse_if_busy() {
	n=$(sessions "$1" "$2" "$3" "$4")
	if [ "$n" -gt 0 ]; then
		echo "refusing: $n client session(s) are connected to $4." >&2
		echo "Stop the API and OpenFGA first (docker compose stop api openfga), then run this again." >&2
		exit 1
	fi
}
refuse_if_busy "$PGHOST" "$PGUSER" "$PGPASSWORD" "$PGDATABASE"
refuse_if_busy "$OPENFGA_PGHOST" "$OPENFGA_PGUSER" "$OPENFGA_PGPASSWORD" "$OPENFGA_PGDATABASE"

app_file=$(mktemp /tmp/restore-app.XXXXXX)
fga_file=$(mktemp /tmp/restore-openfga.XXXXXX)
trap 'rm -f "$app_file" "$fga_file"' EXIT

# Both dumps are fetched and read before anything is dropped, so a missing or damaged half
# can't leave a database dropped with nothing to restore.
mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
	"$BACKUP_S3_SECRET_ACCESS_KEY" >/dev/null
mc cp --quiet "backup/$BACKUP_BUCKET/postgres/$stamp.dump" "$app_file"
mc cp --quiet "backup/$BACKUP_BUCKET/openfga/$stamp.dump" "$fga_file"
pg_restore -l "$app_file" >/dev/null
pg_restore -l "$fga_file" >/dev/null

# $1 host, $2 user, $3 password, $4 database, $5 dump file.
recreate() {
	echo "restoring $stamp into $4@$1 (dropping it first)"
	export PGHOST=$1 PGUSER=$2 PGPASSWORD=$3
	# FORCE only to shrug off a healthcheck that connected since the guard looked; the guard
	# already refused for anything real.
	dropdb --force --if-exists "$4"
	createdb "$4"
	# --no-owner: the dump's owner is the role that made it; here the connecting role owns it all.
	# --single-transaction: a failed restore leaves the new database empty, not half filled.
	pg_restore --no-owner --single-transaction -d "$4" "$5"
}
( recreate "$PGHOST" "$PGUSER" "$PGPASSWORD" "$PGDATABASE" "$app_file" )
( recreate "$OPENFGA_PGHOST" "$OPENFGA_PGUSER" "$OPENFGA_PGPASSWORD" "$OPENFGA_PGDATABASE" "$fga_file" )
echo "restored. Now run migrate, then start the API."
