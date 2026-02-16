#!/bin/bash
# Prevue Kiosk Mode Launcher
# Starts X server and Chromium in kiosk mode with hardware acceleration

DISPLAY=:0
export DISPLAY HOME=/home/prevue XAUTHORITY=/home/prevue/.Xauthority

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

# Start X server if not already running
if ! pgrep -x "Xorg" > /dev/null && ! pgrep -x "X" > /dev/null; then
  log "Starting X server..."
  xinit /bin/bash -c "
    # Disable screensaver and power management
    xset s off
    xset -dpms
    xset s noblank
    xset b off

    # Start window manager
    openbox &
    sleep 1

    # Hide mouse cursor
    unclutter -idle 1 &

    # Launch Epiphany in fullscreen mode
    $BROWSER_BIN \\
      --incognito \\
      http://localhost:3080
  " -- :0 vt1 2>&1 | tee -a "$LOG_FILE"
else
  log "X server already running, launching browser directly..."

  # Disable screensaver and power management
  xset s off 2>/dev/null || true
  xset -dpms 2>/dev/null || true
  xset s noblank 2>/dev/null || true

  # Start window manager if not running
  if ! pgrep -x "openbox" > /dev/null; then
    openbox &
    sleep 1
  fi

  # Hide mouse cursor
  unclutter -idle 1 &

  # Launch Epiphany in fullscreen mode
  $BROWSER_BIN \
    --incognito \
    http://localhost:3080 2>&1 | tee -a "$LOG_FILE"
fi

log "Kiosk exited"
