#!/bin/sh
set -eu

backup_dir=${AI_LEARNING_BACKUP_DIR:-"$HOME/backups/ai-learning-os"}
maximum_age_seconds=${AI_LEARNING_BACKUP_MAX_AGE_SECONDS:-108000}
systemctl_bin=${AI_LEARNING_SYSTEMCTL_BIN:-systemctl}
stat_bin=${AI_LEARNING_STAT_BIN:-stat}

case "$backup_dir" in
  /*) ;;
  *) echo "Backup directory path must be absolute" >&2; exit 2 ;;
esac
case "$maximum_age_seconds" in
  ''|*[!0-9]*|0) echo "AI_LEARNING_BACKUP_MAX_AGE_SECONDS must be a positive integer" >&2; exit 2 ;;
esac
if [ "$maximum_age_seconds" -gt 604800 ]; then
  echo "AI_LEARNING_BACKUP_MAX_AGE_SECONDS must not exceed 604800" >&2
  exit 2
fi
if [ -L "$backup_dir" ] || [ ! -d "$backup_dir" ]; then
  echo "Backup directory must be a real directory, not a symlink" >&2
  exit 1
fi

owner_of() {
  owner=$($stat_bin -f '%u' "$1" 2>/dev/null || true)
  case "$owner" in ''|*[!0-9]*) owner=$($stat_bin -c '%u' "$1" 2>/dev/null || true) ;; esac
  printf '%s\n' "$owner"
}

mode_of() {
  mode=$($stat_bin -f '%Lp' "$1" 2>/dev/null || true)
  case "$mode" in ''|*[!0-7]*) mode=$($stat_bin -c '%a' "$1" 2>/dev/null || true) ;; esac
  printf '%s\n' "$mode"
}

links_of() {
  links=$($stat_bin -f '%l' "$1" 2>/dev/null || true)
  case "$links" in ''|*[!0-9]*) links=$($stat_bin -c '%h' "$1" 2>/dev/null || true) ;; esac
  printf '%s\n' "$links"
}

mtime_of() {
  modified=$($stat_bin -f '%m' "$1" 2>/dev/null || true)
  case "$modified" in ''|*[!0-9]*) modified=$($stat_bin -c '%Y' "$1" 2>/dev/null || true) ;; esac
  printf '%s\n' "$modified"
}

validate_private_file() {
  monitored_file=$1
  monitored_label=$2
  if [ -L "$monitored_file" ] || [ ! -f "$monitored_file" ]; then
    echo "$monitored_label must be a regular file, not a symlink" >&2
    return 1
  fi
  if [ "$(owner_of "$monitored_file")" != "$(id -u)" ]; then
    echo "$monitored_label must be owned by the current user" >&2
    return 1
  fi
  monitored_mode=$(mode_of "$monitored_file")
  case "$monitored_mode" in ''|*[!0-7]*) echo "Could not verify $monitored_label permissions" >&2; return 1 ;; esac
  if [ $((0$monitored_mode & 077)) -ne 0 ]; then
    echo "$monitored_label must not be accessible by group or other users" >&2
    return 1
  fi
  if [ "$(links_of "$monitored_file")" != 1 ]; then
    echo "$monitored_label must not be hard-linked" >&2
    return 1
  fi
}

if [ "$(owner_of "$backup_dir")" != "$(id -u)" ]; then
  echo "Backup directory must be owned by the current user" >&2
  exit 1
fi
backup_dir_mode=$(mode_of "$backup_dir")
case "$backup_dir_mode" in ''|*[!0-7]*) echo "Could not verify backup directory permissions" >&2; exit 1 ;; esac
if [ $((0$backup_dir_mode & 077)) -ne 0 ]; then
  echo "Backup directory must not be accessible by group or other users" >&2
  exit 1
fi

backup_result=$($systemctl_bin --user show --property Result --value ai-learning-os-backup.service)
if [ "$backup_result" != success ]; then
  echo "Latest database backup job did not succeed: ${backup_result:-unknown}" >&2
  exit 1
fi

latest_backup=
latest_mtime=0
for candidate in "$backup_dir"/ai-learning-os-*.dump; do
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then continue; fi
  candidate_mtime=$(mtime_of "$candidate")
  case "$candidate_mtime" in ''|*[!0-9]*) echo "Could not verify managed backup modification time" >&2; exit 1 ;; esac
  if [ "$candidate_mtime" -gt "$latest_mtime" ]; then
    latest_backup=$candidate
    latest_mtime=$candidate_mtime
  fi
done

if [ -z "$latest_backup" ]; then
  echo "No managed database backup is available" >&2
  exit 1
fi
validate_private_file "$latest_backup" "Latest managed backup" || exit 1
validate_private_file "$latest_backup.sha256" "Latest managed backup checksum" || exit 1
current_time=$(date +%s)
backup_age=$((current_time - latest_mtime))
if [ "$backup_age" -lt 0 ]; then
  echo "Latest database backup modification time is in the future" >&2
  exit 1
fi
if [ "$backup_age" -gt "$maximum_age_seconds" ]; then
  echo "Latest database backup is stale (${backup_age}s old; maximum ${maximum_age_seconds}s)" >&2
  exit 1
fi

printf 'Database backup healthy: %s (%ss old)\n' "$(basename "$latest_backup")" "$backup_age"
