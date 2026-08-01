#!/bin/sh
set -eu

backup_dir=${AI_LEARNING_BACKUP_DIR:-"$HOME/backups/ai-learning-os"}
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp "$backup_dir/.ai-learning-os-$timestamp.XXXXXX")
trap 'rm -f "$temporary"' EXIT

docker exec pg pg_dump --format=custom --no-owner --no-privileges -U postgres -d ai_learning_os > "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$backup_dir/ai-learning-os-$timestamp.dump"
find "$backup_dir" -type f -name 'ai-learning-os-*.dump' -mtime +7 -delete
