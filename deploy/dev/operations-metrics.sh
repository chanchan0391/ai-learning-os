#!/bin/sh
set -eu
umask 077

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
state_dir=${AI_LEARNING_OPERATIONS_STATE_DIR:-"$base_dir/operations-state"}
stat_bin=/usr/bin/stat
id_bin=/usr/bin/id
cat_bin=/bin/cat
flock_bin=${AI_LEARNING_FLOCK_BIN:-/usr/bin/flock}

case "$flock_bin" in
  /*) ;;
  *) echo "Operations metrics lock helper path must be absolute" >&2; exit 2 ;;
esac

read_stat_value() {
  bsd_format=$1
  gnu_format=$2
  target=$3
  value=$($stat_bin -f "$bsd_format" "$target" 2>/dev/null || true)
  case "$value" in ''|*[!0-9]*) value=$($stat_bin -c "$gnu_format" "$target" 2>/dev/null || true) ;; esac
  case "$value" in ''|*[!0-9]*) echo "Operations metrics metadata is unavailable" >&2; exit 1 ;; esac
  printf '%s\n' "$value"
}

validate_private_file() {
  private_file=$1
  private_label=$2
  if [ -L "$private_file" ] || [ ! -f "$private_file" ]; then
    echo "$private_label must be a regular file" >&2
    exit 1
  fi
  if [ "$(read_stat_value '%u' '%u' "$private_file")" != "$($id_bin -u)" ] \
    || [ "$(read_stat_value '%l' '%h' "$private_file")" != 1 ] \
    || [ $((0$(read_stat_value '%Lp' '%a' "$private_file") & 077)) -ne 0 ]; then
    echo "$private_label ownership is unsafe" >&2
    exit 1
  fi
}

read_counter() {
  counter_path=$1
  counter_label=$2
  if [ ! -e "$counter_path" ] && [ ! -L "$counter_path" ]; then
    printf '0\n'
    return
  fi
  validate_private_file "$counter_path" "$counter_label"
  if [ "$(read_stat_value '%z' '%s' "$counter_path")" -gt 17 ]; then
    echo "$counter_label is invalid" >&2
    exit 1
  fi
  counter_value=$($cat_bin "$counter_path")
  case "$counter_value" in ''|*[!0-9]*) echo "$counter_label is invalid" >&2; exit 1 ;; esac
  if [ "$counter_value" -gt 9007199254740991 ]; then
    echo "$counter_label is invalid" >&2
    exit 1
  fi
  printf '%s\n' "$counter_value"
}

if [ -L "$state_dir" ] || [ ! -d "$state_dir" ]; then
  echo "Operations state directory must be a real directory" >&2
  exit 1
fi
if [ "$(read_stat_value '%u' '%u' "$state_dir")" != "$($id_bin -u)" ]; then
  echo "Operations state directory must be owned by the current user" >&2
  exit 1
fi
state_mode=$(read_stat_value '%Lp' '%a' "$state_dir")
if [ $((0$state_mode & 077)) -ne 0 ]; then
  echo "Operations state directory must be private" >&2
  exit 1
fi

flock_dir=${flock_bin%/*}
if [ -L "$flock_dir" ] || [ ! -d "$flock_dir" ]; then
  echo "Operations metrics lock helper directory is unsafe" >&2
  exit 2
fi
if [ -L "$flock_bin" ] || [ ! -f "$flock_bin" ] || [ ! -x "$flock_bin" ]; then
  echo "Operations metrics lock helper is unavailable" >&2
  exit 2
fi
current_uid=$($id_bin -u)
flock_owner=$(read_stat_value '%u' '%u' "$flock_bin")
flock_dir_owner=$(read_stat_value '%u' '%u' "$flock_dir")
case "$flock_owner" in 0|"$current_uid") ;; *) echo "Operations metrics lock helper ownership is unsafe" >&2; exit 2 ;; esac
case "$flock_dir_owner" in 0|"$current_uid") ;; *) echo "Operations metrics lock helper directory ownership is unsafe" >&2; exit 2 ;; esac
if [ "$(read_stat_value '%l' '%h' "$flock_bin")" != 1 ] \
  || [ $((0$(read_stat_value '%Lp' '%a' "$flock_bin") & 022)) -ne 0 ]; then
  echo "Operations metrics lock helper ownership is unsafe" >&2
  exit 2
fi
if [ $((0$(read_stat_value '%Lp' '%a' "$flock_dir") & 022)) -ne 0 ]; then
  echo "Operations metrics lock helper directory ownership is unsafe" >&2
  exit 2
fi
lock_file="$state_dir/crash-evidence.lock"
validate_private_file "$lock_file" "Operations metrics lock"
exec 8>>"$lock_file"
if ! "$flock_bin" -s -w 5 8; then
  echo "Operations metrics lock timed out" >&2
  exit 1
fi

api_count=$(read_counter "$state_dir/ai-learning-os-api.service.crash-count" "API crash counter")
api_observed=$(read_counter "$state_dir/ai-learning-os-api.service.observed-crash-count" "API observed crash counter")
web_count=$(read_counter "$state_dir/ai-learning-os-web.service.crash-count" "Web crash counter")
web_observed=$(read_counter "$state_dir/ai-learning-os-web.service.observed-crash-count" "Web observed crash counter")
monitor_last_success=$(read_counter "$state_dir/application-monitor-last-success-unixtime" "Application monitor last success time")
backup_monitor_last_success=$(read_counter "$state_dir/backup-monitor-last-success-unixtime" "Backup monitor last success time")
restore_drill_last_success=$(read_counter "$state_dir/restore-drill-last-success-unixtime" "Restore drill last success time")
capacity_monitor_last_success=$(read_counter "$state_dir/host-capacity-monitor-last-success-unixtime" "Host capacity monitor last success time")

if [ "$api_observed" -gt "$api_count" ] || [ "$web_observed" -gt "$web_count" ]; then
  echo "Observed crash counter exceeds recorded evidence" >&2
  exit 1
fi
api_unobserved=$((api_count - api_observed))
web_unobserved=$((web_count - web_observed))

printf '%s\n' \
  '# HELP ai_learning_os_service_unexpected_exits_total Unexpected process exits recorded for a managed service.' \
  '# TYPE ai_learning_os_service_unexpected_exits_total counter' \
  "ai_learning_os_service_unexpected_exits_total{service=\"api\"} $api_count" \
  "ai_learning_os_service_unexpected_exits_total{service=\"web\"} $web_count" \
  '# HELP ai_learning_os_service_unobserved_exits Unexpected process exits not yet observed by the application monitor.' \
  '# TYPE ai_learning_os_service_unobserved_exits gauge' \
  "ai_learning_os_service_unobserved_exits{service=\"api\"} $api_unobserved" \
  "ai_learning_os_service_unobserved_exits{service=\"web\"} $web_unobserved" \
  '# HELP ai_learning_os_application_monitor_last_success_unixtime Unix time of the last fully successful application health check.' \
  '# TYPE ai_learning_os_application_monitor_last_success_unixtime gauge' \
  "ai_learning_os_application_monitor_last_success_unixtime $monitor_last_success" \
  '# HELP ai_learning_os_backup_monitor_last_success_unixtime Unix time of the last fully successful backup health check.' \
  '# TYPE ai_learning_os_backup_monitor_last_success_unixtime gauge' \
  "ai_learning_os_backup_monitor_last_success_unixtime $backup_monitor_last_success" \
  '# HELP ai_learning_os_restore_drill_last_success_unixtime Unix time of the last successful isolated restore drill.' \
  '# TYPE ai_learning_os_restore_drill_last_success_unixtime gauge' \
  "ai_learning_os_restore_drill_last_success_unixtime $restore_drill_last_success" \
  '# HELP ai_learning_os_host_capacity_monitor_last_success_unixtime Unix time of the last successful host capacity check.' \
  '# TYPE ai_learning_os_host_capacity_monitor_last_success_unixtime gauge' \
  "ai_learning_os_host_capacity_monitor_last_success_unixtime $capacity_monitor_last_success"
