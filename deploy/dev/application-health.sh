#!/bin/sh
set -eu

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
systemctl_bin=${AI_LEARNING_SYSTEMCTL_BIN:-systemctl}
curl_bin=${AI_LEARNING_CURL_BIN:-curl}
node_bin=${AI_LEARNING_NODE_BIN:-"$HOME/.nvm/versions/node/v22.23.1/bin/node"}
# The system image is read-only in the monitor unit, so use its absolute stat
# binary to bootstrap ownership and permission checks without trusting PATH.
stat_bin=/usr/bin/stat
id_bin=/usr/bin/id
cat_bin=/bin/cat
mktemp_bin=/usr/bin/mktemp
chmod_bin=/bin/chmod
mv_bin=/bin/mv
rm_bin=/bin/rm
web_url=${AI_LEARNING_WEB_HEALTH_URL:-http://127.0.0.1:8088/}
api_url=${AI_LEARNING_API_HEALTH_URL:-http://127.0.0.1:8787/api/health}

read_stat_value() {
  bsd_format=$1
  gnu_format=$2
  target=$3
  value=$($stat_bin -f "$bsd_format" "$target" 2>/dev/null || true)
  case "$value" in ''|*[!0-9]*) value=$($stat_bin -c "$gnu_format" "$target" 2>/dev/null || true) ;; esac
  case "$value" in ''|*[!0-9]*) echo "Could not verify deployed revision metadata" >&2; exit 1 ;; esac
  printf '%s\n' "$value"
}

