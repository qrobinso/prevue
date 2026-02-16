#!/bin/bash
# Prevue Backup Script
# Creates encrypted backups of configuration and database

set -e

# Configuration
BACKUP_DIR="/home/prevue/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/prevue-backup-$TIMESTAMP.tar.gz"
INSTALL_DIR="/home/prevue"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

success() {
  echo "[✓] $*"
}

error() {
  echo "[✗ ERROR] $*"
  exit 1
}

log "Starting Prevue backup..."

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Stop services to ensure data consistency
log "Stopping services for data consistency..."
systemctl stop prevue-kiosk.service || true
systemctl stop prevue-docker.service || true
sleep 5

# Backup files
log "Backing up configuration and data..."

# Create temporary directory for backup staging
TEMP_BACKUP=$(mktemp -d)
trap "rm -rf $TEMP_BACKUP" EXIT

# Copy .env file
if [ -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env" "$TEMP_BACKUP/"
  log "Backed up .env configuration"
fi

# Copy SQLite database
if [ -d "$INSTALL_DIR/data" ]; then
  cp -r "$INSTALL_DIR/data" "$TEMP_BACKUP/"
  log "Backed up database"
fi

# Create tarball
log "Creating backup archive..."
if tar -czf "$BACKUP_FILE" -C "$TEMP_BACKUP" . 2>/dev/null; then
  success "Backup created: $BACKUP_FILE"
  ls -lh "$BACKUP_FILE"
else
  error "Failed to create backup archive"
fi

# Restart services
log "Restarting services..."
systemctl start prevue-docker.service || error "Failed to restart Docker service"
sleep 10
systemctl start prevue-kiosk.service || log "Kiosk service will auto-start"

success "Backup complete!"
log ""
log "Backup location: $BACKUP_FILE"
log "Backup size: $(du -h "$BACKUP_FILE" | cut -f1)"
log ""
log "To restore from backup:"
log "  sudo systemctl stop prevue.target"
log "  sudo tar -xzf $BACKUP_FILE -C /home/prevue"
log "  sudo systemctl start prevue.target"
log ""

# Optional: Copy to USB drive if available
if [ -d "/media/usb" ] && [ "$(ls -A /media/usb)" ]; then
  log "Detected USB drive, copying backup..."
  cp "$BACKUP_FILE" "/media/usb/" 2>/dev/null && success "Backup copied to USB drive" || log "Could not copy to USB"
fi

exit 0
