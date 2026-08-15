#!/bin/sh
set -eu

backup=${1:-}
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)

if [ "$#" -ne 1 ]; then
  echo "Usage: verify-backup.sh /absolute/path/to/ai-learning-os-<timestamp>-<suffix>.dump" >&2
  exit 2
fi
. "$script_dir/resolve-docker-bin.sh"
resolve_trusted_docker_bin
case "$backup" in
  /*) ;;
  *) echo "Backup path must be absolute" >&2; exit 2 ;;
esac
if [ -L "$backup" ] || [ ! -f "$backup" ]; then
  echo "Backup must be a regular file, not a symlink" >&2
  exit 2
fi

backup_dir=$(dirname "$backup")
backup_name=$(basename "$backup")
case "$backup_name" in
  ai-learning-os-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-*.dump) ;;
  *) echo "Backup filename does not match the managed backup format" >&2; exit 2 ;;
esac
if [ -L "$backup_dir" ] || [ ! -d "$backup_dir" ]; then
  echo "Backup directory must be a real directory, not a symlink" >&2
  exit 2
fi

owner_of() {
  owner=$(stat -f '%u' "$1" 2>/dev/null || true)
  case "$owner" in ''|*[!0-9]*) owner=$(stat -c '%u' "$1" 2>/dev/null || true) ;; esac
  case "$owner" in ''|*[!0-9]*) echo "Could not verify backup ownership" >&2; exit 2 ;; esac
  printf '%s\n' "$owner"
}

mode_of() {
  mode=$(stat -f '%Lp' "$1" 2>/dev/null || true)
  case "$mode" in ''|*[!0-7]*) mode=$(stat -c '%a' "$1" 2>/dev/null || true) ;; esac
  case "$mode" in ''|*[!0-7]*) echo "Could not verify backup permissions" >&2; exit 2 ;; esac
  printf '%s\n' "$mode"
}

links_of() {
  links=$(stat -f '%l' "$1" 2>/dev/null || true)
  case "$links" in ''|*[!0-9]*) links=$(stat -c '%h' "$1" 2>/dev/null || true) ;; esac
  case "$links" in ''|*[!0-9]*) echo "Could not verify backup link count" >&2; exit 2 ;; esac
  printf '%s\n' "$links"
}

if [ "$(owner_of "$backup_dir")" != "$(id -u)" ] || [ "$(owner_of "$backup")" != "$(id -u)" ]; then
  echo "Backup directory and file must be owned by the current user" >&2
  exit 2
fi
if [ $((0$(mode_of "$backup_dir") & 077)) -ne 0 ] || [ $((0$(mode_of "$backup") & 077)) -ne 0 ]; then
  echo "Backup directory and file must not grant group or other access" >&2
  exit 2
fi
if [ "$(links_of "$backup")" != 1 ]; then
  echo "Backup must not be hard-linked" >&2
  exit 2
fi

checksum_file="$backup.sha256"
if [ -L "$checksum_file" ] || [ ! -f "$checksum_file" ]; then
  echo "Backup checksum sidecar must be a regular file, not a symlink" >&2
  exit 2
fi
if [ "$(owner_of "$checksum_file")" != "$(id -u)" ] || [ $((0$(mode_of "$checksum_file") & 077)) -ne 0 ]; then
  echo "Backup checksum sidecar must be private and owned by the current user" >&2
  exit 2
fi
if [ "$(links_of "$checksum_file")" != 1 ]; then
  echo "Backup checksum sidecar must not be hard-linked" >&2
  exit 2
fi

expected_line=$(cat "$checksum_file")
case "$expected_line" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*"  $backup_name") ;;
  *) echo "Backup checksum sidecar has an invalid format or filename" >&2; exit 2 ;;
esac
expected_checksum=${expected_line%%  *}
case "$expected_checksum" in
  *[!0-9a-f]*|'') echo "Backup checksum sidecar has an invalid checksum" >&2; exit 2 ;;
esac
if [ "${#expected_checksum}" -ne 64 ]; then
  echo "Backup checksum sidecar has an invalid checksum" >&2
  exit 2
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum=$(sha256sum "$backup" | awk 'NR == 1 { print $1 }')
else
  actual_checksum=$(shasum -a 256 "$backup" | awk 'NR == 1 { print $1 }')
fi
if [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "Backup checksum verification failed" >&2
  exit 1
fi
if ! "$docker_bin" exec -i pg pg_restore --list < "$backup" >/dev/null; then
  echo "Backup failed PostgreSQL archive verification" >&2
  exit 1
fi

printf 'Verified backup %s (%s bytes)\n' "$backup_name" "$(wc -c < "$backup" | tr -d ' ')"
