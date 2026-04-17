import { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import {
  getServers, addServer, deleteServer, resyncServer,
  discoverServers, reauthenticateServer, requestPlexPin, checkPlexPin,
  getPlexServers, connectPlexServer, getLibraryStats,
  type ServerInfo, type DiscoveredServer, type PlexServerInfo, type LibraryStats,
} from '../../services/api';
import { Hexagon } from '@phosphor-icons/react';
import { useNotifications } from '../../notifications';

interface ServerSettingsProps {
  onServerAdded?: (server: ServerInfo) => void;
}

type ProviderType = 'jellyfin' | 'plex';
type PlexStep = 'qr' | 'servers' | 'connecting';

export default function ServerSettings({ onServerAdded }: ServerSettingsProps) {
  const { confirm, toast } = useNotifications();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [providerType, setProviderType] = useState<ProviderType>('jellyfin');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  // Plex auth state
  const [plexStep, setPlexStep] = useState<PlexStep>('qr');
  const [plexAuthUrl, setPlexAuthUrl] = useState('');
  const [plexPinId, setPlexPinId] = useState<number | null>(null);
  const [plexClientId, setPlexClientId] = useState('');
  const [plexAuthToken, setPlexAuthToken] = useState('');
  const [plexServers, setPlexServers] = useState<PlexServerInfo[]>([]);
  const [plexQrDataUrl, setPlexQrDataUrl] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [libraryStats, setLibraryStats] = useState<LibraryStats | null>(null);

  const activeServer = servers.find(s => s.is_active) ?? servers[0] ?? null;

  const loadLibraryStats = async () => {
    try {
      const stats = await getLibraryStats();
      setLibraryStats(stats);
    } catch {
      // Stats are non-critical
    }
  };

  const loadServers = async () => {
    try {
      const data = await getServers();
      setServers(data);
    } catch {
      setError('Failed to load servers');
    } finally {
      setLoading(false);
    }
  };

  const runDiscovery = async () => {
    setDiscovering(true);
    try {
      const found = await discoverServers();
      setDiscovered(found);
    } catch {
      // Discovery failed silently
    } finally {
      setDiscovering(false);
    }
  };

  useEffect(() => { loadServers(); loadLibraryStats(); }, []);

  useEffect(() => {
    if (showSetup && providerType === 'jellyfin') {
      runDiscovery();
    } else {
      setDiscovered([]);
    }
  }, [showSetup, providerType]);

  // Cleanup Plex polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const resetSetupForm = useCallback(() => {
    setShowSetup(false);
    setError('');
    setName('');
    setUrl('');
    setUsername('');
    setPassword('');
    setPlexStep('qr');
    setPlexAuthUrl('');
    setPlexPinId(null);
    setPlexClientId('');
    setPlexAuthToken('');
    setPlexServers([]);
    setPlexQrDataUrl('');
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const handleSelectDiscovered = (server: DiscoveredServer) => {
    setName(server.name);
    setUrl(server.address);
  };

  const handleConnect = async () => {
    try {
      setError('');
      setConnecting(true);
      const server = await addServer(name, url, username, password);
      resetSetupForm();
      await loadServers();
      if (server.is_active) {
        onServerAdded?.(server);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!activeServer) return;
    const ok = await confirm({
      title: 'Disconnect Server',
      message: `Disconnect "${activeServer.name}"? Channels and schedules tied to this server will be removed.`,
      confirmLabel: 'Disconnect',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteServer(activeServer.id);
      await loadServers();
    } catch (err) {
      toast({ variant: 'error', message: (err as Error).message });
    }
  };

  const handleReauthenticate = async () => {
    if (!activeServer) return;
    try {
      setError('');
      await reauthenticateServer(activeServer.id, reauthPassword);
      setReauthOpen(false);
      setReauthPassword('');
      await loadServers();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleResync = async () => {
    if (!activeServer) return;
    try {
      setError('');
      setResyncing(true);
      await resyncServer(activeServer.id);
      await loadServers();
      await loadLibraryStats();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResyncing(false);
    }
  };

  // ─── Plex auth flow ───────────────────────────────────

  const startPlexAuth = async () => {
    try {
      setError('');
      const pin = await requestPlexPin();
      setPlexPinId(pin.pin_id);
      setPlexClientId(pin.client_id);
      setPlexAuthUrl(pin.auth_url);
      setPlexStep('qr');

      // Generate QR code
      const dataUrl = await QRCode.toDataURL(pin.auth_url, {
        width: 200,
        margin: 2,
        color: { dark: '#ffffff', light: '#00000000' },
      });
      setPlexQrDataUrl(dataUrl);

      // Start polling for PIN completion
      if (pollRef.current) clearInterval(pollRef.current);
      let pollActive = true;
      pollRef.current = setInterval(async () => {
        if (!pollActive) return;
        try {
          const result = await checkPlexPin(pin.pin_id, pin.client_id);
          if (result.authorized && result.auth_token) {
            pollActive = false;
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setPlexAuthToken(result.auth_token);

            // Fetch user's Plex servers
            const servers = await getPlexServers(result.auth_token, pin.client_id);
            setPlexServers(servers);

            // Auto-select if only one server
            if (servers.length === 1) {
              setPlexStep('connecting');
              setConnecting(true);
              try {
                const connected = await connectPlexServer({
                  name: servers[0].name,
                  url: servers[0].url,
                  auth_token: result.auth_token,
                  client_id: pin.client_id,
                });
                resetSetupForm();
                await loadServers();
                if (connected.is_active) onServerAdded?.(connected);
              } catch (err) {
                setError((err as Error).message);
                setPlexStep('servers');
              } finally {
                setConnecting(false);
              }
            } else {
              setPlexStep('servers');
            }
          }
        } catch (err) {
          console.warn('[Plex] PIN poll error:', err);
        }
      }, 3000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handlePlexServerSelect = async (plexServer: PlexServerInfo) => {
    try {
      setError('');
      setPlexStep('connecting');
      setConnecting(true);

      const server = await connectPlexServer({
        name: plexServer.name,
        url: plexServer.url,
        auth_token: plexAuthToken,
        client_id: plexClientId,
      });

      resetSetupForm();
      await loadServers();
      if (server.is_active) {
        onServerAdded?.(server);
      }
    } catch (err) {
      setError((err as Error).message);
      setPlexStep('servers');
    } finally {
      setConnecting(false);
    }
  };

  if (loading) return <div className="settings-loading">Loading...</div>;

  const needsAuth = activeServer ? !activeServer.is_authenticated : false;
  const serverTypeName = activeServer?.server_type === 'plex' ? 'Plex' : 'Jellyfin';

  return (
    <>
      <div className="settings-group-heading">MEDIA SERVER</div>

      {error && <div className="settings-error">{error}</div>}

      {/* ── Connected server ── */}
      {activeServer && !showSetup && (
        <div className="server-connected">
          <div className="server-connected-status">
            <span className={`server-connected-indicator ${needsAuth ? 'server-connected-indicator-warn' : ''}`} />
            <span className="server-connected-label">{needsAuth ? 'Authentication Required' : 'Connected'}</span>
          </div>

          <div className="server-connected-details">
            <div className="server-connected-row">
              <span className="server-connected-key">Server</span>
              <span className="server-connected-value">{activeServer.name}</span>
            </div>
            <div className="server-connected-row">
              <span className="server-connected-key">Type</span>
              <span className="server-connected-value">{serverTypeName}</span>
            </div>
            <div className="server-connected-row">
              <span className="server-connected-key">URL</span>
              <span className="server-connected-value server-connected-url">{activeServer.url}</span>
            </div>
            {activeServer.username && (
              <div className="server-connected-row">
                <span className="server-connected-key">User</span>
                <span className="server-connected-value">{activeServer.username}</span>
              </div>
            )}
            {libraryStats && (libraryStats.movies > 0 || libraryStats.episodes > 0) && (
              <>
                <div className="server-connected-row">
                  <span className="server-connected-key">Library</span>
                  <span className="server-connected-value">
                    {[
                      libraryStats.movies > 0 && `${libraryStats.movies.toLocaleString()} movie${libraryStats.movies !== 1 ? 's' : ''}`,
                      libraryStats.episodes > 0 && `${libraryStats.episodes.toLocaleString()} episode${libraryStats.episodes !== 1 ? 's' : ''}`,
                    ].filter(Boolean).join(', ')}
                  </span>
                </div>
                {libraryStats.last_sync && (
                  <div className="server-connected-row">
                    <span className="server-connected-key">Last Sync</span>
                    <span className="server-connected-value">
                      {new Date(libraryStats.last_sync).toLocaleString()}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {needsAuth && activeServer.server_type !== 'plex' && !reauthOpen && (
            <button
              className="settings-btn-primary"
              onClick={() => { setReauthOpen(true); setReauthPassword(''); }}
              style={{ marginBottom: 8 }}
            >
              RE-AUTHENTICATE
            </button>
          )}

          {reauthOpen && (
            <div className="server-reauth">
              <input
                type="password"
                value={reauthPassword}
                onChange={e => setReauthPassword(e.target.value)}
                placeholder="Enter password"
                className="server-reauth-input"
                onKeyDown={e => {
                  if (e.key === 'Enter' && reauthPassword) {
                    handleReauthenticate();
                  }
                }}
                autoFocus
              />
              <button
                className="server-action-btn server-action-accent"
                onClick={handleReauthenticate}
                disabled={!reauthPassword}
              >
                LOGIN
              </button>
              <button
                className="server-action-btn"
                onClick={() => { setReauthOpen(false); setReauthPassword(''); }}
              >
                CANCEL
              </button>
            </div>
          )}

          <div className="server-connected-actions">
            {!needsAuth && (
              <button
                className="server-action-btn server-action-accent"
                onClick={handleResync}
                disabled={resyncing}
              >
                {resyncing ? 'SYNCING...' : 'RESYNC LIBRARY'}
              </button>
            )}
            <button
              className="server-action-btn server-action-danger"
              onClick={handleDisconnect}
            >
              DISCONNECT
            </button>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {!activeServer && !showSetup && (
        <div className="server-empty-state">
          <div className="server-empty-icon"><Hexagon size={48} weight="light" /></div>
          <p>No server connected</p>
          <span>Connect your Jellyfin or Plex server to get started</span>
          <button
            className="settings-btn-primary"
            onClick={() => { setShowSetup(true); setError(''); }}
            style={{ marginTop: 16 }}
          >
            CONNECT SERVER
          </button>
        </div>
      )}

      {/* ── Setup / Change form ── */}
      {showSetup && (
        <div className="server-add-card">
          {/* Provider selection */}
          <div className="server-provider-toggle">
            <button
              className={`server-provider-btn ${providerType === 'jellyfin' ? 'server-provider-btn-active' : ''}`}
              onClick={() => { setProviderType('jellyfin'); setError(''); }}
            >
              Jellyfin
            </button>
            <button
              className={`server-provider-btn ${providerType === 'plex' ? 'server-provider-btn-active' : ''}`}
              onClick={() => { setProviderType('plex'); setError(''); startPlexAuth(); }}
            >
              Plex
            </button>
          </div>

          {/* ── Jellyfin setup ── */}
          {providerType === 'jellyfin' && (
            <>
              <div className="server-add-step">
                <span className="server-add-step-num">1</span>
                <span className="server-add-step-label">Find your server</span>
              </div>

              <div className="settings-discover">
                <div className="settings-discover-header">
                  <label>Servers on your network</label>
                  <button
                    className="settings-btn-sm"
                    onClick={runDiscovery}
                    disabled={discovering}
                  >
                    {discovering ? 'SCANNING...' : 'RESCAN'}
                  </button>
                </div>
                {discovering && discovered.length === 0 && (
                  <div className="settings-discover-scanning">Scanning network...</div>
                )}
                {!discovering && discovered.length === 0 && (
                  <div className="settings-discover-empty">No servers found automatically. Enter details manually below.</div>
                )}
                {discovered.length > 0 && (
                  <div className="settings-discover-list">
                    {discovered.map(d => (
                      <button
                        key={d.id || d.address}
                        className={`settings-discover-item ${url === d.address ? 'settings-discover-item-selected' : ''}`}
                        onClick={() => handleSelectDiscovered(d)}
                      >
                        <span className="settings-discover-name">{d.name}</span>
                        <span className="settings-discover-url">{d.address}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="server-add-divider">
                <span>or enter manually</span>
              </div>

              <div className="server-add-step">
                <span className="server-add-step-num">2</span>
                <span className="server-add-step-label">Server details</span>
              </div>

              <div className="server-add-fields">
                <div className="server-add-field-row">
                  <div className="settings-field">
                    <label>Server Name</label>
                    <input
                      type="text"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="My Jellyfin Server"
                    />
                  </div>
                  <div className="settings-field">
                    <label>Server URL</label>
                    <input
                      type="text"
                      value={url}
                      onChange={e => setUrl(e.target.value)}
                      placeholder="http://192.168.1.100:8096"
                    />
                  </div>
                </div>
                <div className="server-add-field-row">
                  <div className="settings-field">
                    <label>Username</label>
                    <input
                      type="text"
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      placeholder="Your Jellyfin username"
                    />
                  </div>
                  <div className="settings-field">
                    <label>Password</label>
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="Your Jellyfin password"
                    />
                  </div>
                </div>
              </div>

              <div className="server-form-actions">
                <button
                  className="settings-btn-primary server-add-connect-btn"
                  onClick={handleConnect}
                  disabled={!name || !url || !username || connecting}
                >
                  {connecting ? 'CONNECTING...' : 'CONNECT'}
                </button>
                <button
                  className="settings-btn-sm"
                  onClick={resetSetupForm}
                >
                  CANCEL
                </button>
              </div>
            </>
          )}

          {/* ── Plex setup ── */}
          {providerType === 'plex' && (
            <>
              {plexStep === 'qr' && (
                <div className="plex-auth-section">
                  <div className="server-add-step">
                    <span className="server-add-step-num">1</span>
                    <span className="server-add-step-label">Sign in to Plex</span>
                  </div>

                  <div className="plex-qr-container">
                    {plexQrDataUrl ? (
                      <>
                        <img src={plexQrDataUrl} alt="Scan to sign in to Plex" className="plex-qr-code" />
                        <p className="plex-qr-hint">Scan with your phone to sign in</p>
                        <a
                          href={plexAuthUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="plex-auth-link"
                        >
                          Or click here to sign in manually
                        </a>
                        <p className="plex-qr-waiting">Waiting for authentication...</p>
                      </>
                    ) : (
                      <p className="plex-qr-loading">Generating sign-in code...</p>
                    )}
                  </div>

                  <div className="server-form-actions">
                    <button className="settings-btn-sm" onClick={resetSetupForm}>
                      CANCEL
                    </button>
                  </div>
                </div>
              )}

              {plexStep === 'servers' && (
                <div className="plex-auth-section">
                  <div className="server-add-step">
                    <span className="server-add-step-num">2</span>
                    <span className="server-add-step-label">Select your Plex server</span>
                  </div>

                  {plexServers.length === 0 ? (
                    <div className="settings-discover-empty">
                      No Plex Media Servers found on your account.
                    </div>
                  ) : (
                    <div className="settings-discover-list">
                      {plexServers.map((ps, i) => (
                        <button
                          key={i}
                          className="settings-discover-item"
                          onClick={() => handlePlexServerSelect(ps)}
                          disabled={connecting}
                        >
                          <span className="settings-discover-name">
                            {ps.name}
                            {ps.is_local && <span className="plex-server-badge plex-server-local">Local</span>}
                            {ps.is_relay && <span className="plex-server-badge plex-server-relay">Relay</span>}
                            {!ps.is_local && !ps.is_relay && <span className="plex-server-badge plex-server-remote">Remote</span>}
                          </span>
                          <span className="settings-discover-url">{ps.url}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="server-form-actions">
                    <button className="settings-btn-sm" onClick={resetSetupForm}>
                      CANCEL
                    </button>
                  </div>
                </div>
              )}

              {plexStep === 'connecting' && (
                <div className="plex-auth-section">
                  <p className="plex-qr-waiting">Connecting to Plex server...</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
