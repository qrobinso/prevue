#!/bin/bash
# Prevue Raspberry Pi Installation Script
# One-command installation for Cable Box deployment
#
# Usage:
#   Interactive:  curl -fsSL https://...install.sh | sudo bash
#   Automated:    curl -fsSL https://...install.sh | sudo bash -s -- \
#                   --jellyfin-url "http://..." \
#                   --jellyfin-user "user" \
#                   --jellyfin-password "pass"

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="https://github.com/user/prevue"
REPO_BRANCH="master"
INSTALL_DIR="/home/prevue"
DEPLOY_DIR="$INSTALL_DIR/deploy/raspberry-pi"
DATA_DIR="$INSTALL_DIR/data"
LOG_FILE="/var/log/prevue-install.log"

# Defaults (can be overridden by args)
JELLYFIN_URL=""
JELLYFIN_USER=""
JELLYFIN_PASSWORD=""
JELLYFIN_APIKEY=""
INTERACTIVE=true
SKIP_REBOOT=false

# Logging functions
log() {
  echo -e "${BLUE}[INSTALL]${NC} $*" | tee -a "$LOG_FILE"
}

success() {
  echo -e "${GREEN}[✓]${NC} $*" | tee -a "$LOG_FILE"
}

error() {
  echo -e "${RED}[✗ ERROR]${NC} $*" | tee -a "$LOG_FILE"
  exit 1
}

warn() {
  echo -e "${YELLOW}[!]${NC} $*" | tee -a "$LOG_FILE"
}

# Parse command line arguments
parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --jellyfin-url)
        JELLYFIN_URL="$2"
        INTERACTIVE=false
        shift 2
        ;;
      --jellyfin-user)
        JELLYFIN_USER="$2"
        shift 2
        ;;
      --jellyfin-password)
        JELLYFIN_PASSWORD="$2"
        shift 2
        ;;
      --jellyfin-apikey)
        JELLYFIN_APIKEY="$2"
        shift 2
        ;;
      --skip-reboot)
        SKIP_REBOOT=true
        shift
        ;;
      *)
        warn "Unknown argument: $1"
        shift
        ;;
    esac
  done
}

# Detect Raspberry Pi model
detect_pi_model() {
  if [ ! -f /proc/device-tree/model ]; then
    error "This does not appear to be a Raspberry Pi"
  fi

  PI_MODEL=$(tr -d '\0' < /proc/device-tree/model)
  log "Detected: $PI_MODEL"

  # Detect architecture
  ARCH=$(uname -m)
  case $ARCH in
    aarch64)
      ARCH_DISPLAY="ARM64 (64-bit)"
      ;;
    armv7l)
      ARCH_DISPLAY="ARMv7 (32-bit)"
      ;;
    *)
      error "Unsupported architecture: $ARCH"
      ;;
  esac

  log "Architecture: $ARCH_DISPLAY"
}

# Check if running as root
check_root() {
  if [ "$EUID" -ne 0 ]; then
    error "This script must be run with sudo"
  fi
}

# Update system
update_system() {
  log "Updating system packages..."
  apt-get update -qq || error "Failed to update package lists"
  apt-get upgrade -y -qq || warn "Some packages failed to upgrade"
  success "System packages updated"
}

# Install dependencies
install_dependencies() {
  log "Installing dependencies..."

  DEPS=(
    "curl"
    "wget"
    "git"
    "docker.io"
    "docker-compose"
    "chromium-browser"
    "openbox"
    "xserver-xorg"
    "xserver-xorg-core"
    "x11-xserver-utils"
    "x11-common"
    "xinit"
    "unclutter"
    "libcec-dev"
    "libcec4"
    "cec-utils"
    "python3"
    "python3-pip"
  )

  for dep in "${DEPS[@]}"; do
    if dpkg -l | grep -q "^ii  $dep"; then
      log "$dep already installed"
    else
      log "Installing $dep..."
      apt-get install -y "$dep" 2>&1 | grep -v "^Get:" | grep -v "^Unpacking" || warn "Failed to install $dep"
    fi
  done

  success "Dependencies installed"
}

