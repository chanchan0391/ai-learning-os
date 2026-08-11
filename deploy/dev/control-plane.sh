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
proc_root=${AI_LEARNING_PROC_ROOT:-/proc}
units="ai-learning-os-api.service ai-learning-os-web.service"
lock_dir="$base_dir/.control-plane.lock"
required_sandbox_directives='UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RemoveIPC=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native'

usage() {
  echo "Usage: $0 [status|install]" >&2
  exit 2
}

validate_sources() {
  if [ ! -x "$node_bin" ]; then
    echo "Selected Node binary is not executable: $node_bin" >&2
    return 1
  fi

  for unit in $units; do
    source_unit="$source_dir/$unit"
    if [ ! -f "$source_unit" ] || [ -L "$source_unit" ]; then
      echo "Missing or unsafe control-plane source: $source_unit" >&2
      return 1
    fi
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
    elif ! cmp -s "$source_unit" "$installed_unit"; then
      echo "$unit: drifted"
      result=1
    elif ! $systemctl_bin --user is-enabled --quiet "$unit"; then
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
  done
  return "$result"
}

rollback_units() {
  backup_dir=$1
  echo "Control-plane verification failed; restoring $backup_dir" >&2
  for unit in $units; do
    target="$unit_dir/$unit"
    rm -f "$unit_dir/.$unit.next.$$"
    if [ -f "$backup_dir/$unit" ]; then
      install -m 0644 "$backup_dir/$unit" "$target"
    else
      rm -f "$target"
    fi
  done
  $systemctl_bin --user daemon-reload
  $systemctl_bin --user restart $units || true
}

apply_units() {
  for unit in $units; do
    staged="$unit_dir/.$unit.next.$$"
    install -m 0644 "$source_dir/$unit" "$staged" || return 1
    mv -f "$staged" "$unit_dir/$unit" || return 1
  done
  $systemctl_bin --user daemon-reload \
    && $systemctl_bin --user restart $units
}

install_control_plane() {
  mkdir -p "$base_dir" "$unit_dir" "$base_dir/control-plane-backups"
  chmod 700 "$base_dir/control-plane-backups"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "Another control-plane operation is already running" >&2
    exit 1
  fi
  trap 'rmdir "$lock_dir"' EXIT HUP INT TERM

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
      install -m 0600 "$target" "$backup_dir/$unit"
    fi
  done

  if ! apply_units || ! status_control_plane; then
    rollback_units "$backup_dir"
    exit 1
  fi

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
