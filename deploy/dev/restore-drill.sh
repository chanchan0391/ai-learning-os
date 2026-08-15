#!/bin/sh
set -eu

backup=${1:-}
docker_bin=${AI_LEARNING_DOCKER_BIN:-docker}
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
verify_runner=${AI_LEARNING_VERIFY_BACKUP_BIN:-"$script_dir/verify-backup.sh"}
database=
cleanup_required=false

if [ "$#" -ne 1 ]; then
  echo "Usage: restore-drill.sh /absolute/path/to/ai-learning-os-<timestamp>-<suffix>.dump" >&2
  exit 2
fi
if [ ! -f "$verify_runner" ] || [ -L "$verify_runner" ] || [ ! -x "$verify_runner" ]; then
  echo "Backup verification runner is missing or unsafe" >&2
  exit 2
fi

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$cleanup_required" = true ]; then
    if ! "$docker_bin" exec pg dropdb --if-exists --force -U postgres "$database"; then
      echo "Restore drill could not remove isolated database $database" >&2
      exit 1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

"$verify_runner" "$backup"

timestamp=$(date -u +%Y%m%d%H%M%S)
database="ai_learning_os_restore_${timestamp}_$$"
case "$database" in
  *[!a-z0-9_]*) echo "Could not create a safe isolated database name" >&2; exit 1 ;;
esac

existing_database=$("$docker_bin" exec pg psql -U postgres -d postgres -Atqc \
  "SELECT 1 FROM pg_database WHERE datname = '$database'")
case "$existing_database" in
  '') ;;
  1) echo "Refusing to reuse an existing restore drill database" >&2; exit 1 ;;
  *) echo "Restore drill database preflight returned an invalid result" >&2; exit 1 ;;
esac

"$docker_bin" exec pg createdb -U postgres "$database"
cleanup_required=true

if ! "$docker_bin" exec -i pg pg_restore --exit-on-error --no-owner --no-privileges \
  -U postgres -d "$database" < "$backup"; then
  echo "Backup failed isolated PostgreSQL restore" >&2
  exit 1
fi

metrics=$("$docker_bin" exec pg psql -U postgres -d "$database" -AtF '|' -v ON_ERROR_STOP=1 -c "
DO \$\$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL
    OR to_regclass('public.users') IS NULL
    OR to_regclass('public.learning_plans') IS NULL
    OR to_regclass('public.daily_records') IS NULL THEN
    RAISE EXCEPTION 'restore drill is missing required application tables';
  END IF;
END
\$\$;
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'),
  (SELECT count(*) FROM schema_migrations),
  (SELECT count(*) FROM users),
  (SELECT count(*) FROM learning_plans),
  (SELECT count(*) FROM daily_records);
")
metrics=$(printf '%s\n' "$metrics" | tail -n 1)
old_ifs=$IFS
IFS='|'
set -- $metrics
IFS=$old_ifs
if [ "$#" -ne 5 ]; then
  echo "Restore drill returned invalid verification metrics" >&2
  exit 1
fi
for metric in "$@"; do
  case "$metric" in
    ''|*[!0-9]*) echo "Restore drill returned invalid verification metrics" >&2; exit 1 ;;
  esac
done
tables=$1
migrations=$2
users=$3
plans=$4
records=$5

printf 'Restore drill passed: %s public tables, %s migrations, %s users, %s plans, %s daily records\n' \
  "$tables" "$migrations" "$users" "$plans" "$records"
