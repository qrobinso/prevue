import { useState, useEffect } from 'react';
import { factoryReset } from '../../services/api';
import './Settings.css';

const VISIBLE_CHANNELS_KEY = 'prevue_visible_channels';
const CHANNEL_COUNT_KEY = 'prevue_channel_count';
const GUIDE_HOURS_KEY = 'prevue_guide_hours';
const CHANNEL_OPTIONS = [3, 5, 7, 10, 15];
const DEFAULT_VISIBLE_CHANNELS = 5;
const MIN_CHANNEL_COUNT = 3;
const MAX_CHANNEL_COUNT = 100;
const DEFAULT_CHANNEL_COUNT = 8;
const DEFAULT_GUIDE_HOURS = 1;
const MIN_GUIDE_HOURS = 1;
const MAX_GUIDE_HOURS = 4;

const VIDEO_QUALITY_KEY = 'prevue_video_quality';
const COLOR_THEME_KEY = 'prevue_color_theme';
const AUTO_SCROLL_KEY = 'prevue_auto_scroll';
const AUTO_SCROLL_SPEED_KEY = 'prevue_auto_scroll_speed';

// Auto-scroll speed presets (seconds per channel)
export interface ScrollSpeedPreset {
  id: string;
  label: string;
  seconds: number;
  description: string;
}

export const SCROLL_SPEED_PRESETS: ScrollSpeedPreset[] = [
  { id: 'slow', label: 'Slow', seconds: 12, description: '12 seconds per page' },
  { id: 'normal', label: 'Normal', seconds: 8, description: '8 seconds per page' },
  { id: 'fast', label: 'Fast', seconds: 5, description: '5 seconds per page' },
];

const DEFAULT_SCROLL_SPEED = 'normal';

export function getAutoScroll(): boolean {
  try {
    const stored = localStorage.getItem(AUTO_SCROLL_KEY);
    if (stored !== null) {
      return stored === 'true';
    }
  } catch {}
  return false; // Default off
}

export function setAutoScroll(enabled: boolean): void {
  localStorage.setItem(AUTO_SCROLL_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('autoscrollchange', { detail: { enabled } }));
}

export function getAutoScrollSpeed(): ScrollSpeedPreset {
  try {
    const stored = localStorage.getItem(AUTO_SCROLL_SPEED_KEY);
    if (stored) {
      const preset = SCROLL_SPEED_PRESETS.find(p => p.id === stored);
      if (preset) return preset;
    }
  } catch {}
  return SCROLL_SPEED_PRESETS.find(p => p.id === DEFAULT_SCROLL_SPEED)!;
}

export function setAutoScrollSpeed(speedId: string): void {
  localStorage.setItem(AUTO_SCROLL_SPEED_KEY, speedId);
  window.dispatchEvent(new CustomEvent('autoscrollspeedchange', { detail: { speedId } }));
}

// Color theme presets
export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  colors: {
    primary: string;
    accent: string;
  };
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'classic',
    name: 'Prevue Classic',
    description: 'Original blue & cyan',
    colors: { primary: '#0a0e2a', accent: '#00e5ff' },
  },
  {
    id: 'tvguide',
    name: 'TV Guide',
    description: 'Classic red & gold',
    colors: { primary: '#1a0808', accent: '#ff4444' },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Purple & magenta',
    colors: { primary: '#0f0a1a', accent: '#cc66ff' },
  },
  {
    id: 'crt',
    name: 'Retro CRT',
    description: 'Green phosphor',
    colors: { primary: '#0a0f0a', accent: '#00ff66' },
  },
  {
    id: 'cable',
    name: 'Cable Box',
    description: '90s gray & blue',
    colors: { primary: '#1a1a1e', accent: '#3399ff' },
  },
];

const DEFAULT_THEME = 'classic';

export function getColorTheme(): string {
  try {
    const stored = localStorage.getItem(COLOR_THEME_KEY);
    if (stored && THEME_PRESETS.some(t => t.id === stored)) {
      return stored;
    }
  } catch {}
  return DEFAULT_THEME;
}

export function setColorTheme(themeId: string): void {
  localStorage.setItem(COLOR_THEME_KEY, themeId);
  document.documentElement.setAttribute('data-theme', themeId);
  window.dispatchEvent(new CustomEvent('themechange', { detail: { themeId } }));
}

// Initialize theme on module load
if (typeof window !== 'undefined') {
  const savedTheme = getColorTheme();
  document.documentElement.setAttribute('data-theme', savedTheme);
}

// Quality presets with bitrate (in bits per second) and max resolution
export interface QualityPreset {
  id: string;
  label: string;
  bitrate: number;      // Max bitrate in bps
  maxWidth?: number;    // Max width (height is auto)
  description: string;
}

