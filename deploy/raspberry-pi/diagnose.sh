#!/bin/bash
# Prevue Diagnostic Script
# Helps identify what's going wrong with downloads and installation

echo "════════════════════════════════════════════════════════════"
echo "   Prevue Diagnostic Tool"
echo "════════════════════════════════════════════════════════════"
echo ""

# Check system info
echo "1. System Information"
echo "===================="
uname -a
echo ""

# Check internet connectivity
echo "2. Internet Connectivity"
echo "======================="
echo "Testing DNS resolution..."
nslookup github.com 2>&1 | head -5

echo ""
echo "Testing connection to GitHub..."
curl -I https://raw.githubusercontent.com/qrobinso/prevue/master/deploy/raspberry-pi/install.sh 2>&1 | head -5

echo ""

# Check directory permissions
echo "3. Directory Permissions"
echo "======================="
ls -la /home/ | grep prevue
echo ""
ls -la /home/prevue/ 2>/dev/null || echo "/home/prevue does not exist"
echo ""

# Test curl with verbose output
echo "4. Test Download (Verbose)"
echo "=========================="
echo "Attempting to download a single file with verbose output..."
echo ""
curl -v https://raw.githubusercontent.com/qrobinso/prevue/master/deploy/raspberry-pi/scripts/wait-for-network.sh -o /tmp/test-download.sh 2>&1 | head -30
echo ""

# Check if download succeeded
echo "5. Download Result"
echo "=================="
if [ -f /tmp/test-download.sh ]; then
  echo "✓ Download succeeded"
  echo "File size: $(stat -f%z /tmp/test-download.sh 2>/dev/null || stat -c%s /tmp/test-download.sh)"
  echo "First 5 lines:"
  head -5 /tmp/test-download.sh
  rm /tmp/test-download.sh
else
  echo "✗ Download FAILED"
  echo "File was not created at /tmp/test-download.sh"
fi

echo ""

# Check curl version
echo "6. Curl Version"
echo "==============="
curl --version | head -2

echo ""

# Check available disk space
echo "7. Disk Space"
echo "============="
df -h / | tail -1

echo ""

# Check network interfaces
echo "8. Network Interfaces"
echo "===================="
ip addr show 2>/dev/null | grep -E "inet|UP|eth|wlan" | head -10

echo ""
echo "════════════════════════════════════════════════════════════"
echo "   Diagnostics Complete"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Share this output to help diagnose the issue!"
