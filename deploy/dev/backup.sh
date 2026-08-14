#!/bin/sh
set -eu

backup_dir=${AI_LEARNING_BACKUP_DIR:-"$HOME/backups/ai-learning-os"}
docker_bin=${AI_LEARNING_DOCKER_BIN:-docker}
flock_bin=${AI_LEARNING_FLOCK_BIN:-flock}
if command -v sha256sum >/dev/null 2>&1; then
  sha256_command=sha256sum
else
  sha256_command="shasum -a 256"
fi
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
if ! command -v "$flock_bin" >/dev/null 2>&1; then
  echo "flock is required for crash-safe backup locking" >&2
  exit 1
fi
lock_file="$backup_dir/.backup.lock"
exec 9>"$lock_file"
chmod 600 "$lock_file"
if ! "$flock_bin" -n 9; then
  echo "Another database backup is already running" >&2
  exit 1
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp "$backup_dir/.ai-learning-os-$timestamp.XXXXXX")
temporary_checksum="$temporary.sha256"
trap 'rm -f "$temporary" "$temporary_checksum"' EXIT

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
final_checksum="$final_backup.sha256"
backup_name=${final_backup##*/}
checksum=$($sha256_command "$temporary" | awk 'NR == 1 { print $1 }')
case "$checksum" in
  ""|*[!0-9a-f]*) echo "Database backup SHA-256 calculation failed" >&2; exit 1 ;;
esac
if [ "${#checksum}" -ne 64 ]; then
  echo "Database backup SHA-256 calculation failed" >&2
  exit 1
fi
printf '%s  %s\n' "$checksum" "$backup_name" > "$temporary_checksum"
chmod 600 "$temporary_checksum"
mv "$temporary" "$final_backup"
mv "$temporary_checksum" "$final_checksum"

find "$backup_dir" -type f -name 'ai-learning-os-*.dump' -mtime +7 -print \
  | while IFS= read -r stale_backup; do
      rm -f "$stale_backup" "$stale_backup.sha256"
    done
