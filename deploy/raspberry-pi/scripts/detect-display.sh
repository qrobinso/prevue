#!/bin/bash
# Detect HDMI display and configure optimal settings
# Reads EDID data and configures /boot/config.txt

set -e

BOOT_CONFIG="/boot/config.txt"
BACKUP_CONFIG="/boot/config.txt.backup.$(date +%s)"

log() {
  echo "[$(date)] $*"
}

log "Detecting HDMI display configuration..."

# Check if HDMI is connected
if tvservice -s 2>/dev/null | grep -q "HDMI"; then
  log "HDMI display detected"

  # Try to get mode list
  EDID_FILE="/tmp/edid.bin"
  tvservice -d "$EDID_FILE" 2>/dev/null || true

  if [ -f "$EDID_FILE" ]; then
    log "Reading EDID data..."
    # Parse preferred resolution from EDID
    # This is a simplified approach; more sophisticated parsing may be needed
    RESOLUTION=$(edidparse < "$EDID_FILE" 2>/dev/null | grep -m1 "Established timings" | head -1 || echo "")
    rm -f "$EDID_FILE"
  fi

  # Get current mode from tvservice
  CURRENT_MODE=$(tvservice -s | grep -oP 'DMT mode \K\d+' || echo "")
  if [ -z "$CURRENT_MODE" ]; then
    CURRENT_MODE=$(tvservice -s | grep -oP 'CEA mode \K\d+' || echo "")
  fi

  if [ -n "$CURRENT_MODE" ]; then
    log "Current HDMI mode: $CURRENT_MODE"
  fi

  # Try to list available modes
  log "Available HDMI modes:"
  tvservice -m CEA 2>/dev/null || true
  tvservice -m DMT 2>/dev/null || true
else
  log "No HDMI display detected, using safe defaults"
fi

# Configure GPU memory
log "Configuring GPU memory allocation..."

# Backup config if not already backed up
if [ ! -f "$BACKUP_CONFIG" ]; then
  cp "$BOOT_CONFIG" "$BACKUP_CONFIG"
  log "Backed up $BOOT_CONFIG to $BACKUP_CONFIG"
fi

# Add or update GPU memory setting
if grep -q "^gpu_mem=" "$BOOT_CONFIG"; then
  sed -i 's/^gpu_mem=.*/gpu_mem=128/' "$BOOT_CONFIG"
  log "Updated gpu_mem to 128MB"
else
  echo "gpu_mem=128" >> "$BOOT_CONFIG"
  log "Added gpu_mem=128MB"
fi

# Enable hardware video decode
if ! grep -q "^dtparam=audio=on" "$BOOT_CONFIG"; then
  echo "dtparam=audio=on" >> "$BOOT_CONFIG"
  log "Enabled audio via dtparam"
fi

if ! grep -q "^start_x=1" "$BOOT_CONFIG"; then
  echo "start_x=1" >> "$BOOT_CONFIG"
  log "Enabled hardware video decode"
fi

# Set safe display defaults if detection failed
if [ -z "$(tvservice -s 2>/dev/null)" ]; then
  log "Setting safe display defaults (1920x1080 @ 60Hz)..."

  # Add HDMI timing for safety
  if ! grep -q "^hdmi_mode=" "$BOOT_CONFIG"; then
    echo "hdmi_mode=16" >> "$BOOT_CONFIG"  # 1920x1080 @ 60Hz
    log "Set hdmi_mode=16 (1920x1080@60Hz)"
  fi

  if ! grep -q "^hdmi_drive=" "$BOOT_CONFIG"; then
    echo "hdmi_drive=2" >> "$BOOT_CONFIG"  # HDMI mode (vs DVI)
    log "Set hdmi_drive=2 (HDMI mode)"
  fi
fi

log "Display configuration complete"
log "Changes will take effect after reboot"

exit 0
