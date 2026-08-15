#!/bin/sh
set -eu

action=${1:-status}
base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
source_dir=${AI_LEARNING_CONTROL_PLANE_SOURCE_DIR:-"$base_dir/current/deploy/dev"}
unit_dir=${AI_LEARNING_SYSTEMD_USER_DIR:-"$HOME/.config/systemd/user"}
node_bin=${AI_LEARNING_NODE_BIN:-"$HOME/.nvm/versions/node/v22.23.1/bin/node"}
case "$node_bin" in
  "$HOME"/*) unit_node_bin="%h/${node_bin#"$HOME"/}" ;;
  *) unit_node_bin=$node_bin ;;
esac
systemctl_bin=${AI_LEARNING_SYSTEMCTL_BIN:-systemctl}
flock_bin=${AI_LEARNING_FLOCK_BIN:-flock}
stat_bin=${AI_LEARNING_STAT_BIN:-stat}
proc_root=${AI_LEARNING_PROC_ROOT:-/proc}
application_units="ai-learning-os-api.service ai-learning-os-web.service"
backup_service="ai-learning-os-backup.service"
backup_timer="ai-learning-os-backup.timer"
backup_monitor_service="ai-learning-os-backup-monitor.service"
backup_monitor_timer="ai-learning-os-backup-monitor.timer"
application_monitor_service="ai-learning-os-application-monitor.service"
application_monitor_timer="ai-learning-os-application-monitor.timer"
monitor_services="$backup_monitor_service $application_monitor_service"
timer_units="$backup_timer $backup_monitor_timer $application_monitor_timer"
units="$application_units $backup_service $backup_timer $backup_monitor_service $backup_monitor_timer $application_monitor_service $application_monitor_timer"
lock_file="$base_dir/control-plane.lock"
backup_retention_count=5
staged_unit=
required_sandbox_directives='UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectControlGroups=true
ProtectKernelTunables=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RemoveIPC=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native'
required_monitor_sandbox_directives='UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectControlGroups=true
ProtectKernelTunables=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RemoveIPC=true
RestrictAddressFamilies=AF_UNIX
SystemCallArchitectures=native'

usage() {
  echo "Usage: $0 [status|install]" >&2
  exit 2
}

validate_owned_directory() {
  directory_path=$1
  directory_label=$2
  if [ -L "$directory_path" ] || [ ! -d "$directory_path" ]; then
    echo "$directory_label must be a real directory, not a symlink" >&2
    return 1
  fi
  directory_owner=$($stat_bin -f '%u' "$directory_path" 2>/dev/null || true)
  case "$directory_owner" in
    ''|*[!0-9]*) directory_owner=$($stat_bin -c '%u' "$directory_path" 2>/dev/null || true) ;;
  esac
  case "$directory_owner" in
    ''|*[!0-9]*) echo "Could not verify $directory_label ownership" >&2; return 1 ;;
  esac
  if [ "$directory_owner" != "$(id -u)" ]; then
    echo "$directory_label must be owned by the current user" >&2
    return 1
  fi
}

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

cleanup_stage() {
  if [ -n "$staged_unit" ]; then rm -f "$staged_unit"; fi
}
trap cleanup_stage EXIT HUP INT TERM

validate_sources() {
  if [ ! -x "$node_bin" ]; then
    echo "Selected Node binary is not executable: $node_bin" >&2
    return 1
  fi

  for unit in $application_units; do
    source_unit="$source_dir/$unit"
    validate_owned_regular_file "$source_unit" "Control-plane source $unit" || return 1
    if ! grep -Fq "ExecStart=$node_bin " "$source_unit" \
      && ! grep -Fq "ExecStart=$unit_node_bin " "$source_unit"; then
      echo "$unit does not use the selected Node binary" >&2
      return 1
    fi
    echo "$required_sandbox_directives" | while IFS= read -r directive; do
      if ! grep -Fxq "$directive" "$source_unit"; then
        echo "$unit is missing required sandbox directive: $directive" >&2
        exit 1
      fi
    done || return 1
  done

  backup_source="$source_dir/$backup_service"
  validate_owned_regular_file "$backup_source" "Control-plane source $backup_service" || return 1
  for directive in \
    'Type=oneshot' \
    'ExecStart=%h/services/ai-learning-os/backup.sh' \
    'OnSuccess=ai-learning-os-backup-monitor.service' \
    'OnFailure=ai-learning-os-backup-monitor.service' \
    'ReadWritePaths=-%h/backups/ai-learning-os'; do
    if ! grep -Fxq "$directive" "$backup_source"; then
      echo "$backup_service is missing required backup directive: $directive" >&2
      return 1
    fi
  done

  monitor_source="$source_dir/$backup_monitor_service"
  validate_owned_regular_file "$monitor_source" "Control-plane source $backup_monitor_service" || return 1
  for directive in \
    'Type=oneshot' \
    'ExecStart=%h/services/ai-learning-os/backup-health.sh'; do
    if ! grep -Fxq "$directive" "$monitor_source"; then
      echo "$backup_monitor_service is missing required monitor directive: $directive" >&2
      return 1
    fi
  done
  echo "$required_monitor_sandbox_directives" | while IFS= read -r directive; do
    if ! grep -Fxq "$directive" "$monitor_source"; then
      echo "$backup_monitor_service is missing required sandbox directive: $directive" >&2
      exit 1
    fi
  done || return 1
  echo "$required_sandbox_directives" | while IFS= read -r directive; do
    if ! grep -Fxq "$directive" "$backup_source"; then
      echo "$backup_service is missing required sandbox directive: $directive" >&2
      exit 1
    fi
  done || return 1

  timer_source="$source_dir/$backup_timer"
  validate_owned_regular_file "$timer_source" "Control-plane source $backup_timer" || return 1
  for directive in \
    'OnCalendar=*-*-* 03:00:00 UTC' \
    'RandomizedDelaySec=30m' \
    'Persistent=true' \
    'Unit=ai-learning-os-backup.service' \
    'WantedBy=timers.target'; do
    if ! grep -Fxq "$directive" "$timer_source"; then
      echo "$backup_timer is missing required schedule directive: $directive" >&2
      return 1
    fi
  done
  monitor_timer_source="$source_dir/$backup_monitor_timer"
  validate_owned_regular_file "$monitor_timer_source" "Control-plane source $backup_monitor_timer" || return 1
  for directive in \
    'OnBootSec=5m' \
    'OnUnitActiveSec=15m' \
    'Unit=ai-learning-os-backup-monitor.service' \
    'WantedBy=timers.target'; do
    if ! grep -Fxq "$directive" "$monitor_timer_source"; then
      echo "$backup_monitor_timer is missing required schedule directive: $directive" >&2
      return 1
    fi
  done

  application_monitor_source="$source_dir/$application_monitor_service"
  validate_owned_regular_file "$application_monitor_source" "Control-plane source $application_monitor_service" || return 1
  for directive in \
    'Type=oneshot' \
    'ExecStart=%h/services/ai-learning-os/application-health.sh' \
    'After=ai-learning-os-api.service ai-learning-os-web.service'; do
    if ! grep -Fxq "$directive" "$application_monitor_source"; then
      echo "$application_monitor_service is missing required monitor directive: $directive" >&2
      return 1
    fi
  done
  echo "$required_sandbox_directives" | while IFS= read -r directive; do
    if ! grep -Fxq "$directive" "$application_monitor_source"; then
      echo "$application_monitor_service is missing required sandbox directive: $directive" >&2
      exit 1
    fi
  done || return 1

  application_monitor_timer_source="$source_dir/$application_monitor_timer"
  validate_owned_regular_file "$application_monitor_timer_source" "Control-plane source $application_monitor_timer" || return 1
  for directive in \
    'OnBootSec=2m' \
    'OnUnitActiveSec=5m' \
    'Unit=ai-learning-os-application-monitor.service' \
    'WantedBy=timers.target'; do
    if ! grep -Fxq "$directive" "$application_monitor_timer_source"; then
      echo "$application_monitor_timer is missing required schedule directive: $directive" >&2
      return 1
    fi
  done
}

service_uses_selected_node() {
  service_name=$1
  service_pid=$($systemctl_bin --user show --property MainPID --value "$service_name")
  case "$service_pid" in
    ""|*[!0-9]*) return 1 ;;
  esac
  [ "$service_pid" -gt 0 ] 2>/dev/null \
    && [ -e "$proc_root/$service_pid/exe" ] \
    && [ "$(realpath "$proc_root/$service_pid/exe")" = "$(realpath "$node_bin")" ]
}

status_control_plane() {
  result=0
  for unit in $units; do
    source_unit="$source_dir/$unit"
    installed_unit="$unit_dir/$unit"
    if [ ! -f "$installed_unit" ]; then
      echo "$unit: missing"
      result=1
    elif ! validate_owned_regular_file "$installed_unit" "Installed $unit"; then
      echo "$unit: unsafe"
      result=1
    elif ! cmp -s "$source_unit" "$installed_unit"; then
      echo "$unit: drifted"
      result=1
    else
      case "$unit" in
        $backup_service|$backup_monitor_service|$application_monitor_service)
          if $systemctl_bin --user is-failed --quiet "$unit"; then
            echo "$unit: failed"
            result=1
          else
            echo "$unit: current, timer-triggered"
          fi
          ;;
        $backup_timer|$backup_monitor_timer|$application_monitor_timer)
          if ! $systemctl_bin --user is-enabled --quiet "$unit"; then
            echo "$unit: disabled"
            result=1
          elif ! $systemctl_bin --user is-active --quiet "$unit"; then
            echo "$unit: inactive"
            result=1
          else
            echo "$unit: current, enabled, active"
          fi
          ;;
        *)
          if ! $systemctl_bin --user is-enabled --quiet "$unit"; then
            echo "$unit: disabled"
            result=1
          elif ! $systemctl_bin --user is-active --quiet "$unit"; then
            echo "$unit: inactive"
            result=1
          elif ! service_uses_selected_node "$unit"; then
            echo "$unit: unexpected runtime"
            result=1
          else
            echo "$unit: current, enabled, active, selected runtime"
          fi
          ;;
      esac
    fi
  done
  return "$result"
}

rollback_units() {
  backup_dir=$1
  echo "Control-plane verification failed; restoring $backup_dir" >&2
  for unit in $units; do
    target="$unit_dir/$unit"
    if [ -f "$backup_dir/$unit" ]; then
      install_unit_atomically "$backup_dir/$unit" "$target" 0644 || return 1
    else
      if [ -e "$target" ] || [ -L "$target" ]; then
        validate_owned_regular_file "$target" "Installed $unit" || return 1
      fi
      rm -f "$target"
    fi
  done
  $systemctl_bin --user daemon-reload
  $systemctl_bin --user restart $application_units || true
  $systemctl_bin --user enable --now $timer_units || true
}

install_unit_atomically() {
  source_unit=$1
  target=$2
  mode=$3
  validate_owned_regular_file "$source_unit" "Control-plane unit source" || return 1
  if [ -e "$target" ] || [ -L "$target" ]; then
    validate_owned_regular_file "$target" "Installed $(basename "$target")" || return 1
  fi
  staged_unit=$(mktemp "$unit_dir/.$(basename "$target").next.XXXXXX") || return 1
  install -m "$mode" "$source_unit" "$staged_unit" || return 1
  validate_owned_regular_file "$staged_unit" "Staged $(basename "$target")" || return 1
  mv -f "$staged_unit" "$target" || return 1
  staged_unit=
}

apply_units() {
  for unit in $units; do
    install_unit_atomically "$source_dir/$unit" "$unit_dir/$unit" 0644 || return 1
  done
  $systemctl_bin --user daemon-reload \
    && $systemctl_bin --user restart $application_units \
    && $systemctl_bin --user reset-failed "$backup_service" $monitor_services \
    && $systemctl_bin --user enable --now $timer_units \
    && $systemctl_bin --user start $monitor_services
}

cleanup_control_plane_artifacts() {
  for unit in $units; do
    find "$unit_dir" -mindepth 1 -maxdepth 1 -type f -name ".$unit.next.*" -print \
      | while IFS= read -r abandoned_stage; do
          case "$abandoned_stage" in
            "$unit_dir"/.$unit.next.*)
              validate_owned_regular_file "$abandoned_stage" "Abandoned staged $unit" || continue
              rm -f "$abandoned_stage"
              ;;
            *) echo "Refusing to remove unexpected staged unit: $abandoned_stage" >&2; return 1 ;;
          esac
        done || return 1
  done

  find "$base_dir/control-plane-backups" -mindepth 1 -maxdepth 1 -type d \
    -name '????????T??????Z.*' -print \
    | sort -r \
    | awk -v keep="$backup_retention_count" 'NR > keep { print }' \
    | while IFS= read -r stale_backup; do
        case "$stale_backup" in
          "$base_dir"/control-plane-backups/????????T??????Z.*)
            validate_owned_directory "$stale_backup" "Stale control-plane backup" || continue
            rm -rf "$stale_backup"
            ;;
          *) echo "Refusing to remove unexpected control-plane backup: $stale_backup" >&2; return 1 ;;
        esac
      done
}

install_control_plane() {
  if [ -L "$base_dir" ]; then
    echo "Deployment directory must be a real directory, not a symlink" >&2
    exit 1
  fi
  mkdir -p "$base_dir"
  validate_owned_directory "$base_dir" "Deployment directory"

  if [ -L "$unit_dir" ]; then
    echo "Systemd user unit directory must be a real directory, not a symlink" >&2
    exit 1
  fi
  mkdir -p "$unit_dir"
  validate_owned_directory "$unit_dir" "Systemd user unit directory"

  if [ -L "$base_dir/control-plane-backups" ]; then
    echo "Control-plane backup directory must be a real directory, not a symlink" >&2
    exit 1
  fi
  mkdir -p "$base_dir/control-plane-backups"
  validate_owned_directory "$base_dir/control-plane-backups" "Control-plane backup directory"
  chmod 700 "$base_dir/control-plane-backups"
  if ! command -v "$flock_bin" >/dev/null 2>&1; then
    echo "flock is required for crash-safe control-plane locking" >&2
    exit 1
  fi
  if [ -e "$lock_file" ] || [ -L "$lock_file" ]; then
    validate_owned_regular_file "$lock_file" "Control-plane lock" || exit 1
  fi
  exec 9>>"$lock_file"
  validate_owned_regular_file "$lock_file" "Control-plane lock" || exit 1
  chmod 600 "$lock_file"
  if ! "$flock_bin" -n 9; then
    echo "Another control-plane operation is already running" >&2
    exit 1
  fi

  cleanup_control_plane_artifacts

  if status_control_plane >/dev/null 2>&1; then
    echo "Control plane is already current"
    status_control_plane
    return
  fi

  backup_dir=$(mktemp -d "$base_dir/control-plane-backups/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
  chmod 700 "$backup_dir"
  for unit in $units; do
    target="$unit_dir/$unit"
    if [ -f "$target" ]; then
      validate_owned_regular_file "$target" "Installed $unit" || exit 1
      install -m 0600 "$target" "$backup_dir/$unit"
    fi
  done

  if ! apply_units || ! status_control_plane; then
    rollback_units "$backup_dir"
    cleanup_control_plane_artifacts
    exit 1
  fi

  cleanup_control_plane_artifacts
  echo "Installed control plane; backup: $backup_dir"
}

case "$action" in
  status)
    validate_sources
    status_control_plane
    ;;
  install)
    validate_sources
    install_control_plane
    ;;
  *) usage ;;
esac