export const QUALITY_PRESETS: QualityPreset[] = [
  { id: 'auto', label: 'Auto', bitrate: 120000000, description: 'Best quality available' },
  { id: '4k', label: '4K', bitrate: 80000000, maxWidth: 3840, description: '2160p, ~80 Mbps' },
  { id: '1080p', label: '1080p', bitrate: 20000000, maxWidth: 1920, description: '1080p, ~20 Mbps' },
  { id: '720p', label: '720p', bitrate: 8000000, maxWidth: 1280, description: '720p, ~8 Mbps' },
  { id: '480p', label: '480p', bitrate: 4000000, maxWidth: 854, description: '480p, ~4 Mbps' },
  { id: '360p', label: '360p', bitrate: 1500000, maxWidth: 640, description: '360p, ~1.5 Mbps' },
];

const DEFAULT_QUALITY = 'auto';

export function getVideoQuality(): QualityPreset {
  try {
    const stored = localStorage.getItem(VIDEO_QUALITY_KEY);
    if (stored) {
      const preset = QUALITY_PRESETS.find(p => p.id === stored);
      if (preset) return preset;
    }
  } catch {}
  return QUALITY_PRESETS.find(p => p.id === DEFAULT_QUALITY)!;
}

export function setVideoQuality(qualityId: string): void {
  localStorage.setItem(VIDEO_QUALITY_KEY, qualityId);
  // Dispatch a custom event so the Player can react to quality changes
  window.dispatchEvent(new CustomEvent('qualitychange', { detail: { qualityId } }));
}

export function getVisibleChannels(): number {
  try {
    const stored = localStorage.getItem(VISIBLE_CHANNELS_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (CHANNEL_OPTIONS.includes(val)) return val;
    }
  } catch {}
  return DEFAULT_VISIBLE_CHANNELS;
}

export function getChannelCount(): number {
  try {
    const stored = localStorage.getItem(CHANNEL_COUNT_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (val >= MIN_CHANNEL_COUNT && val <= MAX_CHANNEL_COUNT) return val;
    }
  } catch {}
  return DEFAULT_CHANNEL_COUNT;
}

export function setChannelCount(count: number): void {
  localStorage.setItem(CHANNEL_COUNT_KEY, String(count));
  window.dispatchEvent(new CustomEvent('channelcountchange', { detail: { count } }));
}

export function getGuideHours(): number {
  try {
    const stored = localStorage.getItem(GUIDE_HOURS_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (val >= MIN_GUIDE_HOURS && val <= MAX_GUIDE_HOURS) return val;
    }
  } catch {}
  return DEFAULT_GUIDE_HOURS;
}

export function setGuideHours(hours: number): void {
  const clamped = Math.max(MIN_GUIDE_HOURS, Math.min(MAX_GUIDE_HOURS, hours));
  localStorage.setItem(GUIDE_HOURS_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent('guidehourschange', { detail: { hours: clamped } }));
}