# Create prevue user and directories
setup_user_and_dirs() {
  log "Setting up prevue user and directories..."

  if id "prevue" &>/dev/null; then
    log "User prevue already exists"
  else
    log "Creating prevue user..."
    useradd -m -s /bin/bash -G docker,dialout,video prevue || error "Failed to create prevue user"
    success "User prevue created"
  fi

  # Create directories
  mkdir -p "$DATA_DIR" "$INSTALL_DIR/logs"
  chown -R prevue:prevue "$INSTALL_DIR"
  chmod 700 "$DATA_DIR"

  success "Directories created"
}

# Generate secure encryption key
generate_encryption_key() {
  # Generate 32-byte random key (base64 encoded)
  openssl rand -base64 32 | tr -d '\n'
}

# Interactive configuration
interactive_config() {
  if [ "$INTERACTIVE" = false ] && [ -n "$JELLYFIN_URL" ]; then
    return
  fi

  # Check if stdin is available (not piped)
  if ! [ -t 0 ]; then
    # Try to redirect from /dev/tty if available
    if [ -c /dev/tty ]; then
      exec < /dev/tty
    else
      error "Interactive mode requires terminal access. Use command-line arguments instead:"
      error ""
      error "  curl -fsSL https://...install.sh | sudo bash -s -- \\"
      error "    --jellyfin-url \"http://jellyfin.local:8096\" \\"
      error "    --jellyfin-user \"username\" \\"
      error "    --jellyfin-password \"password\""
    fi
  fi

  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}   Prevue Raspberry Pi Cable Box Installation${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
  echo ""

  log "Jellyfin Server Configuration"
  echo ""

  # Jellyfin URL
  read -p "Enter Jellyfin server URL (e.g., http://jellyfin.local:8096): " JELLYFIN_URL
  [ -z "$JELLYFIN_URL" ] && error "Jellyfin URL is required"

  # Jellyfin credentials
  read -p "Enter Jellyfin username: " JELLYFIN_USER
  [ -z "$JELLYFIN_USER" ] && error "Jellyfin username is required"

  read -s -p "Enter Jellyfin password: " JELLYFIN_PASSWORD
  echo ""
  [ -z "$JELLYFIN_PASSWORD" ] && error "Jellyfin password is required"

  # Optional API key
  read -p "Enter Prevue API key (optional, press Enter to skip): " JELLYFIN_APIKEY

  echo ""
  log "Configuration Summary:"
  echo "  Jellyfin URL: $JELLYFIN_URL"
  echo "  Username: $JELLYFIN_USER"
  echo "  API Key: $([ -z "$JELLYFIN_APIKEY" ] && echo "Not set" || echo "Set")"
  echo ""

  read -p "Continue with these settings? (y/n) " -n 1 -r
  echo
  [[ ! $REPLY =~ ^[Yy]$ ]] && error "Installation cancelled"
}

# Test Jellyfin connection
test_jellyfin_connection() {
  log "Testing Jellyfin connection..."

  # Simple connectivity test
  if curl -s --max-time 5 "$JELLYFIN_URL/health" > /dev/null; then
    success "Jellyfin server is reachable"
    return 0
  else
    warn "Could not reach Jellyfin server at $JELLYFIN_URL"
    warn "Installation will continue, but verify settings after first boot"
    return 1
  fi
}

# Configure system settings
configure_system() {
  log "Configuring system settings..."

  # Disable screen blanking
  if ! grep -q "hdmi_blanking=" /boot/config.txt; then
    echo "hdmi_blanking=1" >> /boot/config.txt
  fi

  # Allocate GPU memory
  if grep -q "^gpu_mem=" /boot/config.txt; then
    sed -i 's/^gpu_mem=.*/gpu_mem=128/' /boot/config.txt
  else
    echo "gpu_mem=128" >> /boot/config.txt
  fi

  # Enable hardware video decode
  if ! grep -q "^start_x=1" /boot/config.txt; then
    echo "start_x=1" >> /boot/config.txt
  fi

  # Disable overscan by default (modern TVs don't need it)
  if ! grep -q "^disable_overscan=" /boot/config.txt; then
    echo "disable_overscan=1" >> /boot/config.txt
  fi

  success "System settings configured"
}

