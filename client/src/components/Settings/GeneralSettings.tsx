import { useState, useEffect, useCallback, useRef } from 'react';
import ServerSettings from './ServerSettings';
import { factoryReset, restartServer, getSettings, updateSettings, getServers, getAIConfig, updateAIConfig, getIconicScenesStatus, refreshIconicScenes, getHiddenGemsStatus, refreshHiddenGems } from '../../services/api';
import type { ServerInfo, AIConfig } from '../../services/api';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { CheckCircle, CaretDown, ArrowClockwise, Television } from '@phosphor-icons/react';
import { isAutoTuneEnabled, setAutoTuneEnabled } from '../../services/autoTune';
import { useNavLayer } from '../../navigation';
import { useNotifications } from '../../notifications';
import './Settings.css';

/** Thin wrapper that pushes a nav layer for a sub-modal inside Settings */
function SubModal({ id, onClose, children }: { id: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useNavLayer(id, ref, onClose);
  return <div ref={ref} style={{ display: 'contents' }}>{children}</div>;
}

const APP_VERSION = '1.0.0';
const GITHUB_URL = 'https://github.com/qrobinso/prevue';

const ICONIC_SCENES_KEY = 'prevue_iconic_scenes_enabled';
const PROGRAM_FACTS_KEY = 'prevue_program_facts_enabled';
const CATCH_UP_KEY = 'prevue_catch_up_enabled';

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

const HIDDEN_GEMS_KEY = 'prevue_hidden_gems_enabled';

export function getHiddenGemsEnabled(): boolean {
  try {
    const stored = localStorage.getItem(HIDDEN_GEMS_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return false; // default: off (opt-in AI feature)
}

export function setHiddenGemsEnabled(enabled: boolean): void {
  localStorage.setItem(HIDDEN_GEMS_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('hiddengemschange', { detail: { enabled } }));
}

export function getCatchUpEnabled(): boolean {
  try {
    const stored = localStorage.getItem(CATCH_UP_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return false; // default: off (opt-in AI feature)
}

export function setCatchUpEnabled(enabled: boolean): void {
  localStorage.setItem(CATCH_UP_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('catchupchange', { detail: { enabled } }));
}

export type GeneralPanel = 'sources' | 'playback' | 'ai' | 'about' | 'system';

interface GeneralSettingsProps {
  onServerAdded?: (server: ServerInfo) => void;
  panel?: GeneralPanel;
}

export default function GeneralSettings({ onServerAdded, panel }: GeneralSettingsProps) {
  const show = (p: GeneralPanel) => !panel || panel === p;
  const { confirm, toast } = useNotifications();
  const [resetting, setResetting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
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
  const [iconicLastRefreshed, setIconicLastRefreshed] = useState<string | null>(null);
  const [iconicRefreshing, setIconicRefreshing] = useState(false);
  const [programFactsEnabled, setProgramFactsEnabledState] = useState(getProgramFactsEnabled);
  const [catchUpEnabled, setCatchUpEnabledState] = useState(getCatchUpEnabled);
  const [hiddenGemsEnabled, setHiddenGemsEnabledState] = useState(getHiddenGemsEnabled);
  const [gemsLastRefreshed, setGemsLastRefreshed] = useState<string | null>(null);
  const [gemsRefreshing, setGemsRefreshing] = useState(false);
  const [gemsCount, setGemsCount] = useState(0);
  const [autoTuneOn, setAutoTuneOn] = useState(isAutoTuneEnabled);
  const { canInstall, isInstalled, isIOS, prompt } = usePWAInstall();

  // Sub-modal Escape handling is now provided by useNavLayer via the SubModal wrapper

  const handleRestart = async () => {
    const ok = await confirm({
      title: 'Restart Server',
      message: 'Restart the Prevue server process? Requires a process manager (Docker, systemd) to bring it back up.',
      confirmLabel: 'Restart',
      destructive: true,
    });
    if (!ok) return;

    setRestarting(true);
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
    getIconicScenesStatus()
      .then(({ lastRefreshed }) => setIconicLastRefreshed(lastRefreshed))
      .catch(() => {});
    getHiddenGemsStatus()
      .then(({ lastRefreshed, count }) => { setGemsLastRefreshed(lastRefreshed); setGemsCount(count); })
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

  const handleIconicRefresh = async () => {
    setIconicRefreshing(true);
    try {
      const result = await refreshIconicScenes();
      setIconicLastRefreshed(result.lastRefreshed);
    } catch {
      // silently fail
    } finally {
      setIconicRefreshing(false);
    }
  };

  const handleProgramFactsToggle = () => {
    const newValue = !programFactsEnabled;
    setProgramFactsEnabledState(newValue);
    setProgramFactsEnabled(newValue);
  };

  const handleCatchUpToggle = () => {
    const newValue = !catchUpEnabled;
    setCatchUpEnabledState(newValue);
    setCatchUpEnabled(newValue);
  };

  const handleHiddenGemsToggle = () => {
    const newValue = !hiddenGemsEnabled;
    setHiddenGemsEnabledState(newValue);
    setHiddenGemsEnabled(newValue);
  };

  const handleGemsRefresh = async () => {
    setGemsRefreshing(true);
    try {
      const result = await refreshHiddenGems();
      setGemsLastRefreshed(result.lastRefreshed);
      setGemsCount(result.count);
    } catch {
      // silently fail
    } finally {
      setGemsRefreshing(false);
    }
  };

  const handleFactoryReset = async () => {
    const ok = await confirm({
      title: 'Factory Reset',
      message: 'Delete all servers, channels, schedules, and settings? This cannot be undone.',
      confirmLabel: 'Reset Everything',
      destructive: true,
    });
    if (!ok) return;

    setResetting(true);
    try {
      await factoryReset();
      // Clear all local storage (preferences, cached state, etc.)
      localStorage.clear();
      // Reload the page to start fresh
      window.location.reload();
    } catch (err) {
      toast({ variant: 'error', message: (err as Error).message });
      setResetting(false);
    }
  };

  return (
    <div className="settings-section">
      {show('sources') && <ServerSettings onServerAdded={onServerAdded} />}

      {show('playback') && (<>
      {!panel && <div className="settings-group-heading">PLAYBACK</div>}

      <div className="settings-subsection">
        <h4>JUST WATCH</h4>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={autoTuneOn}
              onChange={() => {
                const next = !autoTuneOn;
                setAutoTuneOn(next);
                setAutoTuneEnabled(next);
              }}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {autoTuneOn ? 'ON' : 'OFF'}
          </span>
        </div>
        <p className="settings-field-hint">
          Skip the guide and start watching immediately when you open the app.
          Prevue picks a channel based on time of day and your watch history.
        </p>
      </div>

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

      </>)}

      {show('ai') && (<>
      {!panel && <div className="settings-group-heading">AI <span className="settings-badge settings-badge-beta">BETA</span></div>}

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
        <div className="settings-iconic-refresh">
          <button
            className="settings-btn settings-btn-sm"
            onClick={handleIconicRefresh}
            disabled={!aiConfig?.hasKey || iconicRefreshing}
          >
            <ArrowClockwise size={14} className={iconicRefreshing ? 'spin' : ''} />
            {iconicRefreshing ? 'Refreshing...' : 'Refresh Scenes'}
          </button>
          {iconicLastRefreshed && (
            <span className="settings-field-hint settings-iconic-timestamp">
              Last refreshed: {new Date(iconicLastRefreshed + 'Z').toLocaleString()}
            </span>
          )}
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

      <div className={`settings-subsection ${!aiConfig?.hasKey ? 'settings-disabled' : ''}`}>
        <h4>WHAT DID I MISS</h4>
        <p className="settings-field-hint">
          AI-generated plot catch-up when you tune into a movie already in progress.
          Summarizes what&apos;s happened so far without spoiling the rest.
          {!aiConfig?.hasKey && ' Configure an API key above to enable.'}
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={catchUpEnabled}
              onChange={handleCatchUpToggle}
              disabled={!aiConfig?.hasKey}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {catchUpEnabled ? 'ON' : 'OFF'}
          </span>
        </div>
      </div>

      <div className={`settings-subsection ${!aiConfig?.hasKey ? 'settings-disabled' : ''}`}>
        <h4>HIDDEN GEMS</h4>
        <p className="settings-field-hint">
          AI analyzes your watch history and library to surface underwatched items
          you&apos;d love. Shows a gold badge in the guide and recommendations in the ticker.
          {!aiConfig?.hasKey && ' Configure an API key above to enable.'}
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={hiddenGemsEnabled}
              onChange={handleHiddenGemsToggle}
              disabled={!aiConfig?.hasKey}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {hiddenGemsEnabled ? 'ON' : 'OFF'}
          </span>
        </div>
        <div className="settings-iconic-refresh">
          <button
            className="settings-btn settings-btn-sm"
            onClick={handleGemsRefresh}
            disabled={!aiConfig?.hasKey || gemsRefreshing}
          >
            <ArrowClockwise size={14} className={gemsRefreshing ? 'spin' : ''} />
            {gemsRefreshing ? 'Analyzing...' : 'Refresh Gems'}
          </button>
          {gemsLastRefreshed && (
            <span className="settings-field-hint settings-iconic-timestamp">
              {gemsCount} gems found &middot; Last refreshed: {new Date(gemsLastRefreshed + 'Z').toLocaleString()}
            </span>
          )}
        </div>
      </div>

      </>)}

      {show('about') && (<>
      {!panel && <div className="settings-group-heading">APP</div>}

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
        <h4>KEYBOARD SHORTCUTS</h4>
        <p className="settings-field-hint">
          View all available keyboard shortcuts for navigating the guide and player.
        </p>
        <button
          className="settings-btn-sm"
          onClick={() => setShowShortcuts(true)}
        >
          VIEW SHORTCUTS
        </button>
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

      </>)}

      {show('system') && (<>
      {!panel && <div className="settings-group-heading">SYSTEM</div>}

      <div className="settings-subsection settings-danger-zone">
        <h4>RESTART SERVER</h4>
        <p className="settings-field-hint">
          Restart the Prevue server process. Requires a process manager (Docker, systemd) to bring it back up.
        </p>
        <button
          className="settings-btn-sm settings-btn-danger"
          onClick={handleRestart}
          disabled={restarting}
        >
          {restarting ? 'RESTARTING...' : 'RESTART SERVER'}
        </button>
      </div>

      <div className="settings-subsection settings-danger-zone">
        <h4>FACTORY RESET</h4>
        <p className="settings-field-hint">
          Delete all servers, channels, schedules, and settings. This cannot be undone.
        </p>
        <button
          className="settings-btn-sm settings-btn-danger"
          onClick={handleFactoryReset}
          disabled={resetting}
        >
          {resetting ? 'RESETTING...' : 'FACTORY RESET'}
        </button>
      </div>
      </>)}

      {show('about') && showShortcuts && (
        <SubModal id="shortcuts-modal" onClose={() => setShowShortcuts(false)}>
        <div
          className="about-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) setShowShortcuts(false); }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcuts-title"
        >
          <div className="about-modal" onClick={(e) => e.stopPropagation()}>
            <div className="about-header">
              <h2 id="shortcuts-title" className="about-title">KEYBOARD SHORTCUTS</h2>
              <button
                type="button"
                className="about-close"
                onClick={() => setShowShortcuts(false)}
                title="Close"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            <div className="about-body">
              <div className="about-section">
                <h3 className="about-section-title">GUIDE</h3>
                <table className="shortcuts-table">
                  <tbody>
                    <tr><td className="shortcut-key"><kbd>&uarr;</kbd> / <kbd>W</kbd></td><td>Previous channel</td></tr>
                    <tr><td className="shortcut-key"><kbd>&darr;</kbd> / <kbd>S</kbd></td><td>Next channel</td></tr>
                    <tr><td className="shortcut-key"><kbd>&larr;</kbd></td><td>Previous time slot</td></tr>
                    <tr><td className="shortcut-key"><kbd>&rarr;</kbd></td><td>Next time slot</td></tr>
                    <tr><td className="shortcut-key"><kbd>Enter</kbd></td><td>Tune to channel</td></tr>
                    <tr><td className="shortcut-key"><kbd>Escape</kbd></td><td>Open settings</td></tr>
                    <tr><td className="shortcut-key"><kbd>Backspace</kbd></td><td>Last channel</td></tr>
                    <tr><td className="shortcut-key"><kbd>R</kbd></td><td>Random channel</td></tr>
                    <tr><td className="shortcut-key"><kbd>F</kbd></td><td>Toggle fullscreen</td></tr>
                    <tr><td className="shortcut-key"><kbd>I</kbd></td><td>Program info</td></tr>
                  </tbody>
                </table>
              </div>

              <div className="about-divider" />

              <div className="about-section">
                <h3 className="about-section-title">PLAYER</h3>
                <table className="shortcuts-table">
                  <tbody>
                    <tr><td className="shortcut-key"><kbd>&uarr;</kbd> / <kbd>W</kbd></td><td>Channel up</td></tr>
                    <tr><td className="shortcut-key"><kbd>&darr;</kbd> / <kbd>S</kbd></td><td>Channel down</td></tr>
                    <tr><td className="shortcut-key"><kbd>Enter</kbd></td><td>Show controls</td></tr>
                    <tr><td className="shortcut-key"><kbd>Escape</kbd></td><td>Back to guide</td></tr>
                    <tr><td className="shortcut-key"><kbd>Backspace</kbd></td><td>Last channel</td></tr>
                    <tr><td className="shortcut-key"><kbd>R</kbd></td><td>Random channel</td></tr>
                    <tr><td className="shortcut-key"><kbd>F</kbd></td><td>Toggle fullscreen</td></tr>
                    <tr><td className="shortcut-key"><kbd>I</kbd></td><td>Program info</td></tr>
                    <tr><td className="shortcut-key"><kbd>P</kbd></td><td>Trigger promo overlay</td></tr>
                    <tr><td className="shortcut-key"><kbd>G</kbd></td><td>Back to guide</td></tr>
                    <tr><td className="shortcut-key"><kbd>T</kbd></td><td>Sleep timer</td></tr>
                    <tr><td className="shortcut-key"><kbd>M</kbd></td><td>What did I miss</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        </SubModal>
      )}

      {show('about') && showAbout && (
        <SubModal id="about-modal" onClose={closeAbout}>
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
        </SubModal>
      )}
    </div>
  );
}
