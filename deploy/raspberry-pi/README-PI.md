# Prevue Raspberry Pi Cable Box Deployment

Transform your Raspberry Pi into a **retro TV cable box** with Prevue - a cable guide for your Jellyfin media server.

```
┌─────────────────────┐
│  Prevue Cable Box   │  ← Raspberry Pi 4/5 (HDMI)
│  • Fullscreen Guide │
│  • Channel Surfing  │  ← TV Remote (HDMI-CEC)
│  • Auto Playback    │
└─────────────────────┘
         │ LAN
         │
    ┌────┴────┐
    │ Jellyfin│  ← Video Library
    │ Server  │
    └─────────┘
```

## Quick Start

### One-Command Installation

```bash
curl -fsSL https://raw.githubusercontent.com/user/prevue/master/deploy/raspberry-pi/install.sh | sudo bash
```

The script will:
1. ✓ Detect your Raspberry Pi model
2. ✓ Install dependencies (Docker, Epiphany browser, HDMI-CEC, etc.)
3. ✓ Prompt for Jellyfin server configuration
4. ✓ Create systemd services for auto-start
5. ✓ Reboot and boot directly to Prevue

**Installation time:** ~10-15 minutes

### Automated Installation (for scripting)

```bash
curl -fsSL https://raw.githubusercontent.com/user/prevue/master/deploy/raspberry-pi/install.sh | \
  sudo bash -s -- \
  --jellyfin-url "http://jellyfin.local:8096" \
  --jellyfin-user "username" \
  --jellyfin-password "password" \
  --jellyfin-apikey "optional-api-key"
```

## System Requirements

### Recommended Hardware

| Aspect | Recommendation | Minimum |
|--------|---|---|
| **Model** | Raspberry Pi 4/5 (4GB+) | Pi 3B+ |
| **Power** | Official 15W PSU | 12W |
| **Storage** | MicroSD 32GB+ | 16GB |
| **Network** | Gigabit Ethernet | WiFi 5 |
| **Display** | 1080p+ TV with HDMI | Any HDMI TV |

### Performance Targets

**Raspberry Pi 4 (2GB+):**
- Boot to guide: <45 seconds
- Channel switch: <2 seconds
- 1080p playback: Smooth (60fps)

**Raspberry Pi 3B+:**
- Boot to guide: <60 seconds
- Channel switch: <3 seconds
- 1080p playback: 30fps (may need 720p)

## Features

### Appliance Mode
- **Fullscreen Kiosk**: No desktop, no UI chrome
- **Auto-Login**: Boots directly to Prevue
- **Persistent**: Survives power loss gracefully

### Remote Control
- **HDMI-CEC**: Control with your TV remote
- **Fallback**: USB keyboard/mouse support
- **Mapping**: Customizable button mappings

### Jellyfin Integration
- **Local Network**: Auto-discovery on local LAN
- **Remote Server**: Support for internet-based Jellyfin
- **Credentials**: Encrypted storage

### Auto-Recovery
- **Health Monitoring**: Continuous system checks
- **Auto-Restart**: Services recover from crashes
- **Watchdog**: Reboots if unresponsive

## Installation Details

### Prerequisites

Freshly flashed Raspberry Pi OS Lite (64-bit recommended):

```bash
# Flash with Raspberry Pi Imager
# Settings: Enable SSH (if needed), configure WiFi
# Boot and SSH in (or connect keyboard)

# Update system
sudo apt-get update && sudo apt-get upgrade -y
```

### Installation Steps

1. **Run installer:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/user/prevue/master/deploy/raspberry-pi/install.sh | sudo bash
   ```

2. **Follow prompts:**
   - Jellyfin URL (e.g., `http://jellyfin.local:8096`)
   - Username and password
   - Optional API key for security

3. **System reboots** → Boots directly to Prevue cable guide

4. **Test remote control:**
   - Press arrow keys on TV remote
   - Select channel with OK button
   - Exit player with BACK button

## Configuration

### Environment Variables

Edit `/home/prevue/.env` to customize settings:

```bash
# Access via SSH
ssh prevue@<pi-ip>
sudo nano /home/prevue/.env

# Common settings:
JELLYFIN_URL=http://jellyfin.local:8096
JELLYFIN_USER=myuser
JELLYFIN_PASSWORD=mypassword

# Restart to apply changes
sudo systemctl restart prevue.target
```

### Jellyfin Server Discovery

The system attempts to:
1. Auto-discover Jellyfin on local network (mDNS)
2. Accept manual URL entry (`http://192.168.1.100:8096`)
3. Support remote servers (internet-accessible)