is_systemd_mapped_root_executable() {
  mapped_file_owner=$1
  mapped_dir_owner=$2
  mapped_path=$3
  mapped_dir=$4
  [ "$mapped_file_owner" = 65534 ] \
    && [ "$mapped_dir_owner" = 65534 ] \
    && [ -n "${INVOCATION_ID:-}" ] \
    && [ "$mapped_dir" = /usr/bin ] \
    && { [ "$mapped_path" = /usr/bin/systemctl ] || [ "$mapped_path" = /usr/bin/curl ]; }
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
      case "$resolved" in
        /*) ;;
        *) echo "Could not resolve $label executable to an absolute path" >&2; return 2 ;;
      esac
      ;;
  esac

  executable_dir=${resolved%/*}
  if [ -L "$executable_dir" ] || [ ! -d "$executable_dir" ]; then
    echo "$label executable directory must be a real directory, not a symlink" >&2
    return 2
  fi
  if [ -L "$resolved" ] || [ ! -f "$resolved" ] || [ ! -x "$resolved" ]; then
    echo "$label executable is missing or unsafe" >&2
    return 2
  fi

  current_uid=$($id_bin -u)
  executable_owner=$(read_stat_value '%u' '%u' "$resolved")
  directory_owner=$(read_stat_value '%u' '%u' "$executable_dir")
  if ! is_systemd_mapped_root_executable "$executable_owner" "$directory_owner" "$resolved" "$executable_dir"; then
    if [ "$require_root" = true ]; then
      [ "$executable_owner" = 0 ] && [ "$directory_owner" = 0 ] || {
        echo "$label resolved from PATH must be owned by root" >&2
        return 2
      }
    else
      case "$executable_owner" in 0|"$current_uid") ;; *) echo "$label executable must be owned by root or the current user" >&2; return 2 ;; esac
      case "$directory_owner" in 0|"$current_uid") ;; *) echo "$label executable directory must be owned by root or the current user" >&2; return 2 ;; esac
    fi
  fi

  executable_mode=$(read_stat_value '%Lp' '%a' "$resolved")
  directory_mode=$(read_stat_value '%Lp' '%a' "$executable_dir")
  if [ $((0$executable_mode & 022)) -ne 0 ]; then
    echo "$label executable must not be group or other writable" >&2
    return 2
  fi
  if [ $((0$directory_mode & 022)) -ne 0 ]; then
    echo "$label executable directory must not be group or other writable" >&2
    return 2
  fi
  if [ "$(read_stat_value '%l' '%h' "$resolved")" != 1 ]; then
    echo "$label executable must not be hard-linked" >&2
    return 2
  fi
  printf '%s\n' "$resolved"
}

for trusted_system_tool in "$stat_bin" "$id_bin" "$cat_bin" "$mktemp_bin" "$chmod_bin" "$mv_bin" "$rm_bin"; do
  if [ -L "$trusted_system_tool" ] || [ ! -f "$trusted_system_tool" ] || [ ! -x "$trusted_system_tool" ]; then
    echo "Required trusted system executable is unavailable" >&2
    exit 2
  fi
done
current_uid=$($id_bin -u)
systemctl_bin=$(resolve_trusted_executable "$systemctl_bin" "systemctl")
curl_bin=$(resolve_trusted_executable "$curl_bin" "curl")
node_bin=$(resolve_trusted_executable "$node_bin" "Node")

validate_private_managed_directory() {
  managed_directory=$1
  managed_label=$2
  managed_owner=$(read_stat_value '%u' '%u' "$managed_directory")
  managed_mode=$(read_stat_value '%Lp' '%a' "$managed_directory")
  if [ "$managed_owner" != "$current_uid" ]; then
    echo "$managed_label must be owned by the current user" >&2
    exit 1
  fi
  if [ $((0$managed_mode & 022)) -ne 0 ]; then
    echo "$managed_label must not be group or other writable" >&2
    exit 1
  fi
}

is_systemd_mapped_root_deployment_ancestor() {
  mapped_ancestor_owner=$1
  mapped_ancestor_path=$2
  [ "$mapped_ancestor_owner" = 65534 ] \
    && [ -n "${INVOCATION_ID:-}" ] \
    && { [ "$mapped_ancestor_path" = / ] || [ "$mapped_ancestor_path" = /home ]; }
}

validate_trusted_ancestor_directory() {
  ancestor_directory=$1
  ancestor_owner=$(read_stat_value '%u' '%u' "$ancestor_directory")
  ancestor_mode=$(read_stat_value '%Lp' '%a' "$ancestor_directory")
  case "$ancestor_owner" in
    0|"$current_uid") ;;
    *)
      if ! is_systemd_mapped_root_deployment_ancestor "$ancestor_owner" "$ancestor_directory"; then
        echo "Deployment path ancestor must be owned by root or the current user" >&2
        exit 1
      fi
      ;;
  esac
  if [ $((0$ancestor_mode & 022)) -ne 0 ] && [ $((0$ancestor_mode & 01000)) -eq 0 ]; then
    echo "Deployment path ancestor must not be shared writable without the sticky bit" >&2
    exit 1
  fi
}

case "$base_dir" in
  /*) ;;
  *) echo "Deployment directory path must be absolute" >&2; exit 2 ;;
esac
if [ -L "$base_dir" ] || [ ! -d "$base_dir" ]; then
  echo "Deployment directory must be a real directory, not a symlink" >&2
  exit 1
fi
current_link="$base_dir/current"
if [ ! -L "$current_link" ]; then
  echo "Current release must be a deployment-managed symlink" >&2
  exit 1
fi
revision_file="$current_link/DEPLOYED_COMMIT"
if [ -L "$revision_file" ] || [ ! -f "$revision_file" ]; then
  echo "Deployed revision file must be a regular file, not a symlink" >&2
  exit 1
fi
revision_owner=$(read_stat_value '%u' '%u' "$revision_file")
revision_links=$(read_stat_value '%l' '%h' "$revision_file")
revision_bytes=$(read_stat_value '%z' '%s' "$revision_file")
if [ "$revision_owner" != "$($id_bin -u)" ]; then
  echo "Deployed revision file must be owned by the current user" >&2
  exit 1
fi
if [ "$revision_links" != 1 ]; then
  echo "Deployed revision file must not be hard-linked" >&2
  exit 1
fi
if [ "$revision_bytes" -ne 41 ]; then
  echo "Deployed revision file must contain exactly one full Git commit SHA" >&2
  exit 1
fi
revision=$($cat_bin "$revision_file")
case "$revision" in
  *[!0-9a-f]*|'') echo "Deployed revision must be a full lowercase Git commit SHA" >&2; exit 1 ;;
esac
if [ "${#revision}" -ne 40 ]; then
  echo "Deployed revision must be a full lowercase Git commit SHA" >&2
  exit 1
fi

base_physical=$(cd "$base_dir" && pwd -P)
if [ "$base_physical" != "$base_dir" ]; then
  echo "Deployment directory path must be canonical and contain no symlinked ancestors" >&2
  exit 1
fi
validate_private_managed_directory "$base_physical" "Deployment directory"
operations_state_directory="$base_physical/operations-state"
if [ -L "$operations_state_directory" ] || [ ! -d "$operations_state_directory" ]; then
  echo "Operations state directory must be a real directory, not a symlink" >&2
  exit 1
fi
validate_private_managed_directory "$operations_state_directory" "Operations state directory"
operations_state_mode=$(read_stat_value '%Lp' '%a' "$operations_state_directory")
if [ $((0$operations_state_mode & 077)) -ne 0 ]; then
  echo "Operations state directory must be private" >&2
  exit 1
fi
releases_directory="$base_physical/releases"
if [ -L "$releases_directory" ] || [ ! -d "$releases_directory" ]; then
  echo "Release root must be a real directory, not a symlink" >&2
  exit 1
fi
validate_private_managed_directory "$releases_directory" "Release root"
ancestor_directory=${base_physical%/*}
[ -n "$ancestor_directory" ] || ancestor_directory=/
while :; do
  validate_trusted_ancestor_directory "$ancestor_directory"
  [ "$ancestor_directory" = / ] && break
  ancestor_directory=${ancestor_directory%/*}
  [ -n "$ancestor_directory" ] || ancestor_directory=/
done
expected_release="$base_physical/releases/$revision"
if [ -L "$expected_release" ] || [ ! -d "$expected_release" ]; then
  echo "Expected release must be a real directory, not a symlink" >&2
  exit 1
fi
active_release=$(cd "$current_link" && pwd -P)
if [ "$active_release" != "$expected_release" ]; then
  echo "Current release target does not match the deployed revision" >&2
  exit 1
fi
validate_private_managed_directory "$expected_release" "Active release directory"

read_private_counter() {
  counter_path=$1
  counter_label=$2
  counter_default=$3
  if [ ! -e "$counter_path" ] && [ ! -L "$counter_path" ]; then
    printf '%s\n' "$counter_default"
    return
  fi
  if [ -L "$counter_path" ] || [ ! -f "$counter_path" ]; then
    echo "$counter_label must be a regular file, not a symlink" >&2
    exit 1
  fi
  if [ "$(read_stat_value '%u' '%u' "$counter_path")" != "$current_uid" ] \
    || [ "$(read_stat_value '%l' '%h' "$counter_path")" != 1 ] \
    || [ $((0$(read_stat_value '%Lp' '%a' "$counter_path") & 077)) -ne 0 ]; then
    echo "$counter_label ownership is unsafe" >&2
    exit 1
  fi
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

recorded_crash=false
for service in ai-learning-os-api.service ai-learning-os-web.service; do
  crash_counter="$operations_state_directory/$service.crash-count"
  observed_counter="$operations_state_directory/$service.observed-crash-count"
  crash_count=$(read_private_counter "$crash_counter" "$service crash counter" 0)
  observed_count=$(read_private_counter "$observed_counter" "$service observed crash counter" 0)
  if [ "$observed_count" -gt "$crash_count" ]; then
    echo "$service observed crash counter exceeds recorded evidence" >&2
    exit 1
  fi
  if [ "$crash_count" -gt "$observed_count" ]; then
    new_crashes=$((crash_count - observed_count))
    echo "$service recorded $new_crashes unexpected process exit(s) since the last observation" >&2
    next_observed=$($mktemp_bin "$operations_state_directory/.$service.observed-crash-count.next.XXXXXX")
    trap '$rm_bin -f "$next_observed"' EXIT HUP INT TERM
    printf '%s\n' "$crash_count" > "$next_observed"
    $chmod_bin 600 "$next_observed"
    $mv_bin -f "$next_observed" "$observed_counter"
    next_observed=
    trap - EXIT HUP INT TERM
    recorded_crash=true
  fi
done
if [ "$recorded_crash" = true ]; then
  exit 1
fi

for service in ai-learning-os-api.service ai-learning-os-web.service; do
  if ! "$systemctl_bin" --user is-active --quiet "$service"; then
    echo "$service is not active" >&2
    exit 1
  fi
  restart_count=$("$systemctl_bin" --user show --property NRestarts --value "$service")
  case "$restart_count" in
    ''|*[!0-9]*) echo "$service restart count is unavailable" >&2; exit 1 ;;
  esac
  if [ "$restart_count" -ne 0 ]; then
    echo "$service restarted unexpectedly since activation" >&2
    exit 1
  fi
done

for service in \
  ai-learning-os-backup.service \
  ai-learning-os-backup-monitor.service \
  ai-learning-os-restore-drill.service \
  ai-learning-os-host-capacity-monitor.service; do
  if "$systemctl_bin" --user is-failed --quiet "$service"; then
    echo "$service is failed" >&2
    exit 1
  fi
done

for timer in \
  ai-learning-os-backup.timer \
  ai-learning-os-backup-monitor.timer \
  ai-learning-os-application-monitor.timer \
  ai-learning-os-restore-drill.timer \
  ai-learning-os-host-capacity-monitor.timer; do
  if ! "$systemctl_bin" --user is-enabled --quiet "$timer"; then
    echo "$timer is not enabled" >&2
    exit 1
  fi
  if ! "$systemctl_bin" --user is-active --quiet "$timer"; then
    echo "$timer is not active" >&2
    exit 1
  fi
done

if ! "$curl_bin" --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  --max-filesize 1048576 --output /dev/null "$web_url"; then
  echo "Web health probe failed" >&2
  exit 1
fi

if ! health_body=$("$curl_bin" --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  --max-filesize 1048576 "$api_url"); then
  echo "API health probe failed" >&2
  exit 1
fi
if ! printf '%s' "$health_body" | "$node_bin" -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    try {
      const health = JSON.parse(body);
      const expectedRevision = process.argv[1];
      const pool = health.databasePool;
      const validPool = pool !== null
        && Number.isSafeInteger(pool.limit) && pool.limit > 0
        && Number.isSafeInteger(pool.total) && pool.total >= 0 && pool.total <= pool.limit
        && Number.isSafeInteger(pool.idle) && pool.idle >= 0 && pool.idle <= pool.total
        && Number.isSafeInteger(pool.inUse) && pool.inUse === pool.total - pool.idle
        && Number.isSafeInteger(pool.waiting) && pool.waiting === 0
        && pool.saturated === false;
      if (health.status !== "ok"
        || health.releaseRevision !== expectedRevision
        || health.aiEnabled !== true
        || health.syncEnabled !== true
        || health.dependencies?.database !== "ready"
        || !validPool) process.exit(1);
    } catch {
      process.exit(1);
    }
  });
' "$revision"; then
  echo "API health response does not prove the active release is ready" >&2
  exit 1
fi

printf 'Application healthy at revision %s\n' "$revision"
