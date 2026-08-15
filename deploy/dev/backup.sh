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

case "$backup_dir" in
  /*) ;;
  *) echo "Backup directory path must be absolute" >&2; exit 1 ;;
esac
if [ -L "$backup_dir" ]; then
  echo "Backup directory must be a real directory, not a symlink" >&2
  exit 1
fi
mkdir -p "$backup_dir"
if [ -L "$backup_dir" ] || [ ! -d "$backup_dir" ]; then
  echo "Backup directory must be a real directory, not a symlink" >&2
  exit 1
fi
backup_dir_owner=$(stat -f '%u' "$backup_dir" 2>/dev/null || true)
case "$backup_dir_owner" in
  ''|*[!0-9]*) backup_dir_owner=$(stat -c '%u' "$backup_dir" 2>/dev/null || true) ;;
esac
case "$backup_dir_owner" in
  ''|*[!0-9]*) echo "Could not verify backup directory ownership" >&2; exit 1 ;;
esac
if [ "$backup_dir_owner" != "$(id -u)" ]; then
  echo "Backup directory must be owned by the current user" >&2
  exit 1
fi
chmod 700 "$backup_dir"
if ! command -v "$flock_bin" >/dev/null 2>&1; then
  echo "flock is required for crash-safe backup locking" >&2
  exit 1
fi
lock_file="$backup_dir/.backup.lock"
if [ -L "$lock_file" ]; then
  echo "Backup lock must be a regular file, not a symlink" >&2
  exit 1
fi
exec 9>"$lock_file"
chmod 600 "$lock_file"
if ! "$flock_bin" -n 9; then
  echo "Another database backup is already running" >&2
  exit 1
fi

is_stale_regular_file() {
  candidate=$1
  age_days=$2
  [ ! -L "$candidate" ] || return 1
  [ -f "$candidate" ] || return 1
  [ "$(find "$candidate" -prune -mtime "+$age_days" -print)" = "$candidate" ]
}

# Converge after uncatchable termination without traversing below the managed
# directory. A valid archive pair keeps the longer retention period; partial
# publication artifacts are safe to reclaim sooner.
for abandoned in "$backup_dir"/.ai-learning-os-*; do
  if is_stale_regular_file "$abandoned" 1; then
    rm -f "$abandoned"
  fi
done
for stale_backup in "$backup_dir"/ai-learning-os-*.dump; do
  if is_stale_regular_file "$stale_backup" 7; then
    rm -f "$stale_backup" "$stale_backup.sha256"
  fi
done
for orphan_checksum in "$backup_dir"/ai-learning-os-*.dump.sha256; do
  matching_backup=${orphan_checksum%.sha256}
  if [ ! -e "$matching_backup" ] && is_stale_regular_file "$orphan_checksum" 7; then
    rm -f "$orphan_checksum"
  fi
done

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
