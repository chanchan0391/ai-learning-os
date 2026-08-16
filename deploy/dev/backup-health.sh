#!/bin/sh
set -eu

backup_dir=${AI_LEARNING_BACKUP_DIR:-"$HOME/backups/ai-learning-os"}
maximum_age_seconds=${AI_LEARNING_BACKUP_MAX_AGE_SECONDS:-108000}
systemctl_bin=${AI_LEARNING_SYSTEMCTL_BIN:-systemctl}
stat_bin=/usr/bin/stat
id_bin=/usr/bin/id
date_bin=/bin/date
basename_bin=/usr/bin/basename

read_stat_value() {
  bsd_format=$1
  gnu_format=$2
  target=$3
  value=$($stat_bin -f "$bsd_format" "$target" 2>/dev/null || true)
  case "$value" in ''|*[!0-9]*) value=$($stat_bin -c "$gnu_format" "$target" 2>/dev/null || true) ;; esac
  case "$value" in ''|*[!0-9]*) echo "Could not verify backup monitor executable metadata" >&2; exit 1 ;; esac
  printf '%s\n' "$value"
}

is_systemd_mapped_systemctl() {
  [ "$1" = 65534 ] && [ "$2" = 65534 ] && [ -n "${INVOCATION_ID:-}" ] \
    && [ "$3" = /usr/bin/systemctl ] && [ "$4" = /usr/bin ]
}

resolve_trusted_executable() {
  candidate=$1
  label=$2
  require_root=false
  case "$candidate" in
    /*) resolved=$candidate ;;
    */*) echo "$label executable path must be absolute" >&2; return 2 ;;
    *)
      require_root=true
      resolved=$(command -v "$candidate" 2>/dev/null || true)
      case "$resolved" in /*) ;; *) echo "Could not resolve $label executable to an absolute path" >&2; return 2 ;; esac
      ;;
  esac
  executable_dir=${resolved%/*}
  if [ -L "$executable_dir" ] || [ ! -d "$executable_dir" ] || [ -L "$resolved" ] || [ ! -f "$resolved" ] || [ ! -x "$resolved" ]; then
    echo "$label executable is missing or unsafe" >&2
    return 2
  fi
  current_uid=$($id_bin -u)
  executable_owner=$(read_stat_value '%u' '%u' "$resolved")
  directory_owner=$(read_stat_value '%u' '%u' "$executable_dir")
  if ! is_systemd_mapped_systemctl "$executable_owner" "$directory_owner" "$resolved" "$executable_dir"; then
    if [ "$require_root" = true ]; then
      [ "$executable_owner" = 0 ] && [ "$directory_owner" = 0 ] || {
        echo "$label resolved from PATH must be owned by root" >&2; return 2;
      }
    else
      case "$executable_owner" in 0|"$current_uid") ;; *) echo "$label executable has an unsafe owner" >&2; return 2 ;; esac
      case "$directory_owner" in 0|"$current_uid") ;; *) echo "$label executable directory has an unsafe owner" >&2; return 2 ;; esac
    fi
  fi
  executable_mode=$(read_stat_value '%Lp' '%a' "$resolved")
  directory_mode=$(read_stat_value '%Lp' '%a' "$executable_dir")
  if [ $((0$executable_mode & 022)) -ne 0 ] || [ $((0$directory_mode & 022)) -ne 0 ]; then
    echo "$label executable and directory must not be group or other writable" >&2
    return 2
  fi
  if [ "$(read_stat_value '%l' '%h' "$resolved")" != 1 ]; then
    echo "$label executable must not be hard-linked" >&2
    return 2
  fi
  printf '%s\n' "$resolved"
}

for trusted_system_tool in "$stat_bin" "$id_bin" "$date_bin" "$basename_bin"; do
  if [ -L "$trusted_system_tool" ] || [ ! -f "$trusted_system_tool" ] || [ ! -x "$trusted_system_tool" ]; then
    echo "Required trusted system executable is unavailable" >&2
    exit 2
  fi
done
systemctl_bin=$(resolve_trusted_executable "$systemctl_bin" "systemctl")

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
  if [ "$(owner_of "$monitored_file")" != "$($id_bin -u)" ]; then
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

if [ "$(owner_of "$backup_dir")" != "$($id_bin -u)" ]; then
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
current_time=$($date_bin +%s)
backup_age=$((current_time - latest_mtime))
if [ "$backup_age" -lt 0 ]; then
  echo "Latest database backup modification time is in the future" >&2
  exit 1
fi
if [ "$backup_age" -gt "$maximum_age_seconds" ]; then
  echo "Latest database backup is stale (${backup_age}s old; maximum ${maximum_age_seconds}s)" >&2
  exit 1
fi

printf 'Database backup healthy: %s (%ss old)\n' "$($basename_bin "$latest_backup")" "$backup_age"
