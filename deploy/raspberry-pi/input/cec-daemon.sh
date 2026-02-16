#!/bin/bash
# CEC Event Daemon for Prevue
# Listens for HDMI-CEC button presses and maps them to keyboard events

set -e

DISPLAY=":0"
XAUTHORITY="/home/prevue/.Xauthority"
export DISPLAY XAUTHORITY

LOG_FILE="/home/prevue/logs/cec-daemon.log"
MAPPING_CONFIG="/etc/prevue-cec-mapping.conf"
CEC_DEVICE="/dev/cec0"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log "CEC Daemon starting (PID $$)"

# Load key mappings from config file
declare -A KEY_MAP
load_mappings() {
  if [ ! -f "$MAPPING_CONFIG" ]; then
    log "WARNING: Mapping config not found at $MAPPING_CONFIG"
    log "Using default key mappings"

    # Default mappings
    KEY_MAP["UP"]="Up"
    KEY_MAP["DOWN"]="Down"
    KEY_MAP["LEFT"]="Left"
    KEY_MAP["RIGHT"]="Right"
    KEY_MAP["SELECT"]="Return"
    KEY_MAP["EXIT"]="Escape"
    KEY_MAP["BACK"]="Escape"
    KEY_MAP["CHANNEL_UP"]="Page_Up"
    KEY_MAP["CHANNEL_DOWN"]="Page_Down"
    KEY_MAP["PLAY"]="space"
    KEY_MAP["PAUSE"]="space"
    KEY_MAP["STOP"]="Escape"
    return
  fi

  # Parse mapping file (skip comments and empty lines)
  while IFS='=' read -r cec_key x11_key; do
    # Skip comments and empty lines
    [[ $cec_key =~ ^#.*$ ]] && continue
    [[ -z "$cec_key" ]] && continue

    # Trim whitespace
    cec_key=$(echo "$cec_key" | xargs)
    x11_key=$(echo "$x11_key" | xargs)

    if [ -n "$cec_key" ] && [ -n "$x11_key" ]; then
      KEY_MAP["$cec_key"]="$x11_key"
    fi
  done < "$MAPPING_CONFIG"

  log "Loaded ${#KEY_MAP[@]} key mappings"
}

# Send keyboard event
send_key() {
  local key="$1"

  if command -v xdotool &> /dev/null; then
    # Use xdotool to inject keyboard events
    if xdotool key "$key" 2>/dev/null; then
      log "Sent key: $key"
      return 0
    else
      log "ERROR: Failed to send key: $key"
      return 1
    fi
  else
    log "WARNING: xdotool not available, cannot send keyboard events"
    return 1
  fi
}

# Parse CEC event output from cec-client
# cec-client outputs button presses like: "b button down" or "button name"
parse_cec_event() {
  local event="$1"

  # Extract button name from various CEC output formats
  local button=""

  # Format: "button (0x50)" or just button name
  if [[ $event =~ button\ \(0x[0-9A-Fa-f]+\) ]]; then
    # Extract hex code and convert to button name
    local hex=$(echo "$event" | grep -oP '\(0x\K[0-9A-Fa-f]+')
    case "$hex" in
      41) button="UP" ;;
      42) button="DOWN" ;;
      43) button="LEFT" ;;
      44) button="RIGHT" ;;
      45) button="SELECT" ;;
      46) button="EXIT" ;;
      47) button="BACK" ;;
      50) button="CHANNEL_UP" ;;
      51) button="CHANNEL_DOWN" ;;
      60) button="PLAY" ;;
      61) button="PAUSE" ;;
      62) button="STOP" ;;
      *)  button="" ;;
    esac
  elif [[ $event =~ ^[A-Z_]+$ ]]; then
    # Already a button name
    button="$event"
  fi

  echo "$button"
}

# Main event loop
listen_for_cec_events() {
  log "Listening for CEC events on $CEC_DEVICE..."

  # Check if cec-client is available
  if ! command -v cec-client &> /dev/null; then
    log "ERROR: cec-client not found"
    return 1
  fi

  # cec-client outputs events in real-time
  # This will block until cec-client terminates
  cec-client -s 2>&1 | while read -r line; do
    # Look for button press patterns in output
    if [[ $line =~ button ]] || [[ $line =~ key ]]; then
      log "CEC event: $line"

      # Try to parse the button name
      local button=$(parse_cec_event "$line")

      if [ -n "$button" ] && [ -n "${KEY_MAP[$button]}" ]; then
        local key="${KEY_MAP[$button]}"
        log "Mapping CEC button '$button' to key '$key'"
        send_key "$key"
      elif [ -n "$button" ]; then
        log "WARNING: No key mapping for CEC button '$button'"
      fi
    fi
  done

  log "CEC listener exited"
}

# Signal handling for graceful shutdown
cleanup() {
  log "CEC Daemon shutting down (signal received)"
  exit 0
}

trap cleanup SIGTERM SIGINT

# Load mappings and start listening
load_mappings
listen_for_cec_events

# Restart on disconnect
log "CEC event listener exited, will restart..."
sleep 5
exec "$0"
