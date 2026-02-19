import { useState, useEffect, useCallback, useMemo } from 'react';
import { getSettings, updateSettings, getIPTVStatus } from '../../services/api';
import type { IPTVStatus } from '../../services/api';
import './Settings.css';

export default function IPTVSettings() {
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [status, setStatus] = useState<IPTVStatus | null>(null);
  const [copied, setCopied] = useState<'playlist' | 'epg' | null>(null);
  const [timezone, setTimezone] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [
        'UTC',
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris',
        'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney',
      ];
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await getIPTVStatus();
      setStatus(s);
    } catch {
      // Status endpoint may fail if IPTV is disabled
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getSettings().then((s) => {
        setEnabled(s['iptv_enabled'] === true || s['iptv_enabled'] === 'true');
        if (s['iptv_base_url'] && typeof s['iptv_base_url'] === 'string') {
          setBaseUrl(s['iptv_base_url'] as string);
        }
        if (s['iptv_timezone'] && typeof s['iptv_timezone'] === 'string') {
          setTimezone(s['iptv_timezone'] as string);
        }
      }),
      fetchStatus(),
    ]).finally(() => setLoading(false));
  }, [fetchStatus]);

  const handleToggle = async () => {
    const newValue = !enabled;
    setEnabled(newValue);
    setSaving(true);
    try {
      await updateSettings({ iptv_enabled: newValue });
      await fetchStatus();
    } catch {
      setEnabled(!newValue); // revert on failure
    } finally {
      setSaving(false);
    }
  };

  const handleBaseUrlSave = async () => {
    setSaving(true);
    try {
      await updateSettings({ iptv_base_url: baseUrl || '' });
      await fetchStatus();
    } catch {
      // Keep local value
    } finally {
      setSaving(false);
    }
  };

  const handleTimezoneSave = async (value: string) => {
    setTimezone(value);
    setSaving(true);
    try {
      await updateSettings({ iptv_timezone: value });
    } catch {
      // Keep local value
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (type: 'playlist' | 'epg') => {
    if (!status) return;
    const url = type === 'playlist' ? status.playlistUrl : status.epgUrl;
    let success = false;
    // Try modern clipboard API first
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        success = true;
      } catch {
        // Falls through to fallback
      }
    }
    // Fallback for iOS Safari and non-HTTPS contexts
    if (!success) {
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.setSelectionRange(0, url.length);
      success = document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    if (success) {
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  if (loading) {
    return (
      <div className="settings-section">
        <h3>IPTV</h3>
        <p className="settings-field-hint">Loading...</p>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h3>IPTV</h3>

      <div className="settings-subsection">
        <h4>IPTV SERVER</h4>
        <p className="settings-field-hint">
          Enable the IPTV server to let external apps like TiviMate, Kodi, or VLC
          connect to Prevue and watch your channels.
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={handleToggle}
              disabled={saving}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            Enable IPTV Server
          </span>
        </div>
      </div>

      {enabled && (
        <>
          <div className="settings-subsection">
            <h4>BASE URL</h4>
            <p className="settings-field-hint">
              Override if Prevue is behind a reverse proxy or accessed from a different network.
              Leave empty to auto-detect.
            </p>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text"
                className="settings-input"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="Auto-detected from request"
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  background: 'var(--bg-cell)',
                  border: '1px solid var(--border-grid)',
                  borderRadius: '4px',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-system)',
                  fontSize: '13px',
                }}
                onBlur={handleBaseUrlSave}
                onKeyDown={(e) => { if (e.key === 'Enter') handleBaseUrlSave(); }}
              />
            </div>
          </div>

          <div className="settings-subsection">
            <h4>EPG TIMEZONE</h4>
            <p className="settings-field-hint">
              Timezone for program times in the XMLTV guide. Your IPTV player will
              display schedule times in this timezone.
            </p>
            <div className="settings-field">
              <select
                value={timezone}
                onChange={(e) => handleTimezoneSave(e.target.value)}
                disabled={saving}
                style={{
                  padding: '8px 12px',
                  background: 'var(--bg-cell)',
                  border: '1px solid var(--border-grid)',
                  borderRadius: '4px',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-system)',
                  fontSize: '13px',
                  width: '100%',
                }}
              >
                <option value="">UTC (default)</option>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {status && (
            <>
              <div className="settings-subsection">
                <h4>M3U PLAYLIST URL</h4>
                <p className="settings-field-hint">
                  Add this URL as an M3U playlist source in your IPTV player.
                </p>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    readOnly
                    value={status.playlistUrl}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-grid)',
                      borderRadius: '4px',
                      color: 'var(--text-secondary)',
                      fontFamily: 'var(--font-system)',
                      fontSize: '12px',
                      cursor: 'text',
                    }}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    className="settings-btn-sm"
                    onClick={() => handleCopy('playlist')}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {copied === 'playlist' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="settings-subsection">
                <h4>XMLTV GUIDE (EPG)</h4>
                <p className="settings-field-hint">
                  Add this URL as an EPG / XMLTV source for program guide data.
                </p>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    readOnly
                    value={status.epgUrl}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-grid)',
                      borderRadius: '4px',
                      color: 'var(--text-secondary)',
                      fontFamily: 'var(--font-system)',
                      fontSize: '12px',
                      cursor: 'text',
                    }}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    className="settings-btn-sm"
                    onClick={() => handleCopy('epg')}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {copied === 'epg' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="settings-subsection">
                <p className="settings-field-hint" style={{ color: 'var(--accent-cyan)' }}>
                  {status.channelCount} channel{status.channelCount !== 1 ? 's' : ''} available
                </p>
              </div>
            </>
          )}

          <div className="settings-subsection">
            <h4
              onClick={() => setShowInstructions(!showInstructions)}
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              {showInstructions ? '▾' : '▸'} SETUP INSTRUCTIONS
            </h4>
            {showInstructions && (
              <div className="settings-field-hint" style={{ lineHeight: '1.6' }}>
                <p><strong>TiviMate / IPTV Smarters:</strong></p>
                <p>Add Playlist &rarr; M3U URL &rarr; paste the M3U Playlist URL above.
                   Add EPG &rarr; XMLTV URL &rarr; paste the XMLTV Guide URL above.</p>
                <br />
                <p><strong>Kodi (PVR IPTV Simple Client):</strong></p>
                <p>Add-ons &rarr; PVR IPTV Simple Client &rarr; Configure &rarr;
                   General: M3U Playlist URL. EPG: XMLTV URL.</p>
                <br />
                <p><strong>VLC:</strong></p>
                <p>Media &rarr; Open Network Stream &rarr; paste a channel URL from the M3U playlist.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
