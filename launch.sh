#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=4174
MODE="tray"
LIBRARY=""
NO_OPEN=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--port PORT] [--library PATH] [--no-tray|--cli] [--no-open] [PORT]

  --port PORT       HTTP port (default: 4174)
  -l, --library DIR Path to Ymir library root (default: \$YMIR_LIBRARY, ~/.local/share/ymir, or repo root)
  --no-tray         Run the HTTP server in the foreground without the tray
  --cli             Alias for --no-tray
  --no-open         Do not automatically open the browser on launch
  -h, --help        Show this help
EOF
}

EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-tray|--cli)
      MODE="cli"
      EXTRA_ARGS+=("$1")
      shift
      ;;
    --no-open)
      NO_OPEN=1
      EXTRA_ARGS+=("$1")
      shift
      ;;
    --port)
      if [[ $# -lt 2 ]]; then
        echo "error: --port requires a value" >&2
        exit 2
      fi
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    -l|--library)
      if [[ $# -lt 2 ]]; then
        echo "error: --library requires a value" >&2
        exit 2
      fi
      LIBRARY="$2"
      shift 2
      ;;
    --library=*)
      LIBRARY="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    [0-9]*)
      PORT="$1"
      shift
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "error: invalid port: ${PORT}" >&2
  exit 2
fi

# No graphical session means there is no tray to start.
if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  MODE="cli"
fi

# Detect Python interpreter and set up vendored dependencies
PYTHON="python3"
if [[ -x "${DIR}/.venv/bin/python" ]]; then
  PYTHON="${DIR}/.venv/bin/python"
elif [[ -x "${DIR}/../.venv/bin/python" ]]; then
  PYTHON="${DIR}/../.venv/bin/python"
fi

# Include local vendor directory for pystray / six
export PYTHONPATH="${DIR}/vendor:${PYTHONPATH:-}"

INVOKE_ARGS=("--port" "${PORT}")
if [[ -n "${LIBRARY}" ]]; then
  INVOKE_ARGS+=("--library" "${LIBRARY}")
fi
INVOKE_ARGS+=("${EXTRA_ARGS[@]}")

exec "${PYTHON}" "${DIR}/tools/tray.py" "${INVOKE_ARGS[@]}"
