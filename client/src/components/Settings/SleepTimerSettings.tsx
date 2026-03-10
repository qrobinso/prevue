import { useState, useEffect } from 'react';
import { Moon } from '@phosphor-icons/react';
import {
  getSleepEnabled, setSleepEnabled,
  getStoredPreset,
  getWindDownMinutes, setWindDownMinutes,
  getDimSeconds, setDimSeconds,
  SLEEP_PRESETS, WINDDOWN_OPTIONS, DIM_OPTIONS,
  formatSleepRemaining,
  type SleepTimerState,
  type SleepTimerActions,
} from '../../hooks/useSleepTimer';
import './Settings.css';

interface SleepTimerSettingsProps {
  sleepState: SleepTimerState;
  sleepActions: SleepTimerActions;
}

export default function SleepTimerSettings({ sleepState, sleepActions }: SleepTimerSettingsProps) {
  const [enabled, setEnabledLocal] = useState(getSleepEnabled);
  const [windDown, setWindDownLocal] = useState(getWindDownMinutes);
  const [dim, setDimLocal] = useState(getDimSeconds);
  const [lastPreset] = useState(getStoredPreset);

  // Keep in sync with external changes
  useEffect(() => {
    const handler = () => {
      setEnabledLocal(getSleepEnabled());
      setWindDownLocal(getWindDownMinutes());
      setDimLocal(getDimSeconds());
    };
    window.addEventListener('prevue_sleep_settings_change', handler);
    return () => window.removeEventListener('prevue_sleep_settings_change', handler);
  }, []);

  const handleEnabledToggle = () => {
    const next = !enabled;
    setEnabledLocal(next);
    setSleepEnabled(next);
  };

  const handleWindDownChange = (min: number) => {
    setWindDownLocal(min);
    setWindDownMinutes(min);
  };

  const handleDimChange = (sec: number) => {
    setDimLocal(sec);
    setDimSeconds(sec);
  };

  const formatDimLabel = (sec: number) => {
    if (sec === 0) return 'Off';
    if (sec < 60) return `${sec}s`;
    return `${sec / 60}m`;
  };

  const formatWindDownLabel = (min: number) => {
    if (min === 0) return 'Off';
    return `${min}m`;
  };

  return (
    <div className="settings-section">

      {/* ── Enable / Disable ──────────────────────────── */}
      <div className="settings-group-heading">SLEEP TIMER</div>

      <div className="settings-subsection">
        <h4>ENABLE</h4>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={handleEnabledToggle}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {enabled ? 'ON' : 'OFF'}
          </span>
        </div>
        <p className="settings-field-hint">
          When enabled, press <kbd>T</kbd> in the player to set a sleep timer.
          The volume fades out and the screen dims before playback stops.
        </p>
      </div>

      {/* ── Live Countdown ────────────────────────────── */}
      {enabled && (
        <div className="settings-subsection">
          <h4>STATUS</h4>
          {sleepState.active ? (
            <div className="sleep-settings-countdown">
              <div className="sleep-settings-countdown-ring">
                <svg viewBox="0 0 100 100" className="sleep-settings-countdown-svg">
                  <circle
                    cx="50" cy="50" r="44"
                    fill="none"
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="6"
                  />
                  <circle
                    cx="50" cy="50" r="44"
                    fill="none"
                    stroke={sleepState.isWindingDown ? '#fbbf24' : '#6366f1'}
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeDasharray={`${2 * Math.PI * 44}`}
                    strokeDashoffset={`${2 * Math.PI * 44 * (1 - (sleepState.totalMs > 0 ? sleepState.remainingMs / sleepState.totalMs : 0))}`}
                    style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.5s ease' }}
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <div className="sleep-settings-countdown-inner">
                  <Moon size={16} weight="bold" className={sleepState.isWindingDown ? 'sleep-settings-amber' : ''} />
                  <span className={`sleep-settings-countdown-time ${sleepState.isWindingDown ? 'sleep-settings-amber' : ''}`}>
                    {formatSleepRemaining(sleepState.remainingMs)}
                  </span>
                </div>
              </div>
              <div className="sleep-settings-countdown-meta">
                {sleepState.isWindingDown ? (
                  <span className="sleep-settings-amber">Winding down...</span>
                ) : sleepState.isDimming ? (
                  <span className="sleep-settings-amber">Dimming...</span>
                ) : (
                  <span>Timer active</span>
                )}
                <button
                  type="button"
                  className="settings-btn-sm settings-btn-danger"
                  onClick={() => sleepActions.cancel()}
                >
                  CANCEL
                </button>
              </div>
            </div>
          ) : sleepState.isExpired ? (
            <div className="sleep-settings-status-line">
              <span>Timer expired. Playback paused.</span>
            </div>
          ) : (
            <div className="sleep-settings-status-line">
              <span>No active timer. Press <kbd>T</kbd> in the player to start.</span>
            </div>
          )}
        </div>
      )}

      {/* ── Quick Start ───────────────────────────────── */}
      {enabled && !sleepState.active && (
        <div className="settings-subsection">
          <h4>QUICK START</h4>
          <p className="settings-field-hint">
            Start a sleep timer now. You can also press <kbd>T</kbd> while watching.
          </p>
          <div className="settings-channel-count-options">
            {SLEEP_PRESETS.map((min) => (
              <button
                key={min}
                className={`settings-channel-count-btn ${lastPreset === min ? 'active' : ''}`}
                onClick={() => sleepActions.start(min)}
              >
                {min}m
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Wind-Down Duration ────────────────────────── */}
      {enabled && (
        <div className="settings-subsection">
          <h4>VOLUME WIND-DOWN</h4>
          <p className="settings-field-hint">
            How long before the timer ends to start fading the volume to silence.
          </p>
          <div className="settings-channel-count-options">
            {WINDDOWN_OPTIONS.map((min) => (
              <button
                key={min}
                className={`settings-channel-count-btn ${windDown === min ? 'active' : ''}`}
                onClick={() => handleWindDownChange(min)}
              >
                {formatWindDownLabel(min)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Screen Dim Duration ───────────────────────── */}
      {enabled && (
        <div className="settings-subsection">
          <h4>SCREEN DIM</h4>
          <p className="settings-field-hint">
            How long before the timer ends to start dimming the screen to black.
          </p>
          <div className="settings-channel-count-options">
            {DIM_OPTIONS.map((sec) => (
              <button
                key={sec}
                className={`settings-channel-count-btn ${dim === sec ? 'active' : ''}`}
                onClick={() => handleDimChange(sec)}
              >
                {formatDimLabel(sec)}
              </button>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
