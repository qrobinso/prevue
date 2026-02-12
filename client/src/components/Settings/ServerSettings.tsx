import { useState, useEffect } from 'react';
import { getServers, addServer, deleteServer, testServer, activateServer, discoverServers, reauthenticateServer, type ServerInfo, type DiscoveredServer } from '../../services/api';

export default function ServerSettings() {
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
      await addServer(name, url, username, password);
      setName('');
      setUrl('');
      setUsername('');
      setPassword('');
      setShowAdd(false);
      await loadServers();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
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

  if (loading) return <div className="settings-loading">Loading...</div>;

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h3>Jellyfin Servers</h3>
        <button className="settings-btn-primary" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? 'CANCEL' : '+ ADD SERVER'}
        </button>
      </div>

      {error && <div className="settings-error">{error}</div>}

      {showAdd && (
        <div className="settings-form">
          {/* Discovered servers section */}
          <div className="settings-discover">
            <div className="settings-discover-header">
              <label>Servers Found on Network</label>
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
              <div className="settings-discover-empty">No servers found. Enter details manually below.</div>
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
          <button 
            className="settings-btn-primary" 
            onClick={handleAdd} 
            disabled={!name || !url || !username || connecting}
          >
            {connecting ? 'CONNECTING...' : 'CONNECT'}
          </button>
        </div>
      )}

      <div className="settings-list">
        {servers.length === 0 && !showAdd && (
          <div className="settings-empty">No servers configured. Add a Jellyfin server to get started.</div>
        )}
        {servers.map(server => (
          <div key={server.id} className={`settings-list-item ${server.is_active ? 'settings-list-item-active' : ''}`}>
            <div className="settings-list-info">
              <span className="settings-list-name">
                {server.name}
                {server.is_active && <span className="settings-badge">ACTIVE</span>}
                {!server.is_authenticated && <span className="settings-badge settings-badge-warning">NEEDS AUTH</span>}
              </span>
              <span className="settings-list-detail">{server.url}</span>
              <span className="settings-list-detail">User: {server.username}</span>
            </div>
            <div className="settings-list-actions">
              <button className="settings-btn-sm" onClick={() => handleTest(server.id)}>
                {testResults[server.id] === null ? '...' : 
                  testResults[server.id]?.connected && testResults[server.id]?.authenticated ? '✓ OK' : 
                  testResults[server.id]?.connected ? '⚠ NO AUTH' : 
                  testResults[server.id] ? '✗ FAIL' : 'TEST'}
              </button>
              <button 
                className={`settings-btn-sm ${!server.is_authenticated ? 'settings-btn-warning' : ''}`} 
                onClick={() => {
                  if (reauthId === server.id) {
                    setReauthId(null);
                    setReauthPassword('');
                  } else {
                    setReauthId(server.id);
                    setReauthPassword('');
                  }
                }}
              >
                {reauthId === server.id ? 'CANCEL' : 'RE-AUTH'}
              </button>
              {!server.is_active && server.is_authenticated && (
                <button className="settings-btn-sm settings-btn-accent" onClick={() => handleActivate(server.id)}>
                  ACTIVATE
                </button>
              )}
              <button className="settings-btn-sm settings-btn-danger" onClick={() => handleDelete(server.id)}>
                DELETE
              </button>
            </div>
            {reauthId === server.id && (
              <div className="settings-reauth-form">
                <input
                  type="password"
                  value={reauthPassword}
                  onChange={e => setReauthPassword(e.target.value)}
                  placeholder="Enter your Jellyfin password"
                  className="settings-reauth-input"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && reauthPassword) {
                      handleReauthenticate(server.id);
                    }
                  }}
                />
                <button 
                  className="settings-btn-sm settings-btn-accent" 
                  onClick={() => handleReauthenticate(server.id)}
                  disabled={!reauthPassword}
                >
                  LOGIN
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
