#!/bin/bash
# Prevue System Health Check
# Monitors system components and auto-recovery
#
# Usage:
#   Daemon mode: health-check.sh --daemon
#   One-shot:    health-check.sh --report
#   JSON output: health-check.sh --report --json

set -e

# Configuration
DOCKER_CONTAINER="prevue"
API_ENDPOINT="http://localhost:3080/api/health"
CHECK_INTERVAL=60  # seconds
RESTART_THRESHOLD=3  # consecutive failures before restart
LOG_FILE="/home/prevue/logs/watchdog.log"
HEARTBEAT_FILE="/tmp/prevue-heartbeat"

# State
CONSECUTIVE_FAILURES=0
LAST_CONTAINER_RESTART=0

# Logging
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Health check for API
check_api_health() {
  curl -sf --max-time 5 "$API_ENDPOINT" > /dev/null 2>&1
  return $?
}

# Check if Docker container is running
check_container_status() {
  docker ps | grep -q "$DOCKER_CONTAINER"
  return $?
}

# Check if Chromium process is running
check_chromium_status() {
  pgrep -f "chromium-browser.*--kiosk" > /dev/null
  return $?
}

# Check network connectivity
check_network() {
  # Try to ping a reliable host
  ping -c 1 -W 2 8.8.8.8 > /dev/null 2>&1 || \
  ping -c 1 -W 2 1.1.1.1 > /dev/null 2>&1
  return $?
}

# Restart Docker container
restart_docker() {
  log "Attempting to restart Docker container..."
  systemctl restart prevue-docker.service || {
    log "Failed to restart Docker service"
    return 1
  }

  LAST_CONTAINER_RESTART=$(date +%s)
  sleep 10  # Wait for container to be ready
  return 0
}

# Restart kiosk service
restart_kiosk() {
  log "Attempting to restart kiosk service..."
  systemctl restart prevue-kiosk.service || {
    log "Failed to restart kiosk service"
    return 1
  }

  sleep 5
  return 0
}

# Reboot system (last resort)
reboot_system() {
  log "ERROR: Repeated failures detected, initiating system reboot..."
  /sbin/shutdown -r +1 "Prevue system recovery"
}

# Update heartbeat file
update_heartbeat() {
  echo "$(date +%s)" > "$HEARTBEAT_FILE"
}

# Generate health report
generate_report() {
  local json_format=${1:-false}

  local api_ok=0
  local container_ok=0
  local chromium_ok=0
  local network_ok=0
  local timestamp=$(date -Is)

  check_api_health && api_ok=1
  check_container_status && container_ok=1
  check_chromium_status && chromium_ok=1
  check_network && network_ok=1

  if [ "$json_format" = true ]; then
    cat << EOF
{
  "timestamp": "$timestamp",
  "status": $((api_ok && container_ok && chromium_ok ? 1 : 0)),
  "components": {
    "api": $api_ok,
    "container": $container_ok,
    "chromium": $chromium_ok,
    "network": $network_ok
  },
  "failures": $CONSECUTIVE_FAILURES
}
EOF
  else
    echo "Prevue Health Check Report - $timestamp"
    echo "============================================"
    echo "API Health:           $([ $api_ok -eq 1 ] && echo 'OK' || echo 'FAILED')"
    echo "Docker Container:     $([ $container_ok -eq 1 ] && echo 'OK' || echo 'FAILED')"
    echo "Chromium Browser:     $([ $chromium_ok -eq 1 ] && echo 'OK' || echo 'FAILED')"
    echo "Network Connectivity: $([ $network_ok -eq 1 ] && echo 'OK' || echo 'FAILED')"
    echo ""
    echo "Overall Status: $([ $((api_ok && container_ok && chromium_ok)) -eq 1 ] && echo 'HEALTHY' || echo 'DEGRADED')"
    echo "Consecutive Failures: $CONSECUTIVE_FAILURES/$RESTART_THRESHOLD"
  fi
}

# Perform health checks and take action
perform_health_check() {
  local api_failed=false
  local container_failed=false
  local chromium_failed=false
  local network_failed=false

  # Perform individual checks
  if ! check_api_health; then
    api_failed=true
  fi

  if ! check_container_status; then
    container_failed=true
  fi

  if ! check_chromium_status; then
    chromium_failed=true
  fi

  if ! check_network; then
    network_failed=true
  fi

  # Determine action
  if [ "$api_failed" = true ] || [ "$container_failed" = true ]; then
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    log "Health check failed (failure count: $CONSECUTIVE_FAILURES/3)"
    log "  API: $([ "$api_failed" = true ] && echo 'FAILED' || echo 'OK')"
    log "  Container: $([ "$container_failed" = true ] && echo 'FAILED' || echo 'OK')"
    log "  Chromium: $([ "$chromium_failed" = true ] && echo 'FAILED' || echo 'OK')"
    log "  Network: $([ "$network_failed" = true ] && echo 'FAILED' || echo 'OK')"

    # Take recovery action based on failure count
    if [ $CONSECUTIVE_FAILURES -eq 1 ] && [ "$container_failed" = true ]; then
      log "Restarting Docker container..."
      restart_docker || log "Failed to restart Docker"

    elif [ $CONSECUTIVE_FAILURES -eq 2 ] && [ "$chromium_failed" = true ]; then
      log "Restarting kiosk service..."
      restart_kiosk || log "Failed to restart kiosk"

    elif [ $CONSECUTIVE_FAILURES -ge $RESTART_THRESHOLD ]; then
      log "Threshold reached, initiating system reboot"
      reboot_system
    fi
  else
    # All systems healthy
    if [ $CONSECUTIVE_FAILURES -gt 0 ]; then
      log "System recovered after $CONSECUTIVE_FAILURES failures"
    fi
    CONSECUTIVE_FAILURES=0
    update_heartbeat
  fi
}

# Daemon mode (continuous monitoring)
daemon_mode() {
  mkdir -p "$(dirname "$LOG_FILE")"
  log "Starting Prevue health watchdog daemon"

  while true; do
    perform_health_check
    sleep $CHECK_INTERVAL
  done
}

# Parse arguments
mode="daemon"
json_output=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --daemon)
      mode="daemon"
      shift
      ;;
    --report)
      mode="report"
      shift
      ;;
    --json)
      json_output=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Run in selected mode
case $mode in
  daemon)
    daemon_mode
    ;;
  report)
    generate_report $json_output
    ;;
  *)
    echo "Unknown mode: $mode"
    exit 1
    ;;
esac
