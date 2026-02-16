#!/bin/bash
# CEC Remote Control Testing Tool for Prevue
# Helps diagnose and verify TV remote control functionality

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
  echo -e "${BLUE}[INFO]${NC} $*"
}

success() {
  echo -e "${GREEN}[✓]${NC} $*"
}

warn() {
  echo -e "${YELLOW}[!]${NC} $*"
}

error() {
  echo -e "${RED}[✗]${NC} $*"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  error "This tool must be run with sudo"
  exit 1
fi

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   Prevue CEC Remote Control Test Tool${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

# Test 1: Check for CEC device
log "Test 1: Checking for CEC device..."
if [ -c /dev/cec0 ]; then
  success "CEC device found: /dev/cec0"
  ls -la /dev/cec0
else
  error "CEC device /dev/cec0 not found"
  warn "Your TV may not support HDMI-CEC, or it's not enabled"
  exit 1
fi

echo ""

# Test 2: Check for libcec installation
log "Test 2: Checking for libcec installation..."
if command -v cec-client &> /dev/null; then
  success "cec-client is installed"
  cec-client -v
else
  error "cec-client not found"
  warn "Run the install script to install libcec"
  exit 1
fi

echo ""

# Test 3: Check for xdotool (needed for key injection)
log "Test 3: Checking for xdotool (keyboard event injection)..."
if command -v xdotool &> /dev/null; then
  success "xdotool is installed"
  xdotool --version
else
  warn "xdotool not found - keyboard events will not work"
  warn "Install it with: sudo apt-get install xdotool"
fi

echo ""

# Test 4: Test CEC connection to TV
log "Test 4: Testing CEC connection to TV..."
echo "Sending ping to TV (requires HDMI-CEC enabled on TV)..."

if timeout 5 cec-client < /dev/null 2>&1 | grep -q "^CEC"; then
  success "CEC client initialized successfully"

  # List CEC devices
  log "CEC devices detected:"
  timeout 5 cec-client -l -s 2>/dev/null || true
else
  warn "Could not initialize CEC client"
  warn "Verify that HDMI-CEC is enabled on your TV"
fi

echo ""

# Test 5: Live CEC event monitoring
log "Test 5: Live CEC Event Monitor"
echo -e "${YELLOW}This will listen for CEC button presses for 30 seconds.${NC}"
echo "Press buttons on your TV remote now (arrow keys, select, exit, etc.)"
echo ""

read -p "Start monitoring? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  log "Listening for CEC events (30 second timeout)..."

  TEMP_LOG=$(mktemp)

  # Try to capture CEC events
  (timeout 30 cec-client -s < /dev/null > "$TEMP_LOG" 2>&1) || true

  if [ -s "$TEMP_LOG" ]; then
    success "CEC events detected:"
    cat "$TEMP_LOG" | head -20
  else
    warn "No CEC events detected"
    warn "Possible causes:"
    warn "  1. TV remote buttons were not pressed during monitoring"
    warn "  2. HDMI-CEC is not enabled on the TV"
    warn "  3. The HDMI cable does not support CEC"
  fi

  rm -f "$TEMP_LOG"
fi

echo ""

# Test 6: Check CEC daemon status
log "Test 6: Checking CEC daemon status..."
if systemctl is-active --quiet cec-keymapper.service; then
  success "CEC keymapper service is running"
  systemctl status cec-keymapper.service --no-pager | head -10
else
  warn "CEC keymapper service is not running"
  warn "Start it with: sudo systemctl start cec-keymapper.service"
fi

echo ""

# Test 7: Check for recent CEC daemon activity
log "Test 7: Checking CEC daemon logs..."
if [ -f /home/prevue/logs/cec-daemon.log ]; then
  success "CEC daemon log file found"
  log "Recent log entries:"
  tail -10 /home/prevue/logs/cec-daemon.log
else
  warn "CEC daemon log file not found yet (first run)"
fi

echo ""

# Summary
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   Test Summary${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

SUCCESS_COUNT=0
[ -c /dev/cec0 ] && ((SUCCESS_COUNT++))
command -v cec-client &> /dev/null && ((SUCCESS_COUNT++))
command -v xdotool &> /dev/null && ((SUCCESS_COUNT++))

echo "Core components: $SUCCESS_COUNT/3 ready"
echo ""

if [ $SUCCESS_COUNT -eq 3 ]; then
  success "All components ready for TV remote control!"
  echo ""
  echo "Next steps:"
  echo "  1. Ensure your TV has HDMI-CEC enabled in settings"
  echo "  2. Reboot the system"
  echo "  3. Test by pressing arrow keys on TV remote"
  echo "  4. If not working, check logs with: tail -f /home/prevue/logs/cec-daemon.log"
elif [ $SUCCESS_COUNT -ge 2 ]; then
  warn "Most components ready, but some may need installation"
  echo ""
  echo "To complete setup:"
  echo "  sudo apt-get install xdotool"
  echo "  sudo systemctl restart cec-keymapper.service"
else
  error "Missing critical components for TV remote control"
  echo ""
  echo "Install missing packages:"
  echo "  sudo apt-get install cec-utils xdotool"
fi

echo ""
