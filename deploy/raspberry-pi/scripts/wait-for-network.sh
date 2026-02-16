#!/bin/bash
# Wait for network connectivity before starting services
# Used by systemd as ExecStartPre to ensure network is ready

set -e

TIMEOUT=${WAIT_FOR_TIMEOUT:-120}  # seconds
HOST=${WAIT_FOR_HOST:-8.8.8.8}
INTERVAL=2
ELAPSED=0

echo "[$(date)] Waiting for network connectivity (max ${TIMEOUT}s)..."

# Wait for network link
echo "[$(date)] Checking for network link..."
LINK_TIMEOUT=30
LINK_ELAPSED=0
while [ $LINK_ELAPSED -lt $LINK_TIMEOUT ]; do
  if ip link show | grep -q "state UP"; then
    echo "[$(date)] Network link detected"
    break
  fi
  sleep $INTERVAL
  LINK_ELAPSED=$((LINK_ELAPSED + $INTERVAL))
done

# Wait for actual connectivity via DNS/ping
echo "[$(date)] Checking connectivity to $HOST..."
while [ $ELAPSED -lt $TIMEOUT ]; do
  if ping -c 1 -W 2 "$HOST" > /dev/null 2>&1; then
    echo "[$(date)] Network is ready after ${ELAPSED}s"
    exit 0
  fi

  if [ $ELAPSED -eq 0 ]; then
    echo "[$(date)] No response from $HOST, will retry..."
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + $INTERVAL))
done

echo "[$(date)] ERROR: Network did not become ready within ${TIMEOUT}s"
echo "[$(date)] This may cause services to fail to start"
exit 1
