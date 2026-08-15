#!/bin/sh
set -eu

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
systemctl_bin=${AI_LEARNING_SYSTEMCTL_BIN:-systemctl}
curl_bin=${AI_LEARNING_CURL_BIN:-curl}
node_bin=${AI_LEARNING_NODE_BIN:-"$HOME/.nvm/versions/node/v22.23.1/bin/node"}
web_url=${AI_LEARNING_WEB_HEALTH_URL:-http://127.0.0.1:8088/}
api_url=${AI_LEARNING_API_HEALTH_URL:-http://127.0.0.1:8787/api/health}

case "$base_dir" in
  /*) ;;
  *) echo "Deployment directory path must be absolute" >&2; exit 2 ;;
esac
if [ -L "$base_dir" ] || [ ! -d "$base_dir" ]; then
  echo "Deployment directory must be a real directory, not a symlink" >&2
  exit 1
fi
if [ ! -x "$node_bin" ]; then
  echo "Selected Node binary is not executable" >&2
  exit 2
fi

revision_file="$base_dir/current/DEPLOYED_COMMIT"
if [ -L "$revision_file" ] || [ ! -f "$revision_file" ]; then
  echo "Deployed revision file must be a regular file, not a symlink" >&2
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
