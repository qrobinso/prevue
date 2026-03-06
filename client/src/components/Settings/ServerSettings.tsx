import { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import {
  getServers, addServer, deleteServer, testServer, resyncServer,
  discoverServers, reauthenticateServer, requestPlexPin, checkPlexPin,
  getPlexServers, connectPlexServer,
  type ServerInfo, type DiscoveredServer, type PlexServerInfo,
} from '../../services/api';

interface ServerSettingsProps {
  onServerAdded?: (server: ServerInfo) => void;
}

type ProviderType = 'jellyfin' | 'plex';
type PlexStep = 'qr' | 'servers' | 'connecting';

export default function ServerSettings({ onServerAdded }: ServerSettingsProps) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [providerType, setProviderType] = useState<ProviderType>('jellyfin');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ connected: boolean; authenticated: boolean } | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Plex auth state
  const [plexStep, setPlexStep] = useState<PlexStep>('qr');
  const [plexAuthUrl, setPlexAuthUrl] = useState('');
  const [plexPinId, setPlexPinId] = useState<number | null>(null);
  const [plexClientId, setPlexClientId] = useState('');
  const [plexAuthToken, setPlexAuthToken] = useState('');
  const [plexServers, setPlexServers] = useState<PlexServerInfo[]>([]);
  const [plexQrDataUrl, setPlexQrDataUrl] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeServer = servers.find(s => s.is_active) ?? servers[0] ?? null;

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

  useEffect(() => { loadServers(); }, []);

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
      if (activeServer) {
        await deleteServer(activeServer.id);
      }
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
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    if (!activeServer) return;
    try {
      setConfirmDisconnect(false);
      await deleteServer(activeServer.id);
      await loadServers();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleTest = async () => {
    if (!activeServer) return;
    setTestResult(null);
    try {
      const result = await testServer(activeServer.id);
      setTestResult(result);
    } catch {
      setTestResult({ connected: false, authenticated: false });
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
            setPlexStep('servers');
            const servers = await getPlexServers(result.auth_token, pin.client_id);
            setPlexServers(servers);
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

      if (activeServer) {
        await deleteServer(activeServer.id);
      }

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

  const renderTestBadge = () => {
    if (testResult === null) return null;
    if (testResult.connected && testResult.authenticated) {
      return <span className="server-test-ok">Connected</span>;
    }
    if (testResult.connected) {
      return <span className="server-test-warn">No Auth</span>;
    }
    return <span className="server-test-fail">Failed</span>;
  };

  if (loading) return <div className="settings-loading">Loading...</div>;

  const needsAuth = activeServer ? !activeServer.is_authenticated : false;
  const serverTypeName = activeServer?.server_type === 'plex' ? 'Plex' : 'Jellyfin';

  return (
    <div className="settings-section">
      <h3>Media Server</h3>

      {error && <div className="settings-error">{error}</div>}

      {/* ── Connected server ── */}
      {activeServer && !showSetup && (
        <div className={`server-card ${needsAuth ? 'server-card-warning' : 'server-card-active'}`}>
          <div className="server-card-header">
            <div className="server-card-info">
              <div className="server-card-name">
                <span className="server-type-badge">{serverTypeName}</span>
                {activeServer.name}
                {!needsAuth && <span className="server-status-dot server-status-active" title="Connected" />}
                {needsAuth && <span className="server-status-dot server-status-warning" title="Needs authentication" />}
              </div>
              <div className="server-card-details">
                <span className="server-card-url">{activeServer.url}</span>
                {activeServer.username && <span className="server-card-user">{activeServer.username}</span>}
              </div>
            </div>
            {renderTestBadge()}
          </div>

          <div className="server-card-actions">
            <button className="server-action-btn" onClick={handleTest}>
              TEST
            </button>

            {needsAuth && activeServer.server_type !== 'plex' && (
              <button
                className="server-action-btn server-action-warning"
                onClick={() => { setReauthOpen(!reauthOpen); setReauthPassword(''); }}
              >
                {reauthOpen ? 'CANCEL' : 'RE-AUTH'}
              </button>
            )}

            {!needsAuth && (
              <button
                className="server-action-btn server-action-accent"
                onClick={handleResync}
                disabled={resyncing}
              >
                {resyncing ? 'SYNCING...' : 'RESYNC'}
              </button>
            )}

            <button
              className="server-action-btn"
              onClick={() => { setShowSetup(true); setError(''); }}
            >
              CHANGE
            </button>

            <button
              className={`server-action-btn server-action-danger ${confirmDisconnect ? 'server-action-danger-confirm' : ''}`}
              onClick={handleDisconnect}
              onBlur={() => setConfirmDisconnect(false)}
            >
              {confirmDisconnect ? 'CONFIRM' : 'DISCONNECT'}
            </button>
          </div>

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
            </div>
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {!activeServer && !showSetup && (
        <div className="server-empty-state">
          <div className="server-empty-icon">⬡</div>
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
          {activeServer && (
            <p className="settings-field-hint" style={{ marginBottom: 12 }}>
              This will replace your current server connection.
            </p>
          )}

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

              <div style={{ display: 'flex', gap: 8 }}>
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

                  <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
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

                  <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
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
    </div>
  );
}
