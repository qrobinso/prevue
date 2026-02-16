import { useState, useEffect } from 'react';
import { getServers, addServer, deleteServer, testServer, activateServer, resyncServer, discoverServers, reauthenticateServer, type ServerInfo, type DiscoveredServer } from '../../services/api';

interface ServerSettingsProps {
  onServerAdded?: (server: ServerInfo) => void;
}

export default function ServerSettings({ onServerAdded }: ServerSettingsProps) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [testResults, setTestResults] = useState<Record<number, { connected: boolean; authenticated: boolean } | null>>({});
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [reauthId, setReauthId] = useState<number | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [resyncingId, setResyncingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

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
      // Discovery failed silently - not critical
    } finally {
      setDiscovering(false);
    }
  };

  useEffect(() => { loadServers(); }, []);

  // Auto-discover when add form is opened
  useEffect(() => {
    if (showAdd) {
      runDiscovery();
    } else {
      setDiscovered([]);
    }
  }, [showAdd]);

  const handleSelectDiscovered = (server: DiscoveredServer) => {
    setName(server.name);
    setUrl(server.address);
  };

  const handleAdd = async () => {
    try {
      setError('');
      setConnecting(true);
      const server = await addServer(name, url, username, password);
      setName('');
      setUrl('');
      setUsername('');
      setPassword('');
      setShowAdd(false);
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

  const handleDelete = async (id: number) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    try {
      setConfirmDeleteId(null);
      await deleteServer(id);
      await loadServers();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleTest = async (id: number) => {
    setTestResults(prev => ({ ...prev, [id]: null }));
    try {
      const result = await testServer(id);
      setTestResults(prev => ({ ...prev, [id]: result }));
    } catch {
      setTestResults(prev => ({ ...prev, [id]: { connected: false, authenticated: false } }));
    }
  };

  const handleReauthenticate = async (id: number) => {
    try {
      setError('');
      await reauthenticateServer(id, reauthPassword);
      setReauthId(null);
      setReauthPassword('');
      await loadServers();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleActivate = async (id: number) => {
    try {
      await activateServer(id);
      await loadServers();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleResync = async (id: number) => {
    try {
      setError('');
      setResyncingId(id);
      await resyncServer(id);
      await loadServers();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResyncingId(null);
    }
  };

  const renderTestResult = (id: number) => {
    const result = testResults[id];
    if (result === null) return <span className="server-test-pending" />;
    if (!result) return null;
    if (result.connected && result.authenticated) {
      return <span className="server-test-ok">Connected</span>;
    }
    if (result.connected) {
      return <span className="server-test-warn">No Auth</span>;
    }
    return <span className="server-test-fail">Failed</span>;
  };

  if (loading) return <div className="settings-loading">Loading...</div>;

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h3>Jellyfin Servers</h3>
        <button className="settings-btn-primary" onClick={() => { setShowAdd(!showAdd); setError(''); }}>
          {showAdd ? 'CANCEL' : '+ ADD SERVER'}
        </button>
      </div>

      {error && <div className="settings-error">{error}</div>}

      {showAdd && (
        <div className="server-add-card">
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

          <button
            className="settings-btn-primary server-add-connect-btn"
            onClick={handleAdd}
            disabled={!name || !url || !username || connecting}
          >
            {connecting ? 'CONNECTING...' : 'CONNECT'}
          </button>
        </div>
      )}

      {servers.length === 0 && !showAdd && (
        <div className="server-empty-state">
          <div className="server-empty-icon">⬡</div>
          <p>No servers configured</p>
          <span>Add a Jellyfin server to get started</span>
        </div>
      )}

      <div className="settings-list">
        {servers.map(server => {
          const isActive = server.is_active;
          const needsAuth = !server.is_authenticated;
          const isReauthing = reauthId === server.id;
          const isResyncing = resyncingId === server.id;
          const isConfirmingDelete = confirmDeleteId === server.id;

          return (
            <div key={server.id} className={`server-card ${isActive ? 'server-card-active' : ''} ${needsAuth ? 'server-card-warning' : ''}`}>
              <div className="server-card-header">
                <div className="server-card-info">
                  <div className="server-card-name">
                    {server.name}
                    {isActive && <span className="server-status-dot server-status-active" title="Active" />}
                    {needsAuth && <span className="server-status-dot server-status-warning" title="Needs authentication" />}
                  </div>
                  <div className="server-card-details">
                    <span className="server-card-url">{server.url}</span>
                    <span className="server-card-user">{server.username}</span>
                  </div>
                </div>
                {renderTestResult(server.id)}
              </div>

              <div className="server-card-actions">
                <button className="server-action-btn" onClick={() => handleTest(server.id)}>
                  TEST
                </button>

                {needsAuth && (
                  <button
                    className="server-action-btn server-action-warning"
                    onClick={() => {
                      if (isReauthing) { setReauthId(null); setReauthPassword(''); }
                      else { setReauthId(server.id); setReauthPassword(''); }
                    }}
                  >
                    {isReauthing ? 'CANCEL' : 'RE-AUTH'}
                  </button>
                )}

                {!needsAuth && !isActive && (
                  <button
                    className="server-action-btn server-action-accent"
                    onClick={() => handleActivate(server.id)}
                  >
                    ACTIVATE
                  </button>
                )}

                {isActive && !needsAuth && (
                  <button
                    className="server-action-btn server-action-accent"
                    onClick={() => handleResync(server.id)}
                    disabled={isResyncing}
                  >
                    {isResyncing ? 'SYNCING...' : 'RESYNC'}
                  </button>
                )}

                <button
                  className={`server-action-btn server-action-danger ${isConfirmingDelete ? 'server-action-danger-confirm' : ''}`}
                  onClick={() => handleDelete(server.id)}
                  onBlur={() => setConfirmDeleteId(null)}
                >
                  {isConfirmingDelete ? 'CONFIRM' : 'DELETE'}
                </button>
              </div>

              {isReauthing && (
                <div className="server-reauth">
                  <input
                    type="password"
                    value={reauthPassword}
                    onChange={e => setReauthPassword(e.target.value)}
                    placeholder="Enter password"
                    className="server-reauth-input"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && reauthPassword) {
                        handleReauthenticate(server.id);
                      }
                    }}
                    autoFocus
                  />
                  <button
                    className="server-action-btn server-action-accent"
                    onClick={() => handleReauthenticate(server.id)}
                    disabled={!reauthPassword}
                  >
                    LOGIN
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
