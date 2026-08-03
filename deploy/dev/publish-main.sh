#!/bin/sh
set -eu

repository=${AI_LEARNING_REPOSITORY:-"https://github.com/chanchan0391/ai-learning-os.git"}
checkout_dir=${AI_LEARNING_CHECKOUT_DIR:-"$HOME/Library/Caches/ai-learning-os-deploy/repository"}
deploy_host=${AI_LEARNING_DEPLOY_HOST:-dev}
remote_base=${AI_LEARNING_REMOTE_BASE:-"/home/chanchan/services/ai-learning-os"}
lock_dir=${TMPDIR:-/tmp}/ai-learning-os-publish-main.lock

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another publisher is already running"
  exit 0
fi
temporary_archive=
cleanup() {
  if [ -n "$temporary_archive" ]; then rm -f "$temporary_archive"; fi
  rmdir "$lock_dir"
}
trap cleanup EXIT HUP INT TERM

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

deployed_revision=$(ssh "$deploy_host" "test -f '$remote_base/current/DEPLOYED_COMMIT' && cat '$remote_base/current/DEPLOYED_COMMIT' || true")
if [ "$deployed_revision" = "$revision" ]; then
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
ssh "$deploy_host" "mkdir -p '$remote_base/incoming'"
scp -q "$temporary_archive" "$deploy_host:$remote_base/incoming/$revision.tar.gz.uploading"
ssh "$deploy_host" "mv '$remote_base/incoming/$revision.tar.gz.uploading' '$remote_base/incoming/$revision.tar.gz' && '$remote_base/deploy-main.sh' '$revision' '$remote_base/incoming/$revision.tar.gz' '$archive_checksum'"
