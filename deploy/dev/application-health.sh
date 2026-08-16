#!/bin/sh
set -eu

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
systemctl_bin=${AI_LEARNING_SYSTEMCTL_BIN:-systemctl}
curl_bin=${AI_LEARNING_CURL_BIN:-curl}
node_bin=${AI_LEARNING_NODE_BIN:-"$HOME/.nvm/versions/node/v22.23.1/bin/node"}
# The system image is read-only in the monitor unit, so use its absolute stat
# binary to bootstrap ownership and permission checks without trusting PATH.
stat_bin=/usr/bin/stat
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

resolve_trusted_executable() {
  candidate=$1
  label=$2
  case "$candidate" in
    /*) resolved=$candidate ;;
    */*) echo "$label executable path must be absolute" >&2; return 2 ;;
    *)
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

  current_uid=$(id -u)
  executable_owner=$(read_stat_value '%u' '%u' "$resolved")
  directory_owner=$(read_stat_value '%u' '%u' "$executable_dir")
  case "$executable_owner" in 0|"$current_uid") ;; *) echo "$label executable must be owned by root or the current user" >&2; return 2 ;; esac
  case "$directory_owner" in 0|"$current_uid") ;; *) echo "$label executable directory must be owned by root or the current user" >&2; return 2 ;; esac

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

if [ -L "$stat_bin" ] || [ ! -f "$stat_bin" ] || [ ! -x "$stat_bin" ]; then
  echo "Trusted system stat executable is unavailable" >&2
  exit 2
fi
systemctl_bin=$(resolve_trusted_executable "$systemctl_bin" "systemctl")
curl_bin=$(resolve_trusted_executable "$curl_bin" "curl")
node_bin=$(resolve_trusted_executable "$node_bin" "Node")

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
if [ "$revision_owner" != "$(id -u)" ]; then
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
revision=$(cat "$revision_file")
case "$revision" in
  *[!0-9a-f]*|'') echo "Deployed revision must be a full lowercase Git commit SHA" >&2; exit 1 ;;
esac
if [ "${#revision}" -ne 40 ]; then
  echo "Deployed revision must be a full lowercase Git commit SHA" >&2
  exit 1
fi

base_physical=$(cd "$base_dir" && pwd -P)
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
release_owner=$(read_stat_value '%u' '%u' "$expected_release")
if [ "$release_owner" != "$(id -u)" ]; then
  echo "Active release directory must be owned by the current user" >&2
  exit 1
fi

for service in ai-learning-os-api.service ai-learning-os-web.service; do
  if ! "$systemctl_bin" --user is-active --quiet "$service"; then
    echo "$service is not active" >&2
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
