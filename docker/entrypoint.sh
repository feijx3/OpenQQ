#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 0 ]; then
  case "$1" in
    start|webui|init|doctor) ;;
    *) exec "$@" ;;
  esac
fi

OPENQQ_CONFIG="${OPENQQ_CONFIG:-/app/config/openqq.json}"
OPENQQ_QQ_ROOT="${OPENQQ_QQ_ROOT:-/opt/QQ}"
OPENQQ_WEB_PORT="${OPENQQ_WEB_PORT:-17860}"
OPENQQ_WEB_HOST="${OPENQQ_WEB_HOST:-0.0.0.0}"
export DISPLAY="${DISPLAY:-:99}"
OPENQQ_SCREEN="${OPENQQ_SCREEN:-1280x800x24}"
OPENQQ_VNC="${OPENQQ_VNC:-1}"
OPENQQ_VNC_PORT="${OPENQQ_VNC_PORT:-5900}"
OPENQQ_NOVNC_PORT="${OPENQQ_NOVNC_PORT:-6080}"
export OPENQQ_QQ_NO_SANDBOX="${OPENQQ_QQ_NO_SANDBOX:-1}"
export OPENQQ_QQ_DISABLE_GPU="${OPENQQ_QQ_DISABLE_GPU:-1}"

if [ "${1:-}" = "doctor" ] || [ "${1:-}" = "init" ]; then
  exec node /app/src/main.mjs "$@" --config "$OPENQQ_CONFIG"
fi

# Ensure XDG runtime and machine-id exist for Electron/Chromium in minimal containers.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-openqq}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
if [ ! -s /etc/machine-id ] && command -v dbus-uuidgen >/dev/null 2>&1; then
  dbus-uuidgen --ensure >/dev/null 2>&1 || true
fi

DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"
if [ -n "$DISPLAY_NUM" ]; then
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" || true
fi

PIDS=()
PASSFILE=""
cleanup() {
  set +e
  if [ -n "$PASSFILE" ] && [ -f "$PASSFILE" ]; then
    rm -f "$PASSFILE"
  fi
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  # Stop QQ process if launched inside container when container stops.
  pkill -TERM -x qq 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "$OPENQQ_SCREEN" -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
PIDS+=("$!")

for _ in $(seq 1 50); do
  if [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
    break
  fi
  sleep 0.1
done
if [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
  echo "[OpenQQ/docker] Xvfb failed to start on DISPLAY=$DISPLAY" >&2
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi

if [ "$OPENQQ_VNC" = "1" ]; then
  fluxbox >/dev/null 2>&1 &
  PIDS+=("$!")

  VNC_ARGS=(-display "$DISPLAY" -forever -shared -rfbport "$OPENQQ_VNC_PORT" -quiet)
  if [ "${OPENQQ_VNC_EXPOSE:-0}" != "1" ]; then
    VNC_ARGS+=(-localhost)
  fi
  if [ -n "${OPENQQ_VNC_PASSWORD:-}" ]; then
    PASSFILE="$(mktemp /tmp/openqq-vnc.XXXXXX)"
    chmod 600 "$PASSFILE"
    x11vnc -storepasswd "$OPENQQ_VNC_PASSWORD" "$PASSFILE" >/dev/null
    VNC_ARGS+=(-rfbauth "$PASSFILE")
  else
    VNC_ARGS+=(-nopw)
  fi
  x11vnc "${VNC_ARGS[@]}" >/tmp/x11vnc.log 2>&1 &
  PIDS+=("$!")

  if [ -d /usr/share/novnc ]; then
    websockify --web=/usr/share/novnc/ "0.0.0.0:${OPENQQ_NOVNC_PORT}" "127.0.0.1:${OPENQQ_VNC_PORT}" >/tmp/novnc.log 2>&1 &
    PIDS+=("$!")
    echo "[OpenQQ/docker] noVNC ready on port ${OPENQQ_NOVNC_PORT} (open http://127.0.0.1:${OPENQQ_NOVNC_PORT}/vnc.html?autoconnect=true to log in to QQ)"
  fi
fi

# Auto-create openqq.json when requested via environment variables.
if [ ! -f "$OPENQQ_CONFIG" ] && { [ "${OPENQQ_AUTO_INIT:-0}" = "1" ] || [ -n "${OPENQQ_ACCESS_TOKEN:-}" ] || [ -n "${OPENQQ_REVERSE_WS_URL:-}" ]; }; then
  node --input-type=module -e "
    import { randomBytes } from 'node:crypto';
    import { saveConfig } from '/app/src/config.mjs';
    const reverseUrl = (process.env.OPENQQ_REVERSE_WS_URL || '').trim();
    const cfg = {
      version: 1,
      qqRoot: process.env.OPENQQ_QQ_ROOT || '/opt/QQ',
      webPort: Number(process.env.OPENQQ_WEB_PORT || 17860),
      accessToken: process.env.OPENQQ_ACCESS_TOKEN || randomBytes(32).toString('hex'),
      ws: {
        enabled: process.env.OPENQQ_WS_ENABLED !== 'false',
        host: process.env.OPENQQ_WS_HOST || '0.0.0.0',
        port: Number(process.env.OPENQQ_WS_PORT || 3001),
      },
      reverseWs: reverseUrl ? [{ enabled: true, url: reverseUrl, token: process.env.OPENQQ_REVERSE_WS_TOKEN || '' }] : [],
    };
    saveConfig(process.env.OPENQQ_CONFIG, cfg);
    console.log('[OpenQQ/docker] Generated configuration at ' + process.env.OPENQQ_CONFIG);
  "
fi

if [ "$#" -eq 0 ]; then
  CMD=(start)
else
  CMD=("$@")
fi

node /app/src/main.mjs "${CMD[@]}" \
  --config "$OPENQQ_CONFIG" \
  --qq-root "$OPENQQ_QQ_ROOT" \
  --web-port "$OPENQQ_WEB_PORT" \
  --web-host "$OPENQQ_WEB_HOST" \
  --no-sandbox &
OPENQQ_PID="$!"
PIDS+=("$OPENQQ_PID")

wait "$OPENQQ_PID"
