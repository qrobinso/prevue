#!/bin/bash
# Prevue Repair Script
# Re-downloads missing deployment files and fixes permissions

set -e

INSTALL_DIR="/home/prevue"
DEPLOY_DIR="$INSTALL_DIR/deploy/raspberry-pi"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

success() {
  echo "[✓] $*"
}

error() {
  echo "[✗] $*"
  exit 1
}

log "Prevue Repair - Re-downloading missing files..."

# Create directories
mkdir -p "$DEPLOY_DIR"/{systemd,kiosk,input,scripts,maintenance}

# Files to download
files=(
  "docker-compose.rpi.yml"
  "systemd/prevue.target"
  "systemd/prevue-docker.service"
  "systemd/prevue-kiosk.service"
  "systemd/prevue-watchdog.service"
  "kiosk/start-kiosk.sh"
  "kiosk/openbox-rc.xml"
  "kiosk/splash.html"
  "input/libcec-setup.sh"
  "input/cec-daemon.sh"
  "input/cec-keymapper.service"
  "input/test-remote.sh"
  "scripts/wait-for-network.sh"
  "scripts/detect-display.sh"
  "maintenance/health-check.sh"
  "maintenance/update.sh"
  "maintenance/backup.sh"
  "maintenance/factory-reset.sh"
)

failed=0
for file in "${files[@]}"; do
  url="https://raw.githubusercontent.com/qrobinso/prevue/master/deploy/raspberry-pi/$file"
  dest="$DEPLOY_DIR/$file"

  log "Downloading: $file"
  if curl -fL "$url" -o "$dest" 2>/dev/null; then
    success "Downloaded: $file"
  else
    error "Failed to download: $file (check internet connection)"
  fi
done

# Set permissions
log "Setting file permissions..."
chown -R prevue:prevue "$DEPLOY_DIR"
chmod +x "$DEPLOY_DIR"/kiosk/*.sh "$DEPLOY_DIR"/scripts/*.sh "$DEPLOY_DIR"/maintenance/*.sh "$DEPLOY_DIR"/input/*.sh 2>/dev/null || true

# Copy systemd services
log "Installing systemd services..."
for service in prevue.target prevue-docker.service prevue-kiosk.service prevue-watchdog.service; do
  if [ -f "$DEPLOY_DIR/systemd/$service" ]; then
    sudo cp "$DEPLOY_DIR/systemd/$service" /etc/systemd/system/
    log "Installed: $service"
  else
    error "Service file not found: $service"
  fi
done

# Reload and restart services
log "Reloading systemd..."
sudo systemctl daemon-reload

log "Stopping services..."
sudo systemctl stop prevue-kiosk.service prevue-docker.service 2>/dev/null || true
sleep 2

log "Starting Docker service..."
sudo systemctl start prevue-docker.service

log "Waiting for Docker to initialize..."
sleep 10

log "Checking Prevue API..."
if curl -sf http://localhost:3080/api/health > /dev/null; then
  success "Prevue API is responding!"
else
  error "Prevue API not responding - check: docker ps"
fi

log "Starting kiosk..."
sudo systemctl start prevue-kiosk.service

success "Repair complete! System should be working now."
log ""
log "Check status with:"
log "  systemctl status prevue.target"
log "  docker ps"
log ""
log "View logs:"
log "  journalctl -u prevue-docker.service -f"
log "  journalctl -u prevue-kiosk.service -f"
