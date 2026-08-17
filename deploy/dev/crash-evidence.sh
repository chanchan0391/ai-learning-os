#!/bin/sh
set -eu
umask 077

base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
state_dir=${AI_LEARNING_OPERATIONS_STATE_DIR:-"$base_dir/operations-state"}
service=${1:-}
result=${SERVICE_RESULT:-unknown}
stat_bin=/usr/bin/stat
id_bin=/usr/bin/id
cat_bin=/bin/cat
mktemp_bin=/usr/bin/mktemp
chmod_bin=/bin/chmod
mv_bin=/bin/mv
rm_bin=/bin/rm
flock_bin=${AI_LEARNING_FLOCK_BIN:-/usr/bin/flock}

case "$service" in
  ai-learning-os-api.service|ai-learning-os-web.service) ;;
  *) echo "Crash evidence service is not managed" >&2; exit 2 ;;
esac

# A deliberate stop or restart is successful from systemd's perspective and
# must not be reported as a crash. Every other terminal result is counted.
[ "$result" != success ] || exit 0

read_stat_value() {
  bsd_format=$1
  gnu_format=$2
  target=$3
  value=$($stat_bin -f "$bsd_format" "$target" 2>/dev/null || true)
  case "$value" in ''|*[!0-9]*) value=$($stat_bin -c "$gnu_format" "$target" 2>/dev/null || true) ;; esac
  case "$value" in ''|*[!0-9]*) echo "Crash evidence metadata is unavailable" >&2; exit 1 ;; esac
  printf '%s\n' "$value"
}

if [ -L "$state_dir" ] || [ ! -d "$state_dir" ]; then
  echo "Crash evidence directory must be a real directory" >&2
  exit 1
fi
if [ "$(read_stat_value '%u' '%u' "$state_dir")" != "$($id_bin -u)" ]; then
  echo "Crash evidence directory must be owned by the current user" >&2
  exit 1
fi
state_mode=$(read_stat_value '%Lp' '%a' "$state_dir")
if [ $((0$state_mode & 077)) -ne 0 ]; then
  echo "Crash evidence directory must be private" >&2
  exit 1
fi

if [ -L "$flock_bin" ] || [ ! -f "$flock_bin" ] || [ ! -x "$flock_bin" ]; then
  echo "Crash evidence lock helper is unavailable" >&2
  exit 2
fi
lock_file="$state_dir/crash-evidence.lock"
if [ -L "$lock_file" ] || [ ! -f "$lock_file" ]; then
  echo "Crash evidence lock must be a regular file" >&2
  exit 1
fi
if [ "$(read_stat_value '%u' '%u' "$lock_file")" != "$($id_bin -u)" ] \
  || [ "$(read_stat_value '%l' '%h' "$lock_file")" != 1 ] \
  || [ $((0$(read_stat_value '%Lp' '%a' "$lock_file") & 077)) -ne 0 ]; then
  echo "Crash evidence lock ownership is unsafe" >&2
  exit 1
fi
exec 8>>"$lock_file"
if ! "$flock_bin" -w 5 8; then
  echo "Crash evidence lock timed out" >&2
  exit 1
fi

counter_file="$state_dir/$service.crash-count"
counter=0
if [ -e "$counter_file" ] || [ -L "$counter_file" ]; then
  if [ -L "$counter_file" ] || [ ! -f "$counter_file" ]; then
    echo "Crash evidence counter must be a regular file" >&2
    exit 1
  fi
  if [ "$(read_stat_value '%u' '%u' "$counter_file")" != "$($id_bin -u)" ] \
    || [ "$(read_stat_value '%l' '%h' "$counter_file")" != 1 ] \
    || [ $((0$(read_stat_value '%Lp' '%a' "$counter_file") & 077)) -ne 0 ]; then
    echo "Crash evidence counter ownership is unsafe" >&2
    exit 1
  fi
  if [ "$(read_stat_value '%z' '%s' "$counter_file")" -gt 17 ]; then
    echo "Crash evidence counter is invalid" >&2
    exit 1
  fi
  counter=$($cat_bin "$counter_file")
  case "$counter" in ''|*[!0-9]*) echo "Crash evidence counter is invalid" >&2; exit 1 ;; esac
fi
if [ "$counter" -ge 9007199254740991 ]; then
  echo "Crash evidence counter is exhausted" >&2
  exit 1
fi

next_file=$($mktemp_bin "$state_dir/.$service.crash-count.next.XXXXXX")
trap '$rm_bin -f "$next_file"' EXIT HUP INT TERM
printf '%s\n' "$((counter + 1))" > "$next_file"
$chmod_bin 600 "$next_file"
$mv_bin -f "$next_file" "$counter_file"
next_file=
trap - EXIT HUP INT TERM
printf '%s recorded an unexpected process exit\n' "$service" >&2