**Setting Jellyfin URL examples:**
- Local network: `http://jellyfin.local:8096`
- IP address: `http://192.168.1.50:8096`
- Remote: `https://jellyfin.yourdomain.com`
- With port: `http://localhost:8096`

## Usage

### Navigation

| Button | Action |
|--------|--------|
| **↑↓←→** | Navigate guide |
| **SELECT** | Tune to channel |
| **BACK/EXIT** | Return to guide |
| **CH+/CH-** | Page up/down |
| **PLAY/PAUSE** | Control playback |

### Services

Services auto-start on boot:
- `prevue-docker.service` - Prevue server
- `prevue-kiosk.service` - Epiphany browser display
- `prevue-watchdog.service` - Health monitoring

### Manual Control

```bash
# Stop all services
sudo systemctl stop prevue.target

# Start all services
sudo systemctl start prevue.target

# Restart specific service
sudo systemctl restart prevue-docker.service

# View logs
journalctl -u prevue-docker.service -f
journalctl -u prevue-kiosk.service -f
```

## Maintenance

### Update to Latest Version

```bash
sudo /home/prevue/deploy/maintenance/update.sh
```

This will:
- Create automatic backup
- Pull latest Docker image
- Restart services
- Verify functionality

### Backup Configuration and Data

```bash
sudo /home/prevue/deploy/maintenance/backup.sh
```

Creates timestamped backup file at `/home/prevue/backups/`

### Restore from Backup

```bash
sudo systemctl stop prevue.target
sudo tar -xzf /home/prevue/backups/prevue-backup-YYYYMMDD-HHMMSS.tar.gz -C /home/prevue
sudo systemctl start prevue.target
```

### Factory Reset

```bash
sudo /home/prevue/deploy/maintenance/factory-reset.sh
```

Removes all data and configuration. You'll need to re-run the installer.

## Troubleshooting

### System Won't Boot to Prevue

**Symptom:** Stuck at splash screen or console login

**Solutions:**
1. Check network connectivity:
   ```bash
   ping 8.8.8.8
   ```

2. Check if services started:
   ```bash
   sudo systemctl status prevue.target
   sudo docker ps
   ```

3. View logs:
   ```bash
   journalctl -u prevue-docker.service -n 50
   journalctl -u prevue-kiosk.service -n 50
   ```

### Jellyfin Connection Failed

**Symptom:** "Cannot connect to Jellyfin" message

**Solutions:**
1. Verify Jellyfin server is running:
   ```bash
   curl http://jellyfin-server-ip:8096/health
   ```

2. Update Jellyfin URL:
   ```bash
   ssh prevue@<pi-ip>
   sudo nano /home/prevue/.env
   # Update JELLYFIN_URL and restart
   sudo systemctl restart prevue-docker.service
   ```

3. Check credentials:
   - Verify username/password are correct
   - Check if user has library permissions in Jellyfin

### TV Remote Not Working

**Symptom:** Arrow keys not responding

**Test CEC first:**
```bash
ssh prevue@<pi-ip>
sudo /home/prevue/deploy/input/test-remote.sh
```

**Common issues:**
1. **HDMI-CEC not enabled on TV**
   - Go to TV settings → HDMI → CEC (Enable)
   - Some TVs call it "BRAVIA Sync", "Anynet+", etc.

2. **HDMI cable doesn't support CEC**
   - Try different HDMI cable
   - CEC requires pin 13 connection

3. **Pi not detected by TV**
   - Power-cycle TV and Pi
   - Try different HDMI port
   - Check HDMI is fully inserted

**Fallback options:**
- Use wireless keyboard/mouse
- SSH in and control via API
- Use Prevue web UI from phone/computer

### Browser Crashes or Freezes

**Symptom:** Screen goes black, frozen

**Recovery:**
- Press Ctrl+Alt+F1 for emergency TTY
- SSH in and restart kiosk:
  ```bash
  sudo systemctl restart prevue-kiosk.service
  ```

**Prevention:**
- Epiphany is lightweight and rarely crashes
- If issues occur, check system resources:
  ```bash
  free -h  # Check available RAM
  top     # Monitor CPU/memory usage
  ```

### High CPU Temperature

**Symptom:** `prevue status` shows temp >80°C

**Solutions:**
1. Improve ventilation
2. Add heatsink/fan
3. Reduce quality in Jellyfin transcoding settings

## Performance Tuning

### GPU Memory Allocation

For smooth video, allocate 128MB+ GPU memory:

```bash
# Check current allocation
grep gpu_mem /boot/config.txt

# If not set, add:
echo "gpu_mem=256" | sudo tee -a /boot/config.txt
sudo reboot
```

### VAAPI Hardware Acceleration

