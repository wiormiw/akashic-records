#!/bin/sh
# Starts the nightly schedule: 02:00 in TZ (Asia/Jakarta), when nobody is on the site.
# With arguments it runs them instead, so `compose run backup /backup/backup.sh` works.
set -eu

[ $# -eq 0 ] || exec "$@"

# crond hands its jobs an empty environment, so save ours for the job to source. Mode 600
# because it holds the database and storage secrets.
umask 077
export -p > /run/backup.env

# The output goes to PID 1's stdout, which is what `docker logs` shows.
echo '0 2 * * * . /run/backup.env && /backup/backup.sh >/proc/1/fd/1 2>&1' > /etc/crontabs/root
echo "backup schedule: 02:00 $TZ"
exec crond -f -l 8