# Generate .env file
generate_env_file() {
  log "Generating environment configuration..."

  ENCRYPTION_KEY=$(generate_encryption_key)

  cat > "$INSTALL_DIR/.env" << EOF
# Prevue Environment Configuration
# Generated by install.sh on $(date)

# Server Configuration
PORT=3080
NODE_ENV=production

# Security
DATA_ENCRYPTION_KEY=$ENCRYPTION_KEY
PREVUE_API_KEY=$JELLYFIN_APIKEY
TRUST_PROXY=false

# Jellyfin Integration
JELLYFIN_URL=$JELLYFIN_URL
JELLYFIN_USER=$JELLYFIN_USER
JELLYFIN_PASSWORD=$JELLYFIN_PASSWORD
PREVUE_ALLOW_PRIVATE_URLS=1

# Network Configuration
WAIT_FOR_HOST=8.8.8.8

# Optional: CORS Configuration
# ALLOWED_ORIGINS=http://localhost:3080

# Optional: AI Channel Generation (OpenRouter API)
# OPENROUTER_API_KEY=

# Optional: Schedule Configuration
# SCHEDULE_BLOCK_HOURS=4

EOF

  chmod 600 "$INSTALL_DIR/.env"
  chown prevue:prevue "$INSTALL_DIR/.env"
  success "Environment file created at $INSTALL_DIR/.env"
}

