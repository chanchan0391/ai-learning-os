#!/bin/sh
set -eu

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
repository=${AI_LEARNING_REPOSITORY:-"https://github.com/chanchan0391/ai-learning-os.git"}
node_bin=${AI_LEARNING_NODE_BIN:-"$HOME/.nvm/versions/node/v22.23.1/bin/node"}
npm_bin=${AI_LEARNING_NPM_BIN:-"$HOME/.nvm/versions/node/v22.23.1/bin/npm"}
stat_bin=${AI_LEARNING_STAT_BIN:-stat}
requested_revision=${1:-}
provided_archive=${2:-}
provided_checksum=${3:-}
temporary_dir=
managed_archive=
operational_stage=

read_file_owner() {
  file_path=$1
  file_owner=$($stat_bin -f '%u' "$file_path" 2>/dev/null || true)
  case "$file_owner" in
    ''|*[!0-9]*) file_owner=$($stat_bin -c '%u' "$file_path" 2>/dev/null || true) ;;
  esac
  printf '%s\n' "$file_owner"
}

read_file_links() {
  file_path=$1
  file_links=$($stat_bin -f '%l' "$file_path" 2>/dev/null || true)
  case "$file_links" in
    ''|*[!0-9]*) file_links=$($stat_bin -c '%h' "$file_path" 2>/dev/null || true) ;;
  esac
  printf '%s\n' "$file_links"
}

validate_owned_directory() {
  directory_path=$1
  directory_label=$2
  if [ -L "$directory_path" ] || [ ! -d "$directory_path" ]; then
    echo "$directory_label must be a real directory, not a symlink" >&2
    return 1
  fi
  directory_owner=$(read_file_owner "$directory_path")
  case "$directory_owner" in
    ''|*[!0-9]*) echo "Could not verify $directory_label ownership" >&2; return 1 ;;
  esac
  if [ "$directory_owner" != "$(id -u)" ]; then
    echo "$directory_label must be owned by the deployment user" >&2
    return 1
  fi
}

validate_owned_regular_file() {
  file_path=$1
  file_label=$2
  if [ -L "$file_path" ] || [ ! -f "$file_path" ]; then
    echo "$file_label must be a regular file, not a symlink" >&2
    return 1
  fi
  file_owner=$(read_file_owner "$file_path")
  case "$file_owner" in
    ''|*[!0-9]*) echo "Could not verify $file_label ownership" >&2; return 1 ;;
  esac
  if [ "$file_owner" != "$(id -u)" ]; then
    echo "$file_label must be owned by the deployment user" >&2
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

cleanup() {
  if [ -n "$temporary_dir" ]; then rm -rf "$temporary_dir"; fi
  if [ -n "$managed_archive" ]; then rm -f "$managed_archive"; fi
  if [ -n "$operational_stage" ]; then rm -f "$operational_stage"; fi
}

update_operational_runners() {
  for runner in deploy-main.sh backup.sh backup-health.sh application-health.sh host-capacity.sh verify-backup.sh restore-drill.sh resolve-docker-bin.sh; do
    candidate=$current_link/deploy/dev/$runner
    validate_owned_regular_file "$candidate" "Active release $runner" || return 1
  done
  for runner in deploy-main.sh backup.sh backup-health.sh application-health.sh host-capacity.sh verify-backup.sh restore-drill.sh resolve-docker-bin.sh; do
    candidate=$current_link/deploy/dev/$runner
    installed_runner=$base_dir/$runner
    if [ -e "$installed_runner" ] || [ -L "$installed_runner" ]; then
      validate_owned_regular_file "$installed_runner" "Installed $runner" || return 1
    fi
    if [ -f "$installed_runner" ] && [ ! -L "$installed_runner" ] \
      && [ -x "$installed_runner" ] && cmp -s "$candidate" "$installed_runner"; then
      continue
    fi
    operational_stage=$(mktemp "$base_dir/.$runner.next.XXXXXX")
    install -m 0755 "$candidate" "$operational_stage"
    validate_owned_regular_file "$operational_stage" "Staged $runner" || return 1
    mv -f "$operational_stage" "$installed_runner"
    operational_stage=
  done
}

