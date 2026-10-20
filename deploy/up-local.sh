#!/usr/bin/env bash
# Rehearses the VPS first-boot runbook on this machine: the same compose file, the same order.
#   deploy/up-local.sh [--web]
# Safe to run again: it reuses the env file, the volumes and the OpenFGA store.
set -euo pipefail

cd "$(dirname "$0")/.."

WITH_WEB=false
for arg in "$@"; do
	case "$arg" in
		--web) WITH_WEB=true ;;
		*) echo "usage: $0 [--web]" >&2; exit 2 ;;
	esac
done

ENV_FILE=deploy/.env.local
# Relative to the compose file, which is where compose resolves env_file from.
export API_ENV_FILE=.env.local
export API_IMAGE=akashic-api:local
export WEB_IMAGE=akashic-web:local

dc() {
	docker compose -p akashic-prod --profile local --env-file "$ENV_FILE" -f deploy/compose.prod.yaml "$@"
}

get_var() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }
set_var() { sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; }

echo "== 1. env file"
if [ -f "$ENV_FILE" ]; then
	echo "reusing $ENV_FILE"
else
	cp deploy/env.local.example "$ENV_FILE"
	chmod 600 "$ENV_FILE"
	for token in POSTGRES_PASSWORD OPENFGA_DB_PASSWORD RABBITMQ_PASSWORD BACKUP_S3_SECRET_ACCESS_KEY BETTER_AUTH_SECRET; do
		sed -i "s|__${token}__|$(openssl rand -hex 32)|g" "$ENV_FILE"
	done
	echo "wrote $ENV_FILE with generated secrets"
fi

# mc reads its login from MC_HOST_<alias>, a URL with the credentials in it. It is assembled here,
# into the ignored env file, so no committed file holds a URL like that. Older env files get it too.
mc_host() { printf 'http://%s:%s@%s:9000' "$(get_var BACKUP_S3_ACCESS_KEY_ID)" "$(get_var BACKUP_S3_SECRET_ACCESS_KEY)" "$1"; }
for entry in MC_HOST_LOCAL_HEALTH:localhost MC_HOST_LOCAL_INIT:minio; do
	if [ -z "$(get_var "${entry%%:*}")" ]; then
		printf '%s=%s\n' "${entry%%:*}" "$(mc_host "${entry##*:}")" >> "$ENV_FILE"
	fi
done

echo "== 2. build"
docker build -f apps/api/Dockerfile -t "$API_IMAGE" .
if $WITH_WEB; then
	dc --profile web build web
fi

echo "== 3. data services"
# minio stands in for the S3 the backups go to; the `local` profile is always on. Its bucket is
# made by a one-shot run, since `up --wait` treats a service that exits as a failure.
dc up -d --wait postgres openfga-db openfga redis rabbitmq minio
dc run --rm -T minio-init
# On the VPS a plain `up -d` runs this one-shot; naming services here skips it.
dc run --rm -T rabbitmq-policy

echo "== 4. migrate"
dc run --rm --no-deps -T api bun apps/api/scripts/migrate.ts

echo "== 5. authz push"
# The API will not start without FGA_STORE_ID, so this comes before it. A second run finds the
# ids in the env file and pushes nothing: the store is reused either way, and a model pushed
# again would only add an unused version.
if [ -n "$(get_var FGA_STORE_ID)" ] && [ -n "$(get_var FGA_MODEL_ID)" ]; then
	echo "FGA ids already set; skipping the push"
else
	pushed=$(dc run --rm --no-deps -T api bun apps/api/scripts/authz-push.ts)
	echo "$pushed"
	store=$(printf '%s\n' "$pushed" | sed -n 's/^FGA_STORE_ID=//p' | tr -d '\r')
	model=$(printf '%s\n' "$pushed" | sed -n 's/^FGA_MODEL_ID=//p' | tr -d '\r')
	if [ -z "$store" ] || [ -z "$model" ]; then
		echo "authz push printed no ids" >&2
		exit 1
	fi
	set_var FGA_STORE_ID "$store"
	set_var FGA_MODEL_ID "$model"
fi

echo "== 6. api and caddy"
if $WITH_WEB; then
	dc --profile web up -d --wait api caddy backup web
else
	dc up -d --wait api caddy backup
fi

echo "== 7. readyz"
for _ in $(seq 1 60); do
	if curl -sf http://localhost:8300/readyz >/dev/null; then
		echo "ready: http://localhost:8300/readyz"
		$WITH_WEB && echo "web:   http://localhost:8301"
		exit 0
	fi
	sleep 2
done
echo "http://localhost:8300/readyz never answered 200" >&2
dc logs --tail 40 api caddy >&2
exit 1
