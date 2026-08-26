#!/bin/sh
set -eu
umask 077

monitor=${1:-}
base_dir=${AI_LEARNING_DEPLOY_DIR:-"$HOME/services/ai-learning-os"}
state_dir=${AI_LEARNING_OPERATIONS_STATE_DIR:-"$base_dir/operations-state"}
stat_bin=/usr/bin/stat
id_bin=/usr/bin/id
date_bin=/bin/date
mktemp_bin=/usr/bin/mktemp
chmod_bin=/bin/chmod
mv_bin=/bin/mv
rm_bin=/bin/rm

case "$monitor" in
  backup-monitor|restore-drill|host-capacity-monitor) ;;
  *) echo "Monitor success recorder requires a supported monitor name" >&2; exit 2 ;;
esac
if [ "$#" -ne 1 ]; then
  echo "Usage: record-monitor-success.sh <backup-monitor|restore-drill|host-capacity-monitor>" >&2
  exit 2
fi

read_stat_value() {
  bsd_format=$1
  gnu_format=$2
  target=$3
  value=$($stat_bin -f "$bsd_format" "$target" 2>/dev/null || true)
  case "$value" in ''|*[!0-9]*) value=$($stat_bin -c "$gnu_format" "$target" 2>/dev/null || true) ;; esac
  case "$value" in ''|*[!0-9]*) echo "Monitor success metadata is unavailable" >&2; exit 1 ;; esac
  printf '%s\n' "$value"
}

for trusted_tool in "$stat_bin" "$id_bin" "$date_bin" "$mktemp_bin" "$chmod_bin" "$mv_bin" "$rm_bin"; do
  if [ -L "$trusted_tool" ] || [ ! -f "$trusted_tool" ] || [ ! -x "$trusted_tool" ]; then
    echo "Required trusted system executable is unavailable" >&2
    exit 2
  fi
done

case "$state_dir" in
  /*) ;;
  *) echo "Operations state directory path must be absolute" >&2; exit 2 ;;
esac
if [ -L "$state_dir" ] || [ ! -d "$state_dir" ]; then
  echo "Operations state directory must be a real directory" >&2
  exit 1
fi
current_uid=$($id_bin -u)
if [ "$(read_stat_value '%u' '%u' "$state_dir")" != "$current_uid" ] \
  || [ $((0$(read_stat_value '%Lp' '%a' "$state_dir") & 077)) -ne 0 ]; then
  echo "Operations state directory ownership is unsafe" >&2
  exit 1
fi

success_file="$state_dir/$monitor-last-success-unixtime"
if [ -e "$success_file" ] || [ -L "$success_file" ]; then
  if [ -L "$success_file" ] || [ ! -f "$success_file" ] \
    || [ "$(read_stat_value '%u' '%u' "$success_file")" != "$current_uid" ] \
    || [ "$(read_stat_value '%l' '%h' "$success_file")" != 1 ] \
    || [ $((0$(read_stat_value '%Lp' '%a' "$success_file") & 077)) -ne 0 ]; then
    echo "Monitor success file ownership is unsafe" >&2
    exit 1
  fi
fi

success_time=$($date_bin +%s)
case "$success_time" in ''|*[!0-9]*) echo "Monitor success time is unavailable" >&2; exit 1 ;; esac
if [ "$success_time" -gt 9007199254740991 ]; then
  echo "Monitor success time is invalid" >&2
  exit 1
fi

success_stage=$($mktemp_bin "$state_dir/.$monitor-last-success-unixtime.next.XXXXXX")
trap '$rm_bin -f "$success_stage"' EXIT HUP INT TERM
printf '%s\n' "$success_time" > "$success_stage"
$chmod_bin 600 "$success_stage"
$mv_bin -f "$success_stage" "$success_file"
success_stage=
trap - EXIT HUP INT TERM