# Copy deployment files
copy_deployment_files() {
  log "Setting up deployment files..."

  # Check if this is being run from a git clone
  if [ -d "deploy/raspberry-pi" ]; then
    log "Found deployment files in current directory"
    cp -r deploy/raspberry-pi "$INSTALL_DIR/"
    chown -R prevue:prevue "$DEPLOY_DIR"
    chmod +x "$DEPLOY_DIR"/kiosk/*.sh "$DEPLOY_DIR"/scripts/*.sh "$DEPLOY_DIR"/maintenance/*.sh "$DEPLOY_DIR"/input/*.sh 2>/dev/null || true
  else
    # Download files from GitHub
    log "Downloading deployment files from GitHub..."

    mkdir -p "$DEPLOY_DIR"/{systemd,kiosk,input,scripts,maintenance}

    local files=(
      "docker-compose.rpi.yml"
      "systemd/prevue.target"
      "systemd/prevue-docker.service"
      "systemd/prevue-kiosk.service"
      "systemd/prevue-watchdog.service"
      "kiosk/start-kiosk.sh"
      "kiosk/openbox-rc.xml"
      "kiosk/splash.html"
      "input/libcec-setup.sh"
      "input/cec-daemon.sh"
      "input/cec-keymapper.service"
      "input/test-remote.sh"
      "scripts/wait-for-network.sh"
      "scripts/detect-display.sh"
      "maintenance/health-check.sh"
      "maintenance/update.sh"
      "maintenance/backup.sh"
      "maintenance/factory-reset.sh"
    )

    local failed=0
    for file in "${files[@]}"; do
      local url="https://raw.githubusercontent.com/qrobinso/prevue/master/deploy/raspberry-pi/$file"
      local dest="$DEPLOY_DIR/$file"

      if curl -fsSL "$url" -o "$dest"; then
        log "Downloaded: $file"
      else
        warn "Failed to download: $file"
        failed=$((failed + 1))
      fi
    done

    if [ $failed -gt 0 ]; then
      warn "Failed to download $failed files"
    else
      success "All deployment files downloaded from GitHub"
    fi

    # Set permissions
    chown -R prevue:prevue "$DEPLOY_DIR"
    chmod +x "$DEPLOY_DIR"/kiosk/*.sh "$DEPLOY_DIR"/scripts/*.sh "$DEPLOY_DIR"/maintenance/*.sh "$DEPLOY_DIR"/input/*.sh 2>/dev/null || true
  fi

  success "Deployment files ready"
}

# Install systemd services
install_systemd_services() {
  log "Installing systemd services..."

  SERVICES=(
    "prevue.target"
    "prevue-docker.service"
    "prevue-kiosk.service"
    "prevue-watchdog.service"
  )

  local installed=0
  for service in "${SERVICES[@]}"; do
    local src="$DEPLOY_DIR/systemd/$service"
    if [ -f "$src" ]; then
      if cp "$src" /etc/systemd/system/; then
        log "Installed $service"
        installed=$((installed + 1))
      else
        error "Failed to copy $service to /etc/systemd/system/"
      fi
    else
      error "Service file not found: $src"
    fi
  done

  if [ $installed -eq 0 ]; then
    error "No systemd services were installed. Files may not have downloaded correctly."
  fi

  # Reload systemd daemon
  systemctl daemon-reload || error "Failed to reload systemd daemon"

  if [ $installed -gt 0 ]; then
    success "Systemd services installed ($installed/$((${#SERVICES[@]})))"
  fi
}

# Enable services
enable_services() {
  log "Enabling services..."

  SERVICES=(
    "prevue.target"
    "prevue-docker.service"
    "prevue-kiosk.service"
    "prevue-watchdog.service"
  )

  local enabled=0
  for service in "${SERVICES[@]}"; do
    # Check if service exists first
    if systemctl list-unit-files | grep -q "^${service}"; then
      if systemctl enable "$service" > /dev/null 2>&1; then
        log "Enabled $service"
        enabled=$((enabled + 1))
      else
        error "Failed to enable $service"
      fi
    else
      error "Service not found: $service"
    fi
  done

  if [ $enabled -gt 0 ]; then
    success "Services enabled for auto-start ($enabled/$((${#SERVICES[@]})))"
  else
    error "No services were enabled"
  fi
}

# Configure auto-login
configure_autologin() {
  log "Configuring auto-login..."

  # This varies by display manager, try lightdm first (common on Pi OS)
  if command -v lightdm &> /dev/null; then
    if [ -f /etc/lightdm/lightdm.conf ]; then
      if ! grep -q "autologin-user=prevue" /etc/lightdm/lightdm.conf; then
        sed -i '/\[seat:\*\]/a autologin-user=prevue' /etc/lightdm/lightdm.conf || true
        log "Configured lightdm auto-login"
      fi
    fi
  else
    warn "lightdm not found, skipping auto-login configuration"
    warn "You may need to manually log in as 'prevue' user after boot"
  fi

  success "Auto-login configuration complete"
}

# Configure docker
configure_docker() {
  log "Configuring Docker..."

  # Ensure docker group exists
  groupadd -f docker

  # Add prevue to docker group (already done in useradd, but verify)
  usermod -aG docker prevue

  # Enable docker service
  systemctl enable docker || warn "Failed to enable docker"
  systemctl start docker || error "Failed to start docker"

  success "Docker configured"
}

# Create openbox config
create_openbox_config() {
  log "Creating Openbox configuration..."

  OPENBOX_CONFIG="/home/prevue/.config/openbox/rc.xml"
  mkdir -p "$(dirname "$OPENBOX_CONFIG")"

  if [ -f "$DEPLOY_DIR/kiosk/openbox-rc.xml" ]; then
    cp "$DEPLOY_DIR/kiosk/openbox-rc.xml" "$OPENBOX_CONFIG"
  fi

  chown -R prevue:prevue "/home/prevue/.config"
  success "Openbox configuration created"
}

# Summary
installation_summary() {
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}   Installation Complete!${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "Your Raspberry Pi is configured for Prevue Cable Box mode."
  echo ""
  echo "Installation Log: $LOG_FILE"
  echo ""
  echo "System Information:"
  echo "  Model: $PI_MODEL"
  echo "  Architecture: $ARCH_DISPLAY"
  echo "  Install Directory: $INSTALL_DIR"
  echo ""
  echo "Configuration:"
  echo "  Jellyfin URL: $JELLYFIN_URL"
  echo "  Jellyfin User: $JELLYFIN_USER"
  echo ""
  echo "Services Enabled:"
  echo "  ✓ prevue-docker (Prevue server)"
  echo "  ✓ prevue-kiosk (Chromium display)"
  echo "  ✓ prevue-watchdog (Auto-recovery)"
  echo ""

  if [ "$SKIP_REBOOT" = true ]; then
    echo -e "${YELLOW}Reboot skipped. To complete setup, run:${NC}"
    echo "  sudo reboot"
  else
    echo -e "${GREEN}The system will reboot in 30 seconds...${NC}"
    echo "Press Ctrl+C to cancel reboot."
  fi

  echo ""
}

# Main installation flow
main() {
  log "Starting Prevue Raspberry Pi Installation"
  log "Logging to $LOG_FILE"
  echo ""

  check_root
  detect_pi_model
  parse_args "$@"
  interactive_config
  update_system
  install_dependencies
  setup_user_and_dirs
  test_jellyfin_connection
  configure_system
  generate_env_file
  copy_deployment_files
  install_systemd_services
  enable_services
  configure_autologin
  configure_docker
  create_openbox_config

  installation_summary

  if [ "$SKIP_REBOOT" = false ]; then
    sleep 30
    log "Rebooting system..."
    reboot
  fi
}

# Run main function with all passed arguments
main "$@"
