#!/bin/sh
set -eu

backup_dir=${AI_LEARNING_BACKUP_DIR:-"$HOME/backups/ai-learning-os"}
docker_bin=${AI_LEARNING_DOCKER_BIN:-docker}
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp "$backup_dir/.ai-learning-os-$timestamp.XXXXXX")
trap 'rm -f "$temporary"' EXIT

"$docker_bin" exec pg pg_dump --format=custom --no-owner --no-privileges -U postgres -d ai_learning_os > "$temporary"
if [ ! -s "$temporary" ]; then
  echo "Database backup is empty" >&2
  exit 1
fi
if ! "$docker_bin" exec -i pg pg_restore --list < "$temporary" >/dev/null; then
  echo "Database backup failed PostgreSQL archive verification" >&2
  exit 1
fi

chmod 600 "$temporary"
suffix=${temporary##*.}
final_backup="$backup_dir/ai-learning-os-$timestamp-$suffix.dump"
mv "$temporary" "$final_backup"
find "$backup_dir" -type f -name 'ai-learning-os-*.dump' -mtime +7 -delete
