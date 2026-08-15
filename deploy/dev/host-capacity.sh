#!/bin/sh
set -eu

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
backup_dir=${AI_LEARNING_BACKUP_DIR:-"$HOME/backups/ai-learning-os"}
df_bin=${AI_LEARNING_DF_BIN:-df}
min_free_bytes=${AI_LEARNING_MIN_FREE_BYTES:-5368709120}
max_used_percent=${AI_LEARNING_MAX_DISK_USED_PERCENT:-90}
min_free_inodes=${AI_LEARNING_MIN_FREE_INODES:-100000}
max_inode_used_percent=${AI_LEARNING_MAX_INODE_USED_PERCENT:-90}

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
  fi | awk 'NR > 1 { available = $(NF - 2); used = $(NF - 1) } END {
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
if ! command -v "$df_bin" >/dev/null 2>&1; then
  echo "df is required for host capacity monitoring" >&2
  exit 2
fi

validate_directory "$base_dir" "Deployment"
validate_directory "$backup_dir" "Backup"
check_directory "$base_dir" "Deployment"
check_directory "$backup_dir" "Backup"
