#!/bin/bash
# HDMI-CEC Setup and Configuration for Prevue
# Enables TV remote control support via HDMI-CEC

set -e

log() {
  echo "[$(date)] $*"
}

success() {
  echo "[✓] $*"
}

error() {
  echo "[✗ ERROR] $*"
  exit 1
}

warn() {
  echo "[!] WARNING: $*"
}

log "Setting up HDMI-CEC (Prevue remote control via TV)"

# Check if libcec is already installed
if command -v cec-client &> /dev/null; then
  log "libcec already installed"
  log "libcec version: $(cec-client -v)"
else
  error "libcec is not installed. Run the install script first."
fi

# Detect CEC adapter
log "Detecting CEC adapter..."
if [ -c /dev/cec0 ]; then
  success "CEC device found: /dev/cec0"
  CEC_DEVICE="/dev/cec0"
elif ls /dev/cec* 2>/dev/null | head -1 | grep -q "^/dev/cec"; then
  CEC_DEVICE=$(ls /dev/cec* | head -1)
  success "CEC device found: $CEC_DEVICE"
else
  warn "No CEC device detected"
  warn "HDMI-CEC may not be available on your TV or HDMI cable"
  warn "You can use a wireless keyboard/mouse as fallback"
  exit 1
fi

# Test CEC connection with a simple command
log "Testing CEC connection..."
if timeout 5 cec-client -s < /dev/null 2>/dev/null | grep -q "Ping"; then
  success "CEC connection test successful"
else
  warn "CEC connection test did not confirm connection"
  warn "This may still work - check after full system boot"
fi

# Create CEC key mapping configuration
log "Creating CEC key mapper configuration..."

cat > /etc/prevue-cec-mapping.conf << 'EOF'
# CEC Button to Keyboard Key Mapping for Prevue
# Format: CEC_BUTTON=X11_KEYSYM

UP=Up
DOWN=Down
LEFT=Left
RIGHT=Right
SELECT=Return
EXIT=Escape
BACK=Escape
CHANNEL_UP=Page_Up
CHANNEL_DOWN=Page_Down
PLAY=space
PAUSE=space
STOP=Escape
MUTE=m
VOLUME_UP=plus
VOLUME_DOWN=minus
F1=F1
F2=F2
F3=F3
F4=F4
EOF

success "CEC mapping configuration created"

# Enable CEC in systemd
log "Enabling CEC key mapper service..."

if [ -f "/home/prevue/deploy/input/cec-keymapper.service" ]; then
  cp /home/prevue/deploy/input/cec-keymapper.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable cec-keymapper.service
  success "CEC service enabled"
else
  warn "CEC keymapper service file not found"
fi

# Set CEC device permissions
log "Setting CEC device permissions..."
chmod 666 "$CEC_DEVICE" 2>/dev/null || {
  # Create udev rule if needed
  cat > /etc/udev/rules.d/99-cec.rules << EOF
SUBSYSTEM=="cec", GROUP="video", MODE="0666"
EOF
  udevadm control --reload-rules || true
  success "CEC udev rules created"
}

log "HDMI-CEC setup complete!"
log ""
log "Next steps:"
log "  1. Make sure your TV is connected via HDMI"
log "  2. Ensure CEC is enabled in your TV's settings"
log "  3. System will auto-detect and configure on next boot"
log ""
log "To test CEC manually, run:"
log "  sudo /home/prevue/deploy/input/test-remote.sh"

exit 0
