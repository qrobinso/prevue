#!/bin/bash
# Prevue Update Script
# Updates the Prevue application to the latest version

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
  echo -e "${BLUE}[UPDATE]${NC} $*"
}

success() {
  echo -e "${GREEN}[✓]${NC} $*"
}

error() {
  echo -e "${RED}[✗]${NC} $*"
  exit 1
}

warn() {
  echo -e "${YELLOW}[!]${NC} $*"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  error "This script must be run with sudo"
fi

# Configuration
COMPOSE_FILE="/home/prevue/docker-compose.rpi.yml"
CURRENT_VERSION=""
LATEST_VERSION=""
BACKUP_DIR="/home/prevue/backups"

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   Prevue Update Tool${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

# Get current version
log "Checking current version..."
if docker ps | grep -q prevue; then
  CURRENT_VERSION=$(docker inspect prevue | grep -i "image" | head -1 | grep -oP '(?<=prevue:)[^"]*' || echo "unknown")
  success "Current version: $CURRENT_VERSION"
else
  warn "Docker container not running, cannot determine current version"
fi

# Create backup
log "Creating backup before update..."
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/prevue-backup-$(date +%s).tar.gz"

if tar -czf "$BACKUP_FILE" \
  -C /home/prevue .env 2>/dev/null && \
  tar -czf "$BACKUP_FILE" \
  -C /home/prevue data/ 2>/dev/null; then
  success "Backup created: $BACKUP_FILE"
else
  warn "Backup creation had issues, continuing anyway"
fi

# Stop services
log "Stopping Prevue services..."
systemctl stop prevue-kiosk.service || true
systemctl stop prevue-docker.service || true
sleep 2
success "Services stopped"

# Pull latest Docker image
log "Pulling latest Docker image..."
if docker compose -f "$COMPOSE_FILE" pull; then
  success "Docker image updated"
else
  error "Failed to pull Docker image. Check internet connection."
fi

# Restart services
log "Restarting Prevue services..."
systemctl start prevue-docker.service || error "Failed to start Docker service"
sleep 10
systemctl start prevue-kiosk.service || warn "Failed to start kiosk service"
success "Services restarted"

# Wait for API to become ready
log "Waiting for Prevue API to become ready..."
TIMEOUT=60
ELAPSED=0
while ! curl -sf http://localhost:3080/api/health > /dev/null 2>&1; do
  if [ $ELAPSED -ge $TIMEOUT ]; then
    error "Prevue API did not become ready within ${TIMEOUT}s"
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
success "Prevue API is ready"

# Check for new version
log "Verifying update..."
if docker ps | grep -q prevue; then
  NEW_VERSION=$(docker inspect prevue | grep -i "image" | head -1 | grep -oP '(?<=prevue:)[^"]*' || echo "unknown")
  if [ "$NEW_VERSION" != "$CURRENT_VERSION" ] && [ -n "$CURRENT_VERSION" ]; then
    success "Updated from $CURRENT_VERSION to $NEW_VERSION"
  else
    success "Already running latest version: $NEW_VERSION"
  fi
else
  warn "Could not verify update (Docker container not responding)"
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Update Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Backup location: $BACKUP_FILE"
echo ""
echo "If you experience issues:"
echo "  1. Check logs: journalctl -u prevue-docker.service"
echo "  2. Restore backup: tar -xzf $BACKUP_FILE -C /home/prevue"
echo "  3. Restart services: sudo systemctl restart prevue.target"
echo ""

exit 0
