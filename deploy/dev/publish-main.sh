#!/bin/sh
set -eu

repository=${AI_LEARNING_REPOSITORY:-"https://github.com/chanchan0391/ai-learning-os.git"}
checkout_dir=${AI_LEARNING_CHECKOUT_DIR:-"$HOME/Library/Caches/ai-learning-os-deploy/repository"}
deploy_host=${AI_LEARNING_DEPLOY_HOST:-dev}
remote_base=${AI_LEARNING_REMOTE_BASE:-"/home/chanchan/services/ai-learning-os"}
lock_file=${TMPDIR:-/tmp}/ai-learning-os-publish-main.lock
shlock_bin=${AI_LEARNING_SHLOCK_BIN:-$(command -v shlock || true)}
publisher_log=${AI_LEARNING_PUBLISH_LOG:-"$HOME/Library/Logs/ai-learning-os-deploy.log"}
publisher_log_max_bytes=${AI_LEARNING_PUBLISH_LOG_MAX_BYTES:-5242880}
ssh_options="-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"

if [ -z "$shlock_bin" ] || [ ! -x "$shlock_bin" ]; then
  echo "shlock is required for crash-safe publisher locking" >&2
  exit 1
fi
if ! "$shlock_bin" -f "$lock_file" -p $$; then
  echo "Another publisher is already running"
  exit 0
fi
temporary_archive=
cleanup() {
  if [ -n "$temporary_archive" ]; then rm -f "$temporary_archive"; fi
  rm -f "$lock_file"
}
trap cleanup EXIT HUP INT TERM

case "$publisher_log_max_bytes" in
  ''|*[!0-9]*|0) echo "AI_LEARNING_PUBLISH_LOG_MAX_BYTES must be a positive integer" >&2; exit 2 ;;
esac
if [ -f "$publisher_log" ] && [ ! -L "$publisher_log" ]; then
  publisher_log_bytes=$(wc -c < "$publisher_log")
  if [ "$publisher_log_bytes" -ge "$publisher_log_max_bytes" ]; then
    rm -f "$publisher_log.4"
    publisher_log_generation=3
    while [ "$publisher_log_generation" -ge 1 ]; do
      if [ -f "$publisher_log.$publisher_log_generation" ] && [ ! -L "$publisher_log.$publisher_log_generation" ]; then
        next_generation=$((publisher_log_generation + 1))
        mv "$publisher_log.$publisher_log_generation" "$publisher_log.$next_generation"
      fi
      publisher_log_generation=$((publisher_log_generation - 1))
    done
    mv "$publisher_log" "$publisher_log.1"
  fi
fi

if [ ! -d "$checkout_dir/.git" ]; then
  mkdir -p "$(dirname "$checkout_dir")"
  git clone --quiet --no-checkout "$repository" "$checkout_dir"
fi

cd "$checkout_dir"
git fetch --quiet origin main
revision=$(git rev-parse origin/main)
case "$revision" in
  *[!0-9a-f]* ) echo "origin/main did not resolve to a commit SHA" >&2; exit 2 ;;
esac
if [ "${#revision}" -ne 40 ]; then
  echo "origin/main did not resolve to a full commit SHA" >&2
  exit 2
fi

deployed_revision=$(ssh $ssh_options "$deploy_host" "test -f '$remote_base/current/DEPLOYED_COMMIT' && cat '$remote_base/current/DEPLOYED_COMMIT' || true")
if [ "$deployed_revision" = "$revision" ]; then
  # Re-enter the remote deployment runner even when the application release is
  # current. Its same-revision path repairs operational runners after a deploy
  # that activated successfully but was interrupted before runner refresh.
  ssh $ssh_options "$deploy_host" "'$remote_base/deploy-main.sh' '$revision'"
  exit 0
fi

temporary_archive=$(mktemp "${TMPDIR:-/tmp}/ai-learning-os-$revision.XXXXXX.tar.gz")
git archive --format=tar.gz --output="$temporary_archive" "$revision"
archive_checksum=$(shasum -a 256 "$temporary_archive" | awk 'NR == 1 { print $1 }')
case "$archive_checksum" in
  *[!0-9a-f]* ) echo "Could not calculate the archive SHA-256 checksum" >&2; exit 2 ;;
esac
if [ "${#archive_checksum}" -ne 64 ]; then
  echo "Could not calculate the full archive SHA-256 checksum" >&2
  exit 2
fi
ssh $ssh_options "$deploy_host" "mkdir -p '$remote_base/incoming'"
scp -q $ssh_options "$temporary_archive" "$deploy_host:$remote_base/incoming/$revision.tar.gz.uploading"
ssh $ssh_options "$deploy_host" "mv '$remote_base/incoming/$revision.tar.gz.uploading' '$remote_base/incoming/$revision.tar.gz' && '$remote_base/deploy-main.sh' '$revision' '$remote_base/incoming/$revision.tar.gz' '$archive_checksum'"
