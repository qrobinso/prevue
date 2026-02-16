#!/bin/bash
# Prevue Factory Reset Script
# Resets Prevue to post-installation state

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
  echo -e "${BLUE}[RESET]${NC} $*"
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

echo ""
echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
echo -e "${RED}   WARNING: Factory Reset${NC}"
echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${RED}This will DELETE all Prevue data and configuration!${NC}"
echo ""
echo "This action will:"
echo "  • Delete the SQLite database"
echo "  • Delete configuration (.env file)"
echo "  • PRESERVE: Backup files in /home/prevue/backups/"
echo "  • PRESERVE: Log files in /home/prevue/logs/"
echo ""
echo "You will need to reconfigure Jellyfin connection after reset."
echo ""

# Countdown confirmation
read -p "Are you absolutely sure? Type 'factory-reset' to confirm: " CONFIRM

if [ "$CONFIRM" != "factory-reset" ]; then
  error "Factory reset cancelled"
fi

echo ""
echo "10-second countdown. Press Ctrl+C to cancel."
sleep 1
echo "9..."
sleep 1
echo "8..."
sleep 1
echo "7..."
sleep 1
echo "6..."
sleep 1
echo "5..."
sleep 1
echo "4..."
sleep 1
echo "3..."
sleep 1
echo "2..."
sleep 1
echo "1..."
sleep 1

log "Starting factory reset..."

# Stop services
log "Stopping services..."
systemctl stop prevue-kiosk.service || true
systemctl stop prevue-docker.service || true
systemctl stop prevue-watchdog.service || true
sleep 3

# Remove Docker containers
log "Removing Docker containers..."
docker compose -f /home/prevue/docker-compose.rpi.yml down 2>/dev/null || true
docker rm prevue 2>/dev/null || true

# Delete configuration
log "Deleting configuration..."
rm -f /home/prevue/.env
rm -f /home/prevue/docker-compose.rpi.yml

# Delete database
log "Deleting database..."
rm -rf /home/prevue/data/*

# Clear logs (optional)
log "Clearing logs..."
rm -f /home/prevue/logs/*

# Note: Keep /home/prevue/backups/ for recovery

echo ""
echo -e "${YELLOW}════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}   Factory Reset Complete${NC}"
echo -e "${YELLOW}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Next steps:"
echo "  1. Restore the /home/prevue/deploy/raspberry-pi/ directory if missing"
echo "  2. Run the installation script again:"
echo "     curl -fsSL https://raw.githubusercontent.com/user/prevue/master/deploy/raspberry-pi/install.sh | sudo bash"
echo "  3. Follow the setup prompts"
echo ""
echo "Alternatively, restore from backup:"
echo "  sudo tar -xzf /home/prevue/backups/prevue-backup-YYYYMMDD-HHMMSS.tar.gz -C /home/prevue"
echo ""

exit 0