export default function DisplaySettings() {
  const [visibleChannels, setVisibleChannels] = useState(getVisibleChannels);
  const [channelCount, setChannelCountState] = useState(getChannelCount);
  const [guideHours, setGuideHoursState] = useState(getGuideHours);
  const [videoQuality, setVideoQualityState] = useState(getVideoQuality);
  const [colorTheme, setColorThemeState] = useState(getColorTheme);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(getAutoScroll);
  const [autoScrollSpeed, setAutoScrollSpeedState] = useState(getAutoScrollSpeed);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ensure theme is applied on mount
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorTheme);
  }, [colorTheme]);

  const handleThemeChange = (themeId: string) => {
    setColorThemeState(themeId);
    setColorTheme(themeId);
  };

  const handleAutoScrollToggle = () => {
    const newValue = !autoScrollEnabled;
    setAutoScrollEnabled(newValue);
    setAutoScroll(newValue);
  };

  const handleScrollSpeedChange = (speedId: string) => {
    const preset = SCROLL_SPEED_PRESETS.find(p => p.id === speedId);
    if (preset) {
      setAutoScrollSpeedState(preset);
      setAutoScrollSpeed(speedId);
    }
  };

  const handleVisibleChannelsChange = (value: number) => {
    setVisibleChannels(value);
    localStorage.setItem(VISIBLE_CHANNELS_KEY, String(value));
  };

  const handleChannelCountChange = (value: number) => {
    const clamped = Math.max(MIN_CHANNEL_COUNT, Math.min(MAX_CHANNEL_COUNT, value));
    setChannelCountState(clamped);
    setChannelCount(clamped);
  };

  const handleGuideHoursChange = (value: number) => {
    setGuideHoursState(value);
    setGuideHours(value);
  };

  const handleQualityChange = (qualityId: string) => {
    const preset = QUALITY_PRESETS.find(p => p.id === qualityId);
    if (preset) {
      setVideoQualityState(preset);
      setVideoQuality(qualityId);
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
      // Clear local storage settings as well
      localStorage.removeItem(VISIBLE_CHANNELS_KEY);
      localStorage.removeItem(VIDEO_QUALITY_KEY);
      localStorage.removeItem(COLOR_THEME_KEY);
      localStorage.removeItem(AUTO_SCROLL_KEY);
      localStorage.removeItem(AUTO_SCROLL_SPEED_KEY);
      localStorage.removeItem(GUIDE_HOURS_KEY);
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
      <h3>DISPLAY</h3>

      <div className="settings-subsection">
        <h4>VIDEO QUALITY</h4>
        <p className="settings-field-hint">
          Maximum streaming quality. Lower quality uses less bandwidth and loads faster.
          You can also change this while watching using the quality button.
        </p>
        <div className="settings-quality-options">
          {QUALITY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={`settings-quality-btn ${videoQuality.id === preset.id ? 'active' : ''}`}
              onClick={() => handleQualityChange(preset.id)}
            >
              <span className="settings-quality-label">{preset.label}</span>
              <span className="settings-quality-desc">{preset.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-subsection">
        <h4>COLOR SCHEME</h4>
        <p className="settings-field-hint">
          Choose a color theme for the guide interface.
        </p>
        <div className="settings-theme-options">
          {THEME_PRESETS.map((theme) => (
            <button
              key={theme.id}
              className={`settings-theme-btn ${colorTheme === theme.id ? 'active' : ''}`}
              onClick={() => handleThemeChange(theme.id)}
              style={{
                '--theme-bg': theme.colors.primary,
                '--theme-accent': theme.colors.accent,
              } as React.CSSProperties}
            >
              <span className="settings-theme-preview">
                <span className="settings-theme-preview-bg" />
                <span className="settings-theme-preview-accent" />
              </span>
              <span className="settings-theme-info">
                <span className="settings-theme-name">{theme.name}</span>
                <span className="settings-theme-desc">{theme.description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-subsection">
        <h4>AUTO-SCROLL</h4>
        <p className="settings-field-hint">
          Automatically scroll through channels like the classic TV Guide channel.
          Displays a page of channels, then scrolls to the next page.
          Any keyboard or mouse input will pause scrolling temporarily.
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={autoScrollEnabled}
              onChange={handleAutoScrollToggle}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {autoScrollEnabled ? 'ON' : 'OFF'}
          </span>
        </div>
        {autoScrollEnabled && (
          <div className="settings-speed-options">
            <span className="settings-speed-label">Speed:</span>
            {SCROLL_SPEED_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={`settings-speed-btn ${autoScrollSpeed.id === preset.id ? 'active' : ''}`}
                onClick={() => handleScrollSpeedChange(preset.id)}
                title={preset.description}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="settings-subsection">
        <h4>VISIBLE CHANNELS</h4>
        <p className="settings-field-hint">
          Number of channels visible at once in the guide grid.
          Fewer channels means larger rows and text.
        </p>
        <div className="settings-channel-count-options">
          {CHANNEL_OPTIONS.map((count) => (
            <button
              key={count}
              className={`settings-channel-count-btn ${visibleChannels === count ? 'active' : ''}`}
              onClick={() => handleVisibleChannelsChange(count)}
            >
              {count}
            </button>
          ))}
        </div>
        <div className="settings-channel-count-label">
          {visibleChannels <= 3 && 'Extra Large'}
          {visibleChannels === 5 && 'Large'}
          {visibleChannels === 7 && 'Medium'}
          {visibleChannels === 10 && 'Compact'}
          {visibleChannels >= 15 && 'Dense'}
        </div>
      </div>

      <div className="settings-subsection">
        <h4>GUIDE ZOOM</h4>
        <p className="settings-field-hint">
          How many hours to show on screen at once. Lower values zoom in for more detail.
          You can still scroll through the full 8-hour schedule.
        </p>
        <div className="settings-channel-count-options">
          {[1, 2, 3, 4].map((hours) => (
            <button
              key={hours}
              className={`settings-channel-count-btn ${guideHours === hours ? 'active' : ''}`}
              onClick={() => handleGuideHoursChange(hours)}
            >
              {hours}h
            </button>
          ))}
        </div>
      </div>

      <div className="settings-subsection">
        <h4>TOTAL CHANNELS TO GENERATE</h4>
        <p className="settings-field-hint">
          Maximum number of channels to auto-generate when regenerating channels.
          More channels = more variety but may spread content thinner.
        </p>
        <div className="settings-slider-container">
          <input
            type="range"
            className="settings-slider"
            min={MIN_CHANNEL_COUNT}
            max={MAX_CHANNEL_COUNT}
            value={channelCount}
            onChange={(e) => handleChannelCountChange(parseInt(e.target.value, 10))}
          />
          <div className="settings-slider-value">{channelCount}</div>
        </div>
        <div className="settings-slider-labels">
          <span>{MIN_CHANNEL_COUNT}</span>
          <span>CHANNELS</span>
          <span>{MAX_CHANNEL_COUNT}</span>
        </div>
      </div>

      <div className="settings-subsection settings-danger-zone">
        <h4>DANGER ZONE</h4>
        <p className="settings-field-hint">
          Factory reset will delete all servers, channels, schedules, and settings.
          This action cannot be undone.
        </p>
        {error && <div className="settings-error">{error}</div>}
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
    </div>
  );
}
