#!/bin/sh
set -eu

# Recovery automation only needs base-system utilities. Constrain PATH before
# deriving script_dir so a user-manager environment cannot replace dirname or
# any later checksum, metadata, retention, or publication helper.
PATH=/usr/bin:/bin
export PATH

backup_dir=${AI_LEARNING_BACKUP_DIR:-"$HOME/backups/ai-learning-os"}
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$script_dir/resolve-docker-bin.sh"
resolve_trusted_docker_bin
flock_bin=${AI_LEARNING_FLOCK_BIN:-flock}
stat_bin=${AI_LEARNING_STAT_BIN:-stat}
bootstrap_stat_bin=/usr/bin/stat
bootstrap_id_bin=/usr/bin/id

read_bootstrap_stat_value() {
  bootstrap_bsd_format=$1
  bootstrap_gnu_format=$2
  bootstrap_target=$3
  bootstrap_value=$($bootstrap_stat_bin -f "$bootstrap_bsd_format" "$bootstrap_target" 2>/dev/null || true)
  case "$bootstrap_value" in ''|*[!0-9]*) bootstrap_value=$($bootstrap_stat_bin -c "$bootstrap_gnu_format" "$bootstrap_target" 2>/dev/null || true) ;; esac
  case "$bootstrap_value" in ''|*[!0-9]*) echo "Could not verify backup helper metadata" >&2; return 2 ;; esac
  printf '%s\n' "$bootstrap_value"
}

is_systemd_mapped_root_backup_helper() {
  helper_file_owner=$1
  helper_dir_owner=$2
  helper_path=$3
  helper_dir=$4
  [ "$helper_file_owner" = 65534 ] \
    && [ "$helper_dir_owner" = 65534 ] \
    && [ -n "${INVOCATION_ID:-}" ] \
    && [ "$helper_dir" = /usr/bin ] \
    && { [ "$helper_path" = /usr/bin/flock ] || [ "$helper_path" = /usr/bin/stat ]; }
}

