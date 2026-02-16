#!/bin/bash
# Prevue Uninstall Script
# Cleanly removes Prevue and all related files from Raspberry Pi

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
  echo -e "${BLUE}[UNINSTALL]${NC} $*"
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

echo ""
echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
echo -e "${RED}   Prevue Uninstall${NC}"
echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "This will REMOVE:"
echo "  • Prevue systemd services"
echo "  • Docker container"
echo "  • /home/prevue directory (including all data)"
echo "  • prevue user account"
echo ""
echo "This will PRESERVE:"
echo "  • Docker installation"
echo "  • System configuration"
echo "  • Jellyfin server"
echo ""

read -p "Continue with uninstall? (type 'uninstall' to confirm): " CONFIRM
if [ "$CONFIRM" != "uninstall" ]; then
  log "Uninstall cancelled"
  exit 0
fi

echo ""
log "Starting uninstall process..."
echo ""

# Stop services
log "Stopping Prevue services..."
systemctl stop prevue-kiosk.service 2>/dev/null || true
systemctl stop prevue-docker.service 2>/dev/null || true
systemctl stop prevue-watchdog.service 2>/dev/null || true
sleep 2
success "Services stopped"

# Stop Docker container
log "Stopping Docker container..."
docker stop prevue 2>/dev/null || true
docker rm prevue 2>/dev/null || true
success "Docker container removed"

# Remove systemd services
log "Removing systemd services..."
systemctl disable prevue-docker.service 2>/dev/null || true
systemctl disable prevue-kiosk.service 2>/dev/null || true
systemctl disable prevue-watchdog.service 2>/dev/null || true
systemctl disable prevue.target 2>/dev/null || true

rm -f /etc/systemd/system/prevue.target
rm -f /etc/systemd/system/prevue-docker.service
rm -f /etc/systemd/system/prevue-kiosk.service
rm -f /etc/systemd/system/prevue-watchdog.service

systemctl daemon-reload
success "Systemd services removed"

# Remove installation directory
log "Removing /home/prevue directory..."
if [ -d /home/prevue ]; then
  rm -rf /home/prevue
  success "Directory removed"
else
  log "Directory not found (already removed)"
fi

# Remove prevue user
log "Removing prevue user..."
if id prevue &>/dev/null; then
  userdel -r prevue 2>/dev/null || true
  success "User removed"
else
  log "User not found (already removed)"
fi

# Restore display manager if needed
log "Re-enabling display manager (if disabled)..."
systemctl enable lightdm 2>/dev/null || true
systemctl enable gdm 2>/dev/null || true
systemctl enable xdm 2>/dev/null || true

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Uninstall Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Prevue has been completely removed from your system."
echo ""
echo "To reinstall later, run:"
echo "  curl -fsSL https://raw.githubusercontent.com/qrobinso/prevue/master/deploy/raspberry-pi/install.sh | sudo bash -s -- \\"
echo "    --jellyfin-url \"http://jellyfin.local:8096\" \\"
echo "    --jellyfin-user \"username\" \\"
echo "    --jellyfin-password \"password\""
echo ""
echo "Optional: Reboot to fully restore desktop environment"
echo "  sudo reboot"
echo ""

exit 0
