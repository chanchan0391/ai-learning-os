#!/bin/sh

is_systemd_mapped_root_docker() {
  mapped_file_owner=$1
  mapped_dir_owner=$2
  mapped_docker_path=$3
  mapped_docker_dir=$4
  [ "$mapped_file_owner" = 65534 ] \
    && [ "$mapped_dir_owner" = 65534 ] \
    && [ -n "${INVOCATION_ID:-}" ] \
    && [ "$mapped_docker_path" = /usr/bin/docker ] \
    && [ "$mapped_docker_dir" = /usr/bin ]
}

resolve_trusted_docker_bin() {
  candidate=${AI_LEARNING_DOCKER_BIN:-docker}
  case "$candidate" in
    /*) docker_bin=$candidate ;;
    */*) echo "Docker executable path must be absolute" >&2; return 2 ;;
    *)
      docker_bin=$(command -v "$candidate" 2>/dev/null || true)
      case "$docker_bin" in
        /*) ;;
        *) echo "Could not resolve Docker executable to an absolute path" >&2; return 2 ;;
      esac
      ;;
  esac

  docker_bin_dir=$(dirname "$docker_bin")
  if [ -L "$docker_bin_dir" ] || [ ! -d "$docker_bin_dir" ]; then
    echo "Docker executable directory must be a real directory, not a symlink" >&2
    return 2
  fi
  if [ ! -f "$docker_bin" ] || [ -L "$docker_bin" ] || [ ! -x "$docker_bin" ]; then
    echo "Docker executable is missing or unsafe" >&2
    return 2
  fi

  docker_owner=$(stat -f '%u' "$docker_bin" 2>/dev/null || true)
  case "$docker_owner" in ''|*[!0-9]*) docker_owner=$(stat -c '%u' "$docker_bin" 2>/dev/null || true) ;; esac
  case "$docker_owner" in ''|*[!0-9]*) echo "Could not verify Docker executable ownership" >&2; return 2 ;; esac
  docker_dir_owner=$(stat -f '%u' "$docker_bin_dir" 2>/dev/null || true)
  case "$docker_dir_owner" in ''|*[!0-9]*) docker_dir_owner=$(stat -c '%u' "$docker_bin_dir" 2>/dev/null || true) ;; esac
  case "$docker_dir_owner" in ''|*[!0-9]*) echo "Could not verify Docker executable directory ownership" >&2; return 2 ;; esac
  current_uid=$(id -u)
  if ! is_systemd_mapped_root_docker "$docker_owner" "$docker_dir_owner" "$docker_bin" "$docker_bin_dir"; then
    case "$docker_owner" in 0|"$current_uid") ;; *) echo "Docker executable must be owned by root or the current user" >&2; return 2 ;; esac
    case "$docker_dir_owner" in 0|"$current_uid") ;; *) echo "Docker executable directory must be owned by root or the current user" >&2; return 2 ;; esac
  fi

  docker_mode=$(stat -f '%Lp' "$docker_bin" 2>/dev/null || true)
  case "$docker_mode" in ''|*[!0-7]*) docker_mode=$(stat -c '%a' "$docker_bin" 2>/dev/null || true) ;; esac
  case "$docker_mode" in ''|*[!0-7]*) echo "Could not verify Docker executable permissions" >&2; return 2 ;; esac
  docker_dir_mode=$(stat -f '%Lp' "$docker_bin_dir" 2>/dev/null || true)
  case "$docker_dir_mode" in ''|*[!0-7]*) docker_dir_mode=$(stat -c '%a' "$docker_bin_dir" 2>/dev/null || true) ;; esac
  case "$docker_dir_mode" in ''|*[!0-7]*) echo "Could not verify Docker executable directory permissions" >&2; return 2 ;; esac
  if [ $((0$docker_mode & 022)) -ne 0 ]; then
    echo "Docker executable must not be group or other writable" >&2
    return 2
  fi
  if [ $((0$docker_dir_mode & 022)) -ne 0 ]; then
    echo "Docker executable directory must not be group or other writable" >&2
    return 2
  fi

  docker_links=$(stat -f '%l' "$docker_bin" 2>/dev/null || true)
  case "$docker_links" in ''|*[!0-9]*) docker_links=$(stat -c '%h' "$docker_bin" 2>/dev/null || true) ;; esac
  case "$docker_links" in ''|*[!0-9]*) echo "Could not verify Docker executable link count" >&2; return 2 ;; esac
  if [ "$docker_links" != 1 ]; then
    echo "Docker executable must not be hard-linked" >&2
    return 2
  fi
}