resolve_trusted_backup_helper() {
  helper_candidate=$1
  helper_label=$2
  helper_require_root=false
  case "$helper_candidate" in
    /*) helper_resolved=$helper_candidate ;;
    */*) echo "$helper_label executable path must be absolute" >&2; return 2 ;;
    *)
      helper_require_root=true
      helper_resolved=$(command -v "$helper_candidate" 2>/dev/null || true)
      case "$helper_resolved" in
        /*) ;;
        *) echo "Could not resolve $helper_label executable to an absolute path" >&2; return 2 ;;
      esac
      ;;
  esac
  helper_directory=${helper_resolved%/*}
  if [ -L "$helper_directory" ] || [ ! -d "$helper_directory" ]; then
    echo "$helper_label executable directory must be a real directory, not a symlink" >&2
    return 2
  fi
  if [ -L "$helper_resolved" ] || [ ! -f "$helper_resolved" ] || [ ! -x "$helper_resolved" ]; then
    echo "$helper_label executable is missing or unsafe" >&2
    return 2
  fi
  helper_owner=$(read_bootstrap_stat_value '%u' '%u' "$helper_resolved") || return 2
  helper_directory_owner=$(read_bootstrap_stat_value '%u' '%u' "$helper_directory") || return 2
  current_uid=$($bootstrap_id_bin -u)
  if ! is_systemd_mapped_root_backup_helper "$helper_owner" "$helper_directory_owner" "$helper_resolved" "$helper_directory"; then
    if [ "$helper_require_root" = true ]; then
      [ "$helper_owner" = 0 ] && [ "$helper_directory_owner" = 0 ] || {
        echo "$helper_label resolved from PATH must be owned by root" >&2
        return 2
      }
    else
      case "$helper_owner" in 0|"$current_uid") ;; *) echo "$helper_label executable must be owned by root or the current user" >&2; return 2 ;; esac
      case "$helper_directory_owner" in 0|"$current_uid") ;; *) echo "$helper_label executable directory must be owned by root or the current user" >&2; return 2 ;; esac
    fi
  fi
  helper_mode=$(read_bootstrap_stat_value '%Lp' '%a' "$helper_resolved") || return 2
  helper_directory_mode=$(read_bootstrap_stat_value '%Lp' '%a' "$helper_directory") || return 2
  if [ $((0$helper_mode & 022)) -ne 0 ]; then
    echo "$helper_label executable must not be group or other writable" >&2
    return 2
  fi
  if [ $((0$helper_directory_mode & 022)) -ne 0 ]; then
    echo "$helper_label executable directory must not be group or other writable" >&2
    return 2
  fi
  helper_links=$(read_bootstrap_stat_value '%l' '%h' "$helper_resolved") || return 2
  if [ "$helper_links" != 1 ] \
    && [ "$helper_owner" != 0 ] \
    && ! is_systemd_mapped_root_backup_helper "$helper_owner" "$helper_directory_owner" "$helper_resolved" "$helper_directory"; then
      echo "$helper_label executable must not be hard-linked unless it is a root-managed system tool" >&2
      return 2
  fi
  printf '%s\n' "$helper_resolved"
}

for bootstrap_helper in "$bootstrap_stat_bin" "$bootstrap_id_bin"; do
  if [ -L "$bootstrap_helper" ] || [ ! -f "$bootstrap_helper" ] || [ ! -x "$bootstrap_helper" ]; then
    echo "Required trusted backup bootstrap helper is unavailable" >&2
    exit 2
  fi
done
flock_bin=$(resolve_trusted_backup_helper "$flock_bin" "flock")
stat_bin=$(resolve_trusted_backup_helper "$stat_bin" "stat")
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
backup_dir_owner=$($stat_bin -f '%u' "$backup_dir" 2>/dev/null || true)
case "$backup_dir_owner" in
  ''|*[!0-9]*) backup_dir_owner=$($stat_bin -c '%u' "$backup_dir" 2>/dev/null || true) ;;
esac
case "$backup_dir_owner" in
  ''|*[!0-9]*) echo "Could not verify backup directory ownership" >&2; exit 1 ;;
esac
if [ "$backup_dir_owner" != "$(id -u)" ]; then
  echo "Backup directory must be owned by the current user" >&2
  exit 1
fi
chmod 700 "$backup_dir"
lock_file="$backup_dir/.backup.lock"
read_file_owner() {
  file_owner=$($stat_bin -f '%u' "$1" 2>/dev/null || true)
  case "$file_owner" in
    ''|*[!0-9]*) file_owner=$($stat_bin -c '%u' "$1" 2>/dev/null || true) ;;
  esac
  printf '%s\n' "$file_owner"
}

read_file_links() {
  file_links=$($stat_bin -f '%l' "$1" 2>/dev/null || true)
  case "$file_links" in
    ''|*[!0-9]*) file_links=$($stat_bin -c '%h' "$1" 2>/dev/null || true) ;;
  esac
  printf '%s\n' "$file_links"
}

validate_owned_regular_file() {
  file_path=$1
  file_label=$2
  if [ -L "$file_path" ] || [ ! -f "$file_path" ]; then
    echo "$file_label must be a regular file, not a symlink" >&2
    return 1
  fi
  if [ "$(read_file_owner "$file_path")" != "$(id -u)" ]; then
    echo "$file_label must be owned by the current user" >&2
    return 1
  fi
  file_links=$(read_file_links "$file_path")
  case "$file_links" in
    ''|*[!0-9]*) echo "Could not verify $file_label link count" >&2; return 1 ;;
  esac
  if [ "$file_links" != 1 ]; then
    echo "$file_label must not be hard-linked" >&2
    return 1
  fi
}

if [ -e "$lock_file" ] || [ -L "$lock_file" ]; then
  validate_owned_regular_file "$lock_file" "Backup lock" || exit 1
fi
exec 9>>"$lock_file"
validate_owned_regular_file "$lock_file" "Backup lock" || exit 1
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
  [ "$(read_file_owner "$candidate")" = "$(id -u)" ] || return 1
  [ "$(read_file_links "$candidate")" = 1 ] || return 1
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
