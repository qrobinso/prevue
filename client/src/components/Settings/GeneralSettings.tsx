import { useState, useEffect, useCallback } from 'react';
import ServerSettings from './ServerSettings';
import { factoryReset, restartServer, getSettings, updateSettings, getServers } from '../../services/api';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import type { ServerInfo } from '../../services/api';
import './Settings.css';

const APP_VERSION = '1.0.0';
const GITHUB_URL = 'https://github.com/qrobinso/prevue';

interface GeneralSettingsProps {
  onServerAdded?: (server: ServerInfo) => void;
}

export default function GeneralSettings({ onServerAdded }: GeneralSettingsProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showPWAInstructions, setShowPWAInstructions] = useState(false);
  const [sharePlaybackProgress, setSharePlaybackProgress] = useState(false);
  const [mediaServiceName, setMediaServiceName] = useState<string>('your media server');
  const closeAbout = useCallback(() => setShowAbout(false), []);
  const { canInstall, isInstalled, isIOS, prompt } = usePWAInstall();

  // Close about modal on Escape
  useEffect(() => {
    if (!showAbout) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAbout();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [showAbout, closeAbout]);

  const handleRestart = async () => {
    if (!confirmRestart) {
      setConfirmRestart(true);
      return;
    }

    setRestarting(true);
    setError(null);
    try {
      await restartServer();
    } catch {
      // Expected — server may drop the connection as it shuts down
    }
    // Poll until the server is back up, then reload
    const pollUntilReady = () => {
      const check = async () => {
        try {
          const res = await fetch('/api/health');
          if (res.ok) {
            window.location.reload();
            return;
          }
        } catch { /* server still down */ }
        setTimeout(check, 1000);
      };
      setTimeout(check, 2000);
    };
    pollUntilReady();
  };

  useEffect(() => {
    getSettings()
      .then((s) => {
        if (typeof s['share_playback_progress'] === 'boolean') {
          setSharePlaybackProgress(s['share_playback_progress'] as boolean);
        }
      })
      .catch(() => {});
    getServers()
      .then((servers) => {
        const active = servers.find(s => s.is_active);
        if (active) {
          setMediaServiceName(active.server_type === 'plex' ? 'Plex' : 'Jellyfin');
        }
      })
      .catch(() => {});
  }, []);

  const handleSharePlaybackToggle = async () => {
    const newValue = !sharePlaybackProgress;
    setSharePlaybackProgress(newValue);
    try {
      await updateSettings({ share_playback_progress: newValue });
    } catch {
      // Keep applied locally even if save fails
    }
  };

  const handleFactoryReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }

    setResetting(true);
    setError(null);
    try {
      await factoryReset();
      // Clear all local storage (preferences, cached state, etc.)
      localStorage.clear();
      // Reload the page to start fresh
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setResetting(false);
      setConfirmReset(false);
    }
  };

  return (
    <div className="settings-section">
      <ServerSettings onServerAdded={onServerAdded} />

      {/* ── Progress Tracking ────────────────────────────── */}
      <div className="settings-group-heading">PLAYBACK</div>

      <div className="settings-subsection">
        <h4>PROGRESS TRACKING</h4>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={sharePlaybackProgress}
              onChange={handleSharePlaybackToggle}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            Share playback progress with {mediaServiceName}
          </span>
        </div>
        <p className="settings-field-hint">
          Syncs your watch progress to {mediaServiceName} so &quot;Continue Watching&quot; and watched status stay up to date.
        </p>
      </div>

      {/* ── App ──────────────────────────────────────────── */}
      <div className="settings-group-heading">APP</div>

      <div className="settings-subsection">
        <h4>INSTALL APP</h4>
        <p className="settings-field-hint">
          Install Prevue as a progressive web app for quick access from your home screen.
        </p>
        {isInstalled ? (
          <div className="settings-pwa-installed">
            <span className="settings-pwa-check">✓</span> Prevue is installed
          </div>
        ) : canInstall && prompt ? (
          <button
            className="settings-btn-sm settings-btn-pwa"
            onClick={prompt}
          >
            Install Prevue
          </button>
        ) : isIOS ? (
          <>
            <button
              className="settings-btn-sm settings-btn-pwa"
              onClick={() => setShowPWAInstructions(true)}
            >
              Add to Home Screen
            </button>
            {showPWAInstructions && (
              <div className="settings-pwa-instructions">
                <p>On iOS:</p>
                <ol>
                  <li>Tap the Share button (square with arrow up) in Safari</li>
                  <li>Scroll down and tap &quot;Add to Home Screen&quot;</li>
                  <li>Tap &quot;Add&quot; to confirm</li>
                </ol>
                <button
                  className="settings-btn-sm"
                  onClick={() => setShowPWAInstructions(false)}
                >
                  Got it
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="settings-field-hint settings-pwa-hint">
            Use your browser&apos;s menu to install (e.g. Chrome: &#x22EE; &rarr; Install app).
          </p>
        )}
      </div>

      <div className="settings-subsection">
        <h4>ABOUT</h4>
        <p className="settings-field-hint">
          Learn more about Prevue, its creator, and open-source credits.
        </p>
        <button
          className="settings-btn-sm"
          onClick={() => setShowAbout(true)}
        >
          ABOUT PREVUE
        </button>
      </div>

      {/* ── System ───────────────────────────────────────── */}
      <div className="settings-group-heading">SYSTEM</div>

      <div className="settings-subsection settings-danger-zone">
        <h4>RESTART SERVER</h4>
        <p className="settings-field-hint">
          Restart the Prevue server process. Requires a process manager (Docker, systemd) to bring it back up.
        </p>
        {error && !confirmReset && <div className="settings-error">{error}</div>}
        <button
          className={`settings-btn-sm settings-btn-danger ${confirmRestart ? 'settings-btn-danger-confirm' : ''}`}
          onClick={handleRestart}
          disabled={restarting}
        >
          {restarting ? 'RESTARTING...' : confirmRestart ? 'CLICK AGAIN TO CONFIRM' : 'RESTART SERVER'}
        </button>
        {confirmRestart && !restarting && (
          <button
            className="settings-btn-sm"
            onClick={() => setConfirmRestart(false)}
            style={{ marginLeft: 8 }}
          >
            CANCEL
          </button>
        )}
      </div>

      <div className="settings-subsection settings-danger-zone">
        <h4>FACTORY RESET</h4>
        <p className="settings-field-hint">
          Delete all servers, channels, schedules, and settings. This cannot be undone.
        </p>
        {error && confirmReset && <div className="settings-error">{error}</div>}
        <button
          className={`settings-btn-sm settings-btn-danger ${confirmReset ? 'settings-btn-danger-confirm' : ''}`}
          onClick={handleFactoryReset}
          disabled={resetting}
        >
          {resetting ? 'RESETTING...' : confirmReset ? 'CLICK AGAIN TO CONFIRM' : 'FACTORY RESET'}
        </button>
        {confirmReset && !resetting && (
          <button
            className="settings-btn-sm"
            onClick={() => setConfirmReset(false)}
            style={{ marginLeft: 8 }}
          >
            CANCEL
          </button>
        )}
      </div>

      {showAbout && (
        <div
          className="about-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) closeAbout(); }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="about-title"
        >
          <div className="about-modal" onClick={(e) => e.stopPropagation()}>
            <div className="about-header">
              <h2 id="about-title" className="about-title">PREVUE</h2>
              <button
                type="button"
                className="about-close"
                onClick={closeAbout}
                title="Close"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            <div className="about-body">
              <div className="about-app-section">
                <p className="about-tagline">
                  A retro cable TV guide experience for your media library.
                </p>
                <p className="about-description">
                  Prevue turns your media collection into a classic channel-surfing experience
                  with auto-generated channels, a live program guide, and that unmistakable
                  scrolling TV Guide aesthetic. Just like flipping through channels in the 90s
                  &mdash; but with your own content.
                </p>
                <span className="about-version">v{APP_VERSION}</span>
              </div>

              <div className="about-divider" />

              <div className="about-section">
                <h3 className="about-section-title">CREATED BY</h3>
                <p className="about-text">
                  Designed and built by <strong>Quentin Robinson</strong>.
                </p>
              </div>

              <div className="about-divider" />

              <div className="about-section">
                <h3 className="about-section-title">OPEN SOURCE</h3>
                <a
                  className="about-link"
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  github.com/qrobinso/prevue
                </a>
              </div>

              <div className="about-divider" />

              <div className="about-section">
                <h3 className="about-section-title">ACKNOWLEDGEMENTS</h3>
                <ul className="about-credits">
                  <li><strong>Jellyfin</strong> &mdash; The free software media system</li>
                  <li><strong>Plex</strong> &mdash; Media server platform</li>
                  <li><strong>React</strong> &mdash; UI framework</li>
                  <li><strong>Vite</strong> &mdash; Build tooling</li>
                  <li><strong>HLS.js</strong> &mdash; HTTP Live Streaming for the browser</li>
                  <li><strong>Express</strong> &mdash; Server framework</li>
                  <li><strong>better-sqlite3</strong> &mdash; Local database engine</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