Enable in Jellyfin for better transcoding:

```bash
# In Jellyfin dashboard:
# Admin → Playback → Transcoding → Hardware acceleration
# Select: VAAPI (if available on your system)
```

### Network Optimization

For smooth streaming, ensure:
1. Gigabit or high-quality WiFi connection
2. Stable 20+ Mbps for 1080p
3. Low latency (<50ms round-trip)

Test with:
```bash
iperf3 -c jellyfin-server
```

## Security Considerations

### API Key Protection

Set a strong API key to prevent unauthorized access:

```bash
# Edit .env
sudo nano /home/prevue/.env

# Add random API key (32+ characters)
PREVUE_API_KEY=your-random-string-here

# Restart
sudo systemctl restart prevue-docker.service
```

### SSH Hardening

Change default password and use SSH keys:

```bash
# Change password
passwd

# Generate SSH key on your computer
ssh-keygen -t ed25519

# Add to Pi
ssh-copy-id -i ~/.ssh/id_ed25519.pub prevue@<pi-ip>

# Disable password auth
sudo sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

### Network Access

Keep Prevue on local network only. If exposing to internet:
- Use reverse proxy (nginx, Caddy)
- Enable HTTPS
- Set strong PREVUE_API_KEY

## Advanced Configuration

### Custom Jellyfin Server

If auto-discovery fails, manually specify URL:

```bash
sudo nano /home/prevue/.env

# Example configurations:
JELLYFIN_URL=http://192.168.1.50:8096           # Local IP
JELLYFIN_URL=http://jellyfin.example.com         # Domain
JELLYFIN_URL=https://jellyfin.example.com        # HTTPS
JELLYFIN_URL=http://192.168.1.50:8096/jellyfin   # Subpath

sudo systemctl restart prevue-docker.service
```

### Custom CEC Keymaps

Edit button mappings:

```bash
sudo nano /etc/prevue-cec-mapping.conf

# Format: CEC_BUTTON=X11_KEY
UP=Up
DOWN=Down
SELECT=Return
EXIT=Escape

sudo systemctl restart cec-keymapper.service
```

### Enable Debug Logging

```bash
# Docker debug output
DOCKER_BUILDKIT=1 docker compose -f /home/prevue/docker-compose.rpi.yml logs -f

# CEC daemon debug
tail -f /home/prevue/logs/cec-daemon.log

# Systemd journal
journalctl -xe
```

## Support & Issues

### Getting Help

1. **Check logs:**
   ```bash
   sudo /home/prevue/deploy/maintenance/health-check.sh --report
   ```

2. **Run diagnostic:**
   ```bash
   journalctl -u prevue.target -n 100
   ```

3. **Test components:**
   ```bash
   sudo /home/prevue/deploy/input/test-remote.sh
   ```

### Known Limitations

- **Pi Zero/Zero 2W:** Not recommended (marginal performance)
- **Pi 3 A/B:** 720p playback recommended
- **32-bit OS:** Works but 64-bit is recommended
- **Transcoding:** Happens on Jellyfin server, not Pi

### Reporting Bugs

Please include:
- Raspberry Pi model and OS version
- Last 50 lines of: `journalctl -u prevue.target -n 50`
- Output of: `/home/prevue/deploy/maintenance/health-check.sh --report --json`

## FAQ

**Q: Can I use this with Emby or Plex?**
A: Not currently. Prevue is designed specifically for Jellyfin's REST API. Other media servers would require adapting the integration.

**Q: How much disk space does Prevue use?**
A: ~150MB for the application. Database depends on library size but typically <50MB.

**Q: Can I access Prevue from other devices?**
A: Yes! It's a web app. Access at `http://<pi-ip>:3080` from any browser. For remote access, set up a reverse proxy.

**Q: Does the Pi do any transcoding?**
A: No. All transcoding is handled by Jellyfin server. The Pi only proxies streams.

**Q: What if my TV doesn't support HDMI-CEC?**
A: Use a wireless keyboard/mouse or IR remote adapter (~$10 on Amazon).

**Q: Can I run Jellyfin on the Pi too?**
A: Theoretically yes, but not recommended. CPU-only transcoding won't work well. Better to run Jellyfin on a separate server.

**Q: How often should I backup?**
A: Before any updates. Run `sudo /home/prevue/deploy/maintenance/backup.sh` regularly.

## More Information

- **GitHub:** https://github.com/user/prevue
- **Jellyfin:** https://jellyfin.org/
- **Raspberry Pi:** https://www.raspberrypi.com/
- **HDMI-CEC:** https://en.wikipedia.org/wiki/HDMI#CEC

---

**Happy cable surfing!** 📺
