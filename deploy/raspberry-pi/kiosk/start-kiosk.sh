#!/bin/bash
# Prevue Kiosk Mode Launcher
# Launches browser fullscreen on Pi OS Desktop (display already running)

# Logging
LOG_DIR="/home/prevue/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/kiosk-$(date +%Y%m%d-%H%M%S).log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "Starting Prevue Kiosk..."

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

# Detect Epiphany browser binary
if command -v epiphany &> /dev/null; then
  BROWSER_BIN="epiphany"
elif command -v gnome-web &> /dev/null; then
  BROWSER_BIN="gnome-web"
else
  log "ERROR: No Epiphany browser found. Install with: sudo apt install epiphany-browser"
  exit 1
fi
log "Using browser: $BROWSER_BIN"

# Disable screensaver and screen blanking
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true
xdg-screensaver reset 2>/dev/null || true

# Hide mouse cursor after 1 second of inactivity
if command -v unclutter &> /dev/null; then
  pkill unclutter 2>/dev/null || true
  unclutter -idle 1 &
fi

# Launch Epiphany in fullscreen/kiosk mode
log "Launching $BROWSER_BIN..."
$BROWSER_BIN \
  --incognito \
  http://localhost:3080 2>&1 | tee -a "$LOG_FILE"

log "Kiosk exited"
