# Deployment

## Docker

```bash
cp .env.example .env
# Edit .env with your settings (API key, encryption key, OpenRouter key, etc.)

docker compose up -d
```

Open `http://localhost:3080` in your browser.
Go to **Settings > Servers** to connect your Jellyfin or Plex server. Your library will sync automatically and channels will be generated on first run.

### Jellyfin Discovery in Docker

If **Discover Servers** returns no results, this is usually Docker networking (not a Prevue bug).
In bridge mode, container LAN discovery can miss Jellyfin broadcasts/subnets.

- Recommended fallback: manually enter your Jellyfin URL (e.g. `http://<jellyfin-ip>:8096`).
- Optional (Linux): use host networking by adding `network_mode: host` to your compose service.

> **Note:** Server discovery is only available for Jellyfin. Plex servers are discovered automatically via plex.tv after signing in.

## Development

```bash
npm install
cp .env.example .env
npm run dev
```

- Client: http://localhost:5173 (Vite dev server, proxies API to :3080)
- Server: http://localhost:3080

## Mobile App (PWA)

Prevue can be installed as a PWA on iOS, Android, and desktop. No app store needed.

### iOS (Safari)

1. Open your Prevue instance in Safari
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Name it "Prevue" and tap **Add**

### Android (Chrome)

1. Open your Prevue instance in Chrome
2. Tap the **three-dot menu**
3. Tap **Install app** or **Add to Home Screen**

Runs in standalone mode (no browser chrome), caches app assets offline, and handles deep links to channels.

## Raspberry Pi Cable Box

Turn a Raspberry Pi into a dedicated cable box connected to your TV via HDMI.

```bash
# One-command installation (on fresh Raspberry Pi OS)
curl -fsSL https://raw.githubusercontent.com/user/prevue/master/deploy/raspberry-pi/install.sh | sudo bash
```

- Boots directly to fullscreen Prevue guide (X11 + Chromium kiosk)
- TV remote control via HDMI-CEC
- Keyboard/mouse fallback support
- Auto-recovery from crashes
- One-click updates
- Works with local or remote Jellyfin/Plex

See [Raspberry Pi Deployment Guide](../deploy/raspberry-pi/README-PI.md) for detailed setup.