discard_failed_release() {
  failed_release=$1
  active_release=
  if [ -L "$current_link" ]; then
    active_release=$(readlink -f "$current_link")
  fi
  if [ -n "$active_release" ] && [ "$active_release" = "$(readlink -f "$failed_release")" ]; then
    echo "Refusing to remove the active release after a failed deployment" >&2
    return 1
  fi
  case "$failed_release" in
    "$base_dir"/releases/"$revision")
      validate_owned_directory "$failed_release" "Failed release directory" || return 1
      rm -rf "$failed_release"
      ;;
    *) echo "Refusing to remove unexpected failed release path: $failed_release" >&2; return 1 ;;
  esac
}

service_uses_selected_node() {
  service_name=$1
  service_pid=$(systemctl --user show --property MainPID --value "$service_name")
  [ "$service_pid" -gt 0 ] 2>/dev/null \
    && [ "$(readlink -f "/proc/$service_pid/exe")" = "$(readlink -f "$node_bin")" ]
}

deployment_is_healthy() {
  expected_revision=$1
  systemctl --user is-active --quiet ai-learning-os-api.service ai-learning-os-web.service \
    && service_uses_selected_node ai-learning-os-api.service \
    && service_uses_selected_node ai-learning-os-web.service \
    && curl --fail --silent --show-error --connect-timeout 2 --max-time 5 http://127.0.0.1:8088/ >/dev/null \
    && curl --fail --silent --show-error --connect-timeout 2 --max-time 5 http://127.0.0.1:8787/api/health \
    | "$node_bin" -e '
      let body = "";
      process.stdin.on("data", (chunk) => body += chunk);
      process.stdin.on("end", () => {
        const health = JSON.parse(body);
        const expectedRevision = process.argv[1];
        if (health.status !== "ok" || health.releaseRevision !== expectedRevision || !health.aiEnabled || !health.syncEnabled) process.exit(1);
      });
    ' "$expected_revision"
}

