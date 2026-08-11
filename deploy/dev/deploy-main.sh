#!/bin/sh
set -eu

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
repository=${AI_LEARNING_REPOSITORY:-"https://github.com/chanchan0391/ai-learning-os.git"}
node_bin=${AI_LEARNING_NODE_BIN:-"$HOME/.nvm/versions/node/v22.23.1/bin/node"}
npm_bin=${AI_LEARNING_NPM_BIN:-"$HOME/.nvm/versions/node/v22.23.1/bin/npm"}
requested_revision=${1:-}
provided_archive=${2:-}
provided_checksum=${3:-}

update_deploy_runner() {
  candidate=$current_link/deploy/dev/deploy-main.sh
  if [ ! -f "$candidate" ]; then
    echo "Active release does not contain the deploy runner" >&2
    return 1
  fi
  staged_runner="$base_dir/.deploy-main.next"
  install -m 0755 "$candidate" "$staged_runner"
  mv -f "$staged_runner" "$base_dir/deploy-main.sh"
}

service_uses_selected_node() {
  service_name=$1
  service_pid=$(systemctl --user show --property MainPID --value "$service_name")
  [ "$service_pid" -gt 0 ] 2>/dev/null \
    && [ "$(readlink -f "/proc/$service_pid/exe")" = "$(readlink -f "$node_bin")" ]
}

case "$requested_revision" in
  "") revision=$(git ls-remote "$repository" refs/heads/main | awk 'NR == 1 { print $1 }') ;;
  *[!0-9a-f]* ) echo "Revision must be a full lowercase Git commit SHA" >&2; exit 2 ;;
  *) revision=$requested_revision ;;
esac

if [ "${#revision}" -ne 40 ]; then
  echo "Could not resolve a full main revision" >&2
  exit 2
fi

mkdir -p "$base_dir/releases" "$base_dir/deploy-logs"
exec 9>"$base_dir/deploy.lock"
if ! flock -n 9; then
  echo "Another deployment is already running"
  exit 0
fi

current_link="$base_dir/current"
current_revision=
if [ -f "$current_link/DEPLOYED_COMMIT" ]; then
  current_revision=$(cat "$current_link/DEPLOYED_COMMIT")
fi
if [ "$current_revision" = "$revision" ]; then
  update_deploy_runner
  echo "Revision $revision is already deployed"
  exit 0
fi

release_dir="$base_dir/releases/$revision"
temporary_dir=$(mktemp -d "$base_dir/releases/.deploy-$revision.XXXXXX")
previous_target=
if [ -L "$current_link" ]; then
  previous_target=$(readlink -f "$current_link")
fi
cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

if [ -e "$release_dir" ]; then
  case "$release_dir" in
    "$base_dir"/releases/"$revision") rm -rf "$release_dir" ;;
    *) echo "Refusing to replace unexpected release path: $release_dir" >&2; exit 1 ;;
  esac
fi

if [ -n "$provided_archive" ]; then
  expected_archive="$base_dir/incoming/$revision.tar.gz"
  if [ "$provided_archive" != "$expected_archive" ] || [ ! -f "$provided_archive" ]; then
    echo "Provided archive must be the expected incoming revision archive" >&2
    exit 2
  fi
  case "$provided_checksum" in
    ""|*[!0-9a-f]*) echo "A lowercase SHA-256 checksum is required for an uploaded archive" >&2; exit 2 ;;
  esac
  if [ "${#provided_checksum}" -ne 64 ]; then
    echo "A full SHA-256 checksum is required for an uploaded archive" >&2
    exit 2
  fi
  actual_checksum=$(sha256sum "$provided_archive" | awk 'NR == 1 { print $1 }')
  if [ "$actual_checksum" != "$provided_checksum" ]; then
    echo "Uploaded archive checksum does not match" >&2
    exit 2
  fi
  tar -xzf "$provided_archive" -C "$temporary_dir"
  rm -f "$provided_archive"
else
  archive_url="https://github.com/chanchan0391/ai-learning-os/archive/$revision.tar.gz"
  curl --fail --location --silent --show-error --retry 3 "$archive_url" \
    | tar -xz --strip-components=1 -C "$temporary_dir"
fi

cd "$temporary_dir"
PATH=$(dirname "$node_bin"):$PATH
export PATH
if [ "$(command -v node)" != "$node_bin" ]; then
  echo "Selected Node binary is not first on PATH" >&2
  exit 1
fi
echo "Using $("$node_bin" --version) with $("$npm_bin" --version)"
"$npm_bin" ci
"$npm_bin" run check

# Back up before any migration. Database migrations must remain backward-compatible
# so the previous application release can run if activation is rolled back.
"$base_dir/backup.sh"
"$node_bin" --env-file="$base_dir/app.env" --import tsx server/sync/migrate.ts

printf '%s\n' "$revision" > DEPLOYED_COMMIT
chmod -R u=rwX,go=rX "$temporary_dir"
mv "$temporary_dir" "$release_dir"
trap - EXIT HUP INT TERM

next_link="$base_dir/.current-$revision"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$current_link"

systemctl --user restart ai-learning-os-api.service ai-learning-os-web.service

healthy=false
attempt=1
while [ "$attempt" -le 30 ]; do
  if systemctl --user is-active --quiet ai-learning-os-api.service ai-learning-os-web.service \
    && service_uses_selected_node ai-learning-os-api.service \
    && service_uses_selected_node ai-learning-os-web.service \
    && curl --fail --silent --show-error http://127.0.0.1:8088/ >/dev/null \
    && curl --fail --silent --show-error http://127.0.0.1:8787/api/health \
    | "$node_bin" -e '
      let body = "";
      process.stdin.on("data", (chunk) => body += chunk);
      process.stdin.on("end", () => {
        const health = JSON.parse(body);
        const expectedRevision = process.argv[1];
        if (health.status !== "ok" || health.releaseRevision !== expectedRevision || !health.aiEnabled || !health.syncEnabled) process.exit(1);
      });
    ' "$revision"
  then
    healthy=true
    break
  fi
  sleep 1
  attempt=$((attempt + 1))
done

if [ "$healthy" != true ]; then
  echo "Health check failed for $revision; rolling back" >&2
  if [ -n "$previous_target" ] && [ -d "$previous_target" ]; then
    rollback_link="$base_dir/.rollback-$revision"
    ln -s "$previous_target" "$rollback_link"
    mv -Tf "$rollback_link" "$current_link"
    systemctl --user restart ai-learning-os-api.service ai-learning-os-web.service
  else
    rm -f "$current_link"
    systemctl --user stop ai-learning-os-web.service ai-learning-os-api.service
  fi
  exit 1
fi

# Keep the active release plus the two most recent inactive releases.
active_target=$(readlink -f "$current_link")
find "$base_dir/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.deploy-*' -printf '%T@ %p\n' \
  | sort -nr \
  | awk 'NR > 3 { sub(/^[^ ]+ /, ""); print }' \
  | while IFS= read -r stale_release; do
      if [ -n "$stale_release" ] && [ "$stale_release" != "$active_target" ]; then
        case "$stale_release" in
          "$base_dir"/releases/*) rm -rf "$stale_release" ;;
          *) echo "Refusing to prune unexpected path: $stale_release" >&2; exit 1 ;;
        esac
      fi
    done

update_deploy_runner
echo "Deployed $revision successfully"
