#!/bin/sh
set -eu

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
backup_dir=${AI_LEARNING_BACKUP_DIR:-"$HOME/backups/ai-learning-os"}
df_bin=${AI_LEARNING_DF_BIN:-df}
stat_bin=/usr/bin/stat
id_bin=/usr/bin/id
awk_bin=/usr/bin/awk
min_free_bytes=${AI_LEARNING_MIN_FREE_BYTES:-5368709120}
max_used_percent=${AI_LEARNING_MAX_DISK_USED_PERCENT:-90}
min_free_inodes=${AI_LEARNING_MIN_FREE_INODES:-100000}
max_inode_used_percent=${AI_LEARNING_MAX_INODE_USED_PERCENT:-90}

read_stat_value() {
  bsd_format=$1
  gnu_format=$2
  target=$3
  value=$($stat_bin -f "$bsd_format" "$target" 2>/dev/null || true)
  case "$value" in ''|*[!0-9]*) value=$($stat_bin -c "$gnu_format" "$target" 2>/dev/null || true) ;; esac
  case "$value" in ''|*[!0-9]*) echo "Could not verify capacity monitor executable metadata" >&2; exit 1 ;; esac
  printf '%s\n' "$value"
}

is_systemd_mapped_df() {
  [ "$1" = 65534 ] && [ "$2" = 65534 ] && [ -n "${INVOCATION_ID:-}" ] \
    && [ "$3" = /usr/bin/df ] && [ "$4" = /usr/bin ]
}

resolve_trusted_df() {
  candidate=$1
  require_root=false
  case "$candidate" in
    /*) resolved=$candidate ;;
    */*) echo "df executable path must be absolute" >&2; return 2 ;;
    *)
      require_root=true
      resolved=$(command -v "$candidate" 2>/dev/null || true)
      case "$resolved" in /*) ;; *) echo "Could not resolve df executable to an absolute path" >&2; return 2 ;; esac
      ;;
  esac
  executable_dir=${resolved%/*}
  if [ -L "$executable_dir" ] || [ ! -d "$executable_dir" ] || [ -L "$resolved" ] || [ ! -f "$resolved" ] || [ ! -x "$resolved" ]; then
    echo "df executable is missing or unsafe" >&2
    return 2
  fi
  current_uid=$($id_bin -u)
  executable_owner=$(read_stat_value '%u' '%u' "$resolved")
  directory_owner=$(read_stat_value '%u' '%u' "$executable_dir")
  if is_systemd_mapped_df "$executable_owner" "$directory_owner" "$resolved" "$executable_dir"; then
    :
  elif [ "$require_root" = true ]; then
    [ "$executable_owner" = 0 ] && [ "$directory_owner" = 0 ] || {
      echo "df resolved from PATH must be owned by root" >&2; return 2;
    }
  else
    case "$executable_owner" in 0|"$current_uid") ;; *) echo "df executable has an unsafe owner" >&2; return 2 ;; esac
    case "$directory_owner" in 0|"$current_uid") ;; *) echo "df executable directory has an unsafe owner" >&2; return 2 ;; esac
  fi
  executable_mode=$(read_stat_value '%Lp' '%a' "$resolved")
  directory_mode=$(read_stat_value '%Lp' '%a' "$executable_dir")
  if [ $((0$executable_mode & 022)) -ne 0 ] || [ $((0$directory_mode & 022)) -ne 0 ]; then
    echo "df executable and directory must not be group or other writable" >&2
    return 2
  fi
  if [ "$(read_stat_value '%l' '%h' "$resolved")" != 1 ]; then
    echo "df executable must not be hard-linked" >&2
    return 2
  fi
  printf '%s\n' "$resolved"
}

for trusted_system_tool in "$stat_bin" "$id_bin"; do
  if [ -L "$trusted_system_tool" ] || [ ! -f "$trusted_system_tool" ] || [ ! -x "$trusted_system_tool" ]; then
    echo "Required trusted system executable is unavailable" >&2
    exit 2
  fi
done
if [ ! -x "$awk_bin" ]; then
  echo "Required trusted system executable is unavailable" >&2
  exit 2
fi
df_bin=$(resolve_trusted_df "$df_bin")

validate_unsigned_integer() {
  value=$1
  label=$2
  case "$value" in
    ''|*[!0-9]*) echo "$label must be an unsigned integer" >&2; exit 2 ;;
  esac
}

validate_percentage() {
  value=$1
  label=$2
  validate_unsigned_integer "$value" "$label"
  if [ "$value" -lt 1 ] || [ "$value" -gt 100 ]; then
    echo "$label must be between 1 and 100" >&2
    exit 2
  fi
}

validate_directory() {
  directory=$1
  label=$2
  case "$directory" in
    /*) ;;
    *) echo "$label path must be absolute" >&2; exit 2 ;;
  esac
  if [ -L "$directory" ] || [ ! -d "$directory" ]; then
    echo "$label directory must be a real directory, not a symlink" >&2
    exit 1
  fi
}

read_capacity() {
  mode=$1
  directory=$2
  if [ "$mode" = blocks ]; then
    "$df_bin" -Pk "$directory"
  else
    "$df_bin" -Pi "$directory"
  fi | "$awk_bin" 'NR > 1 { available = $(NF - 2); used = $(NF - 1) } END {
    sub(/%$/, "", used)
    if (available !~ /^[0-9]+$/ || used !~ /^[0-9]+$/) exit 1
    print available, used
  }'
}

check_directory() {
  directory=$1
  label=$2
  if ! block_capacity=$(read_capacity blocks "$directory"); then
    echo "Could not read $label filesystem capacity" >&2
    exit 1
  fi
  set -- $block_capacity
  available_kib=$1
  used_percent=$2
  available_bytes=$((available_kib * 1024))
  if [ "$available_bytes" -lt "$min_free_bytes" ] || [ "$used_percent" -ge "$max_used_percent" ]; then
    echo "$label filesystem capacity is below the safe boundary" >&2
    exit 1
  fi

  if ! inode_capacity=$(read_capacity inodes "$directory"); then
    echo "Could not read $label filesystem inode capacity" >&2
    exit 1
  fi
  set -- $inode_capacity
  available_inodes=$1
  inode_used_percent=$2
  if [ "$available_inodes" -lt "$min_free_inodes" ] || [ "$inode_used_percent" -ge "$max_inode_used_percent" ]; then
    echo "$label filesystem inode capacity is below the safe boundary" >&2
    exit 1
  fi

  printf '%s capacity healthy: %s%% blocks used, %s%% inodes used\n' \
    "$label" "$used_percent" "$inode_used_percent"
}

validate_unsigned_integer "$min_free_bytes" "Minimum free bytes"
validate_percentage "$max_used_percent" "Maximum disk usage percentage"
validate_unsigned_integer "$min_free_inodes" "Minimum free inodes"
validate_percentage "$max_inode_used_percent" "Maximum inode usage percentage"
if [ "$min_free_bytes" -lt 1 ] || [ "$min_free_inodes" -lt 1 ]; then
  echo "Minimum free capacity boundaries must be positive" >&2
  exit 2
fi
validate_directory "$base_dir" "Deployment"
validate_directory "$backup_dir" "Backup"
check_directory "$base_dir" "Deployment"
check_directory "$backup_dir" "Backup"
