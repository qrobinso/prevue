#!/bin/bash
# Prevue Kiosk Mode Launcher
# Launches Chromium in kiosk mode on Pi OS Desktop
# Designed to run from XDG autostart (inside the desktop session)

# Logging
LOG_DIR="/home/prevue/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/kiosk-$(date +%Y%m%d-%H%M%S).log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "Starting Prevue Kiosk..."

# Detect display environment
if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
  # Not running inside a desktop session - try to find one
  export DISPLAY=:0
  log "No display detected, defaulting to DISPLAY=:0"
fi
log "Display: DISPLAY=${DISPLAY:-unset} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset}"

# Check if Prevue API is ready
log "Waiting for Prevue API to be ready..."
TIMEOUT=120
ELAPSED=0
while ! curl -sf http://localhost:3080/api/health > /dev/null 2>&1; do
  if [ $ELAPSED -ge $TIMEOUT ]; then
    log "ERROR: Prevue API did not become ready within ${TIMEOUT}s"
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
log "Prevue API is ready after ${ELAPSED}s"

# Detect browser binary (prefer chromium since it has native --kiosk)
BROWSER_BIN=""
BROWSER_ARGS=""
if command -v chromium-browser &> /dev/null; then
  BROWSER_BIN="chromium-browser"
  BROWSER_ARGS="--kiosk --noerrdialogs --disable-infobars --no-first-run --check-for-update-interval=31536000 --disable-features=Translate"
elif command -v chromium &> /dev/null; then
  BROWSER_BIN="chromium"
  BROWSER_ARGS="--kiosk --noerrdialogs --disable-infobars --no-first-run --check-for-update-interval=31536000 --disable-features=Translate"
elif command -v epiphany &> /dev/null; then
  BROWSER_BIN="epiphany"
  BROWSER_ARGS=""
elif command -v gnome-web &> /dev/null; then
  BROWSER_BIN="gnome-web"
  BROWSER_ARGS=""
else
  log "ERROR: No supported browser found (tried chromium-browser, chromium, epiphany)"
  exit 1
fi
log "Using browser: $BROWSER_BIN"

# Disable screensaver and screen blanking (X11 only, safe to fail on Wayland)
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

# Hide mouse cursor after 1 second of inactivity
if command -v unclutter &> /dev/null; then
  pkill unclutter 2>/dev/null || true
  unclutter -idle 1 &
fi

# Launch browser in kiosk mode
log "Launching $BROWSER_BIN $BROWSER_ARGS http://localhost:3080"
$BROWSER_BIN $BROWSER_ARGS http://localhost:3080 &
BROWSER_PID=$!

log "Browser launched (PID: $BROWSER_PID)"

# Wait for browser process to exit
wait $BROWSER_PID 2>/dev/null

log "Kiosk exited"
