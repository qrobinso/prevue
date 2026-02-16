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

# Detect chromium binary name
if command -v chromium &> /dev/null; then
  CHROMIUM_BIN="chromium"
elif command -v chromium-browser &> /dev/null; then
  CHROMIUM_BIN="chromium-browser"
else
  log "ERROR: No Chromium browser found. Install with: sudo apt install chromium"
  exit 1
fi
log "Using browser: $CHROMIUM_BIN"

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

    # Launch Chromium in kiosk mode
    $CHROMIUM_BIN \\
      --kiosk \\
      --no-first-run \\
      --no-default-browser-check \\
      --noerrdialogs \\
      --disable-infobars \\
      --disable-session-crashed-bubble \\
      --disable-translate \\
      --disable-component-update \\
      --disable-features=TranslateUI \\
      --check-for-update-interval=31536000 \\
      --enable-features=VaapiVideoDecoder \\
      --use-gl=egl \\
      --ignore-gpu-blocklist \\
      --enable-gpu-rasterization \\
      --enable-zero-copy \\
      --enable-hardware-overlays \\
      --disable-smooth-scrolling \\
      --autoplay-policy=no-user-gesture-required \\
      --force-dark-mode \\
      --disable-background-networking \\
      --disable-breakpad \\
      --disable-client-side-phishing-detection \\
      --disable-default-apps \\
      --disable-extensions \\
      --disable-password-manager-ui \\
      --disable-sync \\
      --metrics-recording-only \\
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

  # Launch Chromium
  $CHROMIUM_BIN \
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
    --disable-background-networking \
    --disable-breakpad \
    --disable-client-side-phishing-detection \
    --disable-default-apps \
    --disable-extensions \
    --disable-password-manager-ui \
    --disable-sync \
    --metrics-recording-only \
    http://localhost:3080 2>&1 | tee -a "$LOG_FILE"
fi

log "Kiosk exited"
