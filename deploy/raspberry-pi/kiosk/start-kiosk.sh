#!/bin/bash
# Prevue Kiosk Mode Launcher
# Starts X server and Chromium in kiosk mode with hardware acceleration

set -e

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
    echo "Prevue API Unavailable" > /tmp/prevue-splash.txt
    sleep 30
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
log "Prevue API is ready after ${ELAPSED}s"

# Disable screensaver and power management
log "Configuring display settings..."
xset s off -display $DISPLAY 2>/dev/null || true
xset -dpms -display $DISPLAY 2>/dev/null || true
xset s noblank -display $DISPLAY 2>/dev/null || true
xset b off -display $DISPLAY 2>/dev/null || true

# Start window manager if not already running
if ! pgrep -x "openbox" > /dev/null; then
  log "Starting Openbox window manager..."
  openbox --replace &
  sleep 1
fi

# Hide mouse cursor
if command -v unclutter &> /dev/null; then
  log "Starting cursor hiding..."
  unclutter -display $DISPLAY -idle 3 &
fi

# Launch Chromium in kiosk mode
log "Launching Chromium in kiosk mode..."

chromium-browser \
  --kiosk \
  --no-first-run \
  --no-default-browser-check \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-translate \
  --disable-component-update \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --enable-features=VaapiVideoDecoder \
  --use-gl=egl \
  --ignore-gpu-blocklist \
  --enable-gpu-rasterization \
  --enable-zero-copy \
  --enable-hardware-overlays \
  --disable-smooth-scrolling \
  --autoplay-policy=no-user-gesture-required \
  --force-dark-mode \
  --disable-plugins-power-saver \
  --disable-background-networking \
  --disable-breakpad \
  --disable-client-side-phishing-detection \
  --disable-default-apps \
  --disable-extensions \
  --disable-extensions-except="" \
  --disable-password-manager-ui \
  --disable-preconnect \
  --disable-sync \
  --metrics-recording-only \
  --mute-audio \
  http://localhost:3080 2>&1 | tee -a "$LOG_FILE"

# If Chromium exits, log and wait before restart
log "Chromium exited (likely killed by systemd restart)"
