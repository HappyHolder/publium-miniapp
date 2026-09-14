#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/publium/deploy
backup=/opt/publium-backups/pre-audit-20260914
mkdir -p "$backup"
test ! -e "$backup/database.dump"
docker tag publium-api publium-api:pre-audit-20260914
docker tag publium-web publium-web:pre-audit-20260914
cp Caddyfile "$backup/Caddyfile"
cp docker-compose.yml "$backup/docker-compose.yml"
git rev-parse HEAD > "$backup/revision.txt"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' < /dev/null > "$backup/database.dump"
test -s "$backup/database.dump"
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" publium_audit_restore_20260914' < /dev/null
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d publium_audit_restore_20260914 --no-owner --exit-on-error' < "$backup/database.dump"
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" publium_audit_clean_20260914' < /dev/null
printf 'Database backup and isolated restore verified. Backup bytes: '
stat -c %s "$backup/database.dump"
