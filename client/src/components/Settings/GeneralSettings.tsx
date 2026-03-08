import { useState, useEffect, useCallback } from 'react';
import ServerSettings from './ServerSettings';
import { factoryReset, restartServer, getSettings, updateSettings, getServers, getAIConfig, updateAIConfig } from '../../services/api';
import type { ServerInfo, AIConfig } from '../../services/api';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { CheckCircle, CaretDown } from '@phosphor-icons/react';
import './Settings.css';

const APP_VERSION = '1.0.0';
const GITHUB_URL = 'https://github.com/qrobinso/prevue';

const ICONIC_SCENES_KEY = 'prevue_iconic_scenes_enabled';
const PROGRAM_FACTS_KEY = 'prevue_program_facts_enabled';

export function getProgramFactsEnabled(): boolean {
  try {
    const stored = localStorage.getItem(PROGRAM_FACTS_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return false; // default: off (opt-in AI feature)
}

export function setProgramFactsEnabled(enabled: boolean): void {
  localStorage.setItem(PROGRAM_FACTS_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('programfactschange', { detail: { enabled } }));
}

export function getIconicScenesEnabled(): boolean {
  try {
    const stored = localStorage.getItem(ICONIC_SCENES_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return false; // default: off (opt-in AI feature)
}

export function setIconicScenesEnabled(enabled: boolean): void {
  localStorage.setItem(ICONIC_SCENES_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('iconicsceneschange', { detail: { enabled } }));
}

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

  // AI configuration state
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiModelInput, setAiModelInput] = useState('');
  const [aiConfigSaving, setAiConfigSaving] = useState(false);
  const [aiConfigExpanded, setAiConfigExpanded] = useState(false);
  const [aiError, setAiError] = useState('');
  const [iconicScenesEnabled, setIconicScenesEnabledState] = useState(getIconicScenesEnabled);
  const [programFactsEnabled, setProgramFactsEnabledState] = useState(getProgramFactsEnabled);
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
    getAIConfig()
      .then((config) => {
        setAiConfig(config);
        setAiModelInput(config.model);
        if (!config.hasKey) setAiConfigExpanded(true);
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

  const handleSaveAIConfig = async () => {
    setAiConfigSaving(true);
    setAiError('');
    try {
      const update: { apiKey?: string; model?: string } = {};
      if (aiKeyInput) update.apiKey = aiKeyInput;
      if (aiModelInput !== aiConfig?.model) update.model = aiModelInput;
      const result = await updateAIConfig(update);
      setAiConfig(result);
      setAiKeyInput('');
      if (result.hasUserKey) setAiConfigExpanded(false);
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiConfigSaving(false);
    }
  };

  const handleClearAIKey = async () => {
    setAiConfigSaving(true);
    setAiError('');
    try {
      const result = await updateAIConfig({ apiKey: '' });
      setAiConfig(result);
      setAiConfigExpanded(true);
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiConfigSaving(false);
    }
  };

  const handleIconicScenesToggle = () => {
    const newValue = !iconicScenesEnabled;
    setIconicScenesEnabledState(newValue);
    setIconicScenesEnabled(newValue);
  };

  const handleProgramFactsToggle = () => {
    const newValue = !programFactsEnabled;
    setProgramFactsEnabledState(newValue);
    setProgramFactsEnabled(newValue);
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

      {/* ── AI ───────────────────────────────────────────── */}
      <div className="settings-group-heading">AI <span className="settings-badge settings-badge-beta">BETA</span></div>

      <div className="settings-subsection">
        <div className="settings-ai-config">
          <button
            className="settings-ai-config-header"
            onClick={() => setAiConfigExpanded(!aiConfigExpanded)}
          >
            <span className="settings-ai-config-title">Openrouter</span>
            <div className="settings-ai-config-status">
              {aiConfig?.hasKey ? (
                <span className="settings-badge settings-badge-ai-active">CONNECTED</span>
              ) : (
                <span className="settings-badge settings-badge-ai-inactive">NOT CONFIGURED</span>
              )}
              <span className={`settings-preset-category-arrow ${aiConfigExpanded ? 'expanded' : ''}`}>
                <CaretDown size={14} weight="bold" />
              </span>
            </div>
          </button>

          {aiConfigExpanded && (
            <div className="settings-ai-config-body">
              {aiConfig?.hasEnvKey && !aiConfig?.hasUserKey && (
                <p className="settings-field-hint">
                  Using API key from server environment. You can override it below.
                </p>
              )}

              <div className="settings-field">
                <label>API Key</label>
                {aiConfig?.hasUserKey ? (
                  <div className="settings-ai-key-configured">
                    <span className="settings-ai-key-mask">sk-or-...configured</span>
                    <button
                      className="settings-btn-sm settings-btn-danger"
                      onClick={handleClearAIKey}
                      disabled={aiConfigSaving}
                    >
                      CLEAR
                    </button>
                  </div>
                ) : (
                  <input
                    type="password"
                    value={aiKeyInput}
                    onChange={e => setAiKeyInput(e.target.value)}
                    placeholder="sk-or-..."
                    autoComplete="off"
                  />
                )}
                <span className="settings-field-hint">
                  Get your API key from openrouter.ai
                </span>
              </div>

              <div className="settings-field">
                <label>Model</label>
                <input
                  type="text"
                  value={aiModelInput}
                  onChange={e => setAiModelInput(e.target.value)}
                  placeholder={aiConfig?.defaultModel || 'google/gemini-3-flash-preview'}
                />
                <span className="settings-field-hint">
                  OpenRouter model ID (e.g. google/gemini-3-flash-preview, anthropic/claude-sonnet-4)
                </span>
              </div>

              {aiError && <div className="settings-error">{aiError}</div>}

              <button
                className="settings-btn-primary"
                onClick={handleSaveAIConfig}
                disabled={aiConfigSaving || (!aiKeyInput && aiModelInput === aiConfig?.model)}
              >
                {aiConfigSaving ? 'SAVING...' : 'SAVE CONFIGURATION'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={`settings-subsection ${!aiConfig?.hasKey ? 'settings-disabled' : ''}`}>
        <h4>ICONIC SCENES</h4>
        <p className="settings-field-hint">
          AI-powered detection of famous movie moments. Shows a badge and filter
          when an iconic scene is playing on any channel.
          {!aiConfig?.hasKey && ' Configure an API key above to enable.'}
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={iconicScenesEnabled}
              onChange={handleIconicScenesToggle}
              disabled={!aiConfig?.hasKey}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {iconicScenesEnabled ? 'ON' : 'OFF'}
          </span>
        </div>
      </div>

      <div className={`settings-subsection ${!aiConfig?.hasKey ? 'settings-disabled' : ''}`}>
        <h4>PROGRAM FACTS</h4>
        <p className="settings-field-hint">
          AI-generated trivia and behind-the-scenes facts about what you're watching,
          shown in the channel ticker marquee.
          {!aiConfig?.hasKey && ' Configure an API key above to enable.'}
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={programFactsEnabled}
              onChange={handleProgramFactsToggle}
              disabled={!aiConfig?.hasKey}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {programFactsEnabled ? 'ON' : 'OFF'}
          </span>
        </div>
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
            <span className="settings-pwa-check"><CheckCircle size={16} weight="fill" /></span> Prevue is installed
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