wait_for_healthy_deployment() {
  expected_revision=$1
  attempt=1
  while [ "$attempt" -le 30 ]; do
    if deployment_is_healthy "$expected_revision"; then return 0; fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
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

case "$base_dir" in
  /*) ;;
  *) echo "Deployment directory path must be absolute" >&2; exit 2 ;;
esac
if [ -L "$base_dir" ]; then
  echo "Deployment directory must be a real directory, not a symlink" >&2
  exit 1
fi
mkdir -p "$base_dir"
validate_owned_directory "$base_dir" "Deployment directory"
for managed_directory in releases deploy-logs incoming; do
  managed_path="$base_dir/$managed_directory"
  if [ -L "$managed_path" ]; then
    echo "Managed deployment directory must be a real directory, not a symlink: $managed_path" >&2
    exit 1
  fi
  mkdir -p "$managed_path"
  validate_owned_directory "$managed_path" "Managed deployment directory"
done
deploy_lock="$base_dir/deploy.lock"
if [ -e "$deploy_lock" ]; then
  validate_owned_regular_file "$deploy_lock" "Deployment lock"
  chmod 600 "$deploy_lock"
elif [ -L "$deploy_lock" ]; then
  echo "Deployment lock must be a regular file, not a symlink" >&2
  exit 1
fi
umask 077
exec 9>>"$deploy_lock"
if ! flock -n 9; then
  echo "Another deployment is already running"
  exit 0
fi
trap cleanup EXIT HUP INT TERM

# A publisher interruption can leave a partial upload, while a deployment that
# never starts can leave a complete archive. Keep only recent retry candidates
# so successive failed revisions cannot consume the dev host indefinitely.
find "$base_dir/incoming" -maxdepth 1 -type f \
  \( -name '*.tar.gz' -o -name '*.tar.gz.uploading' \) -mtime +1 -delete

# A non-catchable termination or host restart can bypass the EXIT trap after
# extraction or npm install. Reclaim only old workspaces created by this script;
# the deployment lock ensures a live deployment cannot be pruned concurrently.
find "$base_dir/releases" -mindepth 1 -maxdepth 1 -type d -name '.deploy-*' -mtime +1 -print \
  | while IFS= read -r stale_workspace; do
      case "$stale_workspace" in
        "$base_dir"/releases/.deploy-*)
          validate_owned_directory "$stale_workspace" "Stale deployment workspace" || exit 1
          rm -rf "$stale_workspace"
          ;;
        *) echo "Refusing to prune unexpected workspace: $stale_workspace" >&2; exit 1 ;;
      esac
    done

if [ -n "$provided_archive" ]; then
  expected_archive="$base_dir/incoming/$revision.tar.gz"
  if [ "$provided_archive" != "$expected_archive" ] || [ ! -f "$provided_archive" ] || [ -L "$provided_archive" ]; then
    echo "Provided archive must be the expected incoming revision archive" >&2
    exit 2
  fi
  managed_archive=$provided_archive
fi

current_link="$base_dir/current"
current_revision=
if [ -f "$current_link/DEPLOYED_COMMIT" ]; then
  current_revision=$(cat "$current_link/DEPLOYED_COMMIT")
fi
if [ "$current_revision" = "$revision" ]; then
  update_operational_runners
  if deployment_is_healthy "$revision"; then
    echo "Revision $revision is already deployed and healthy"
    exit 0
  fi
  echo "Revision $revision is current but unhealthy; restarting services"
  systemctl --user restart ai-learning-os-api.service ai-learning-os-web.service
  if wait_for_healthy_deployment "$revision"; then
    echo "Reconciled revision $revision successfully"
    exit 0
  fi
  echo "Health reconciliation failed for current revision $revision" >&2
  exit 1
fi

release_dir="$base_dir/releases/$revision"
temporary_dir=$(mktemp -d "$base_dir/releases/.deploy-$revision.XXXXXX")
previous_target=
if [ -L "$current_link" ]; then
  previous_target=$(readlink -f "$current_link")
fi

if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
  case "$release_dir" in
    "$base_dir"/releases/"$revision")
      validate_owned_directory "$release_dir" "Existing release directory"
      rm -rf "$release_dir"
      ;;
    *) echo "Refusing to replace unexpected release path: $release_dir" >&2; exit 1 ;;
  esac
fi

if [ -n "$provided_archive" ]; then
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
  managed_archive=
else
  archive_url="https://github.com/chanchan0391/ai-learning-os/archive/$revision.tar.gz"
  curl --fail --location --silent --show-error --retry 3 \
    --connect-timeout 10 --max-time 120 --speed-limit 1024 --speed-time 30 "$archive_url" \
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
temporary_dir=

next_link="$base_dir/.current-$revision"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$current_link"

systemctl --user restart ai-learning-os-api.service ai-learning-os-web.service

if ! wait_for_healthy_deployment "$revision"; then
  echo "Health check failed for $revision; rolling back" >&2
  if [ -n "$previous_target" ] && [ -d "$previous_target" ]; then
    rollback_link="$base_dir/.rollback-$revision"
    ln -s "$previous_target" "$rollback_link"
    mv -Tf "$rollback_link" "$current_link"
    systemctl --user restart ai-learning-os-api.service ai-learning-os-web.service
    if wait_for_healthy_deployment "$current_revision"; then
      echo "Rolled back to $current_revision and verified service health" >&2
    else
      echo "Rollback to $current_revision did not restore service health" >&2
    fi
  else
    rm -f "$current_link"
    systemctl --user stop ai-learning-os-web.service ai-learning-os-api.service
  fi
  discard_failed_release "$release_dir"
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
          "$base_dir"/releases/*)
            validate_owned_directory "$stale_release" "Stale release directory" || exit 1
            rm -rf "$stale_release"
            ;;
          *) echo "Refusing to prune unexpected path: $stale_release" >&2; exit 1 ;;
        esac
      fi
    done

update_operational_runners
echo "Deployed $revision successfully"
