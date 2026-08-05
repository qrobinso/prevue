import { useState, useEffect } from 'react';
import { getSettings, updateSettings } from '../../services/api';
import { usePref } from '../../hooks/usePref';
import './Settings.css';

const PREVIEW_BG_KEY = 'preview_bg';

const CHANNEL_OPTIONS = [3, 5, 7, 10, 15];
const DEFAULT_VISIBLE_CHANNELS = 5;
const MIN_CHANNEL_COUNT = 3;
const MAX_CHANNEL_COUNT = 200;
const DEFAULT_CHANNEL_COUNT = 8;
const DEFAULT_GUIDE_HOURS = 1;
const MIN_GUIDE_HOURS = 1;
const MAX_GUIDE_HOURS = 4;

const DEFAULT_GUIDE_COLOR_MOVIE = '#1a3a5c';
const DEFAULT_GUIDE_COLOR_EPISODE = '#2d4a1e';

export type TickerSpeedId = 'slow' | 'standard' | 'fast';

export interface TickerSpeedPreset {
  id: TickerSpeedId;
  label: string;
  multiplier: number; // duration multiplier (higher = slower scroll)
}

export const TICKER_SPEED_PRESETS: TickerSpeedPreset[] = [
  { id: 'slow', label: 'Slow', multiplier: 2 },
  { id: 'standard', label: 'Standard', multiplier: 1 },
  { id: 'fast', label: 'Fast', multiplier: 0.5 },
];

const DEFAULT_TICKER_SPEED_ID: TickerSpeedId = 'standard';

export type PreviewBgOption = 'theme' | 'black' | 'white';
export type PreviewStyle = 'modern' | 'classic-left' | 'classic-right';
export type ClockFormat = '12h' | '24h';

const DEFAULT_CLOCK_FORMAT: ClockFormat = '12h';
const DEFAULT_PREVIEW_STYLE: PreviewStyle = 'modern';

export function applyPreviewBg(value: PreviewBgOption): void {
  document.documentElement.setAttribute('data-preview-bg', value);
}

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

const DEFAULT_SCROLL_SPEED_ID = 'normal';

function findScrollSpeedPreset(id: string): ScrollSpeedPreset {
  return SCROLL_SPEED_PRESETS.find(p => p.id === id) ?? SCROLL_SPEED_PRESETS.find(p => p.id === DEFAULT_SCROLL_SPEED_ID)!;
}

function findTickerSpeedPreset(id: string): TickerSpeedPreset {
  return TICKER_SPEED_PRESETS.find(p => p.id === id) ?? TICKER_SPEED_PRESETS.find(p => p.id === DEFAULT_TICKER_SPEED_ID)!;
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
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm orange & pink',
    colors: { primary: '#1b0f12', accent: '#ff7a59' },
  },
  {
    id: 'arctic',
    name: 'Arctic',
    description: 'Ice blue & white',
    colors: { primary: '#0a1a24', accent: '#66d9ff' },
  },
  {
    id: 'neon',
    name: 'Golden Hour',
    description: 'Dark amber & yellow',
    colors: { primary: '#161006', accent: '#ffd24d' },
  },
  {
    id: 'dark',
    name: 'Dark Mode',
    description: 'Pure dark & minimal',
    colors: { primary: '#0e0e0e', accent: '#a0a0a0' },
  },
  {
    id: 'vapor',
    name: 'Vaporwave',
    description: 'Pink & teal retro',
    colors: { primary: '#1a0a20', accent: '#ff71ce' },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Deep green & moss',
    colors: { primary: '#0b1410', accent: '#7dcea0' },
  },
  {
    id: 'noir',
    name: 'Film Noir',
    description: 'Monochrome cinema',
    colors: { primary: '#121212', accent: '#d4af37' },
  },
];

const DEFAULT_THEME = 'classic';

// Bootstrap the theme attribute before the ProfileProvider has loaded prefs, to avoid a
// flash of the wrong theme on first paint. This is the one legitimate raw-localStorage
// read left in this file: it runs at module-eval time, before any component (and
// therefore before any hook context) exists. DisplaySettings itself re-applies the
// profile's `color_theme` pref via usePref once the profile has loaded, superseding
// this guess.
function getBootstrapColorTheme(): string {
  try {
    const stored = localStorage.getItem('prevue_color_theme');
    if (stored && THEME_PRESETS.some(t => t.id === stored)) return stored;
  } catch {}
  return DEFAULT_THEME;
}

if (typeof window !== 'undefined') {
  document.documentElement.setAttribute('data-theme', getBootstrapColorTheme());
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
  { id: 'auto', label: 'Auto', bitrate: 120000000, description: 'Full quality, direct stream' },
  { id: '4k', label: '4K', bitrate: 80000000, maxWidth: 3840, description: '2160p, ~80 Mbps' },
  { id: '1080p', label: '1080p', bitrate: 20000000, maxWidth: 1920, description: '1080p, ~20 Mbps' },
  { id: '720p', label: '720p', bitrate: 8000000, maxWidth: 1280, description: '720p, ~8 Mbps' },
  { id: '480p', label: '480p', bitrate: 4000000, maxWidth: 854, description: '480p, ~4 Mbps' },
  { id: '360p', label: '360p', bitrate: 1500000, maxWidth: 640, description: '360p, ~1.5 Mbps' },
];

const DEFAULT_QUALITY_ID = 'auto';

function findQualityPreset(id: string): QualityPreset {
  return QUALITY_PRESETS.find(p => p.id === id) ?? QUALITY_PRESETS.find(p => p.id === DEFAULT_QUALITY_ID)!;
}

export type DisplayPanel = 'player' | 'theme' | 'guide' | 'channels';

interface DisplaySettingsProps {
  panel?: DisplayPanel;
}

export default function DisplaySettings({ panel }: DisplaySettingsProps = {}) {
  const show = (p: DisplayPanel) => !panel || panel === p;

  const [visibleChannels, setVisibleChannels] = usePref('visible_channels', DEFAULT_VISIBLE_CHANNELS);
  const [channelCount, setChannelCount] = usePref('channel_count', DEFAULT_CHANNEL_COUNT);
  const [guideHours, setGuideHours] = usePref('guide_hours', DEFAULT_GUIDE_HOURS);
  const [videoQualityId, setVideoQualityId] = usePref('video_quality', DEFAULT_QUALITY_ID);
  const videoQuality = findQualityPreset(videoQualityId);
  const [colorTheme, setColorThemeId] = usePref('color_theme', DEFAULT_THEME);
  const [previewBg, setPreviewBgState] = useState<PreviewBgOption>('theme');
  const [previewStyle, setPreviewStyle] = usePref<PreviewStyle>('preview_style', DEFAULT_PREVIEW_STYLE);
  const [autoScrollEnabled, setAutoScrollEnabled] = usePref('auto_scroll', false);
  const [autoScrollSpeedId, setAutoScrollSpeedId] = usePref('auto_scroll_speed', DEFAULT_SCROLL_SPEED_ID);
  const autoScrollSpeed = findScrollSpeedPreset(autoScrollSpeedId);
  const [promoOverlay, setPromoOverlay] = usePref('promo_overlay', true);
  const [startingSoon, setStartingSoon] = usePref('starting_soon', true);
  const [guideColorsEnabled, setGuideColorsEnabled] = usePref('guide_colors_enabled', false);
  const [guideColorMovie, setGuideColorMovie] = usePref('guide_color_movie', DEFAULT_GUIDE_COLOR_MOVIE);
  const [guideColorEpisode, setGuideColorEpisode] = usePref('guide_color_episode', DEFAULT_GUIDE_COLOR_EPISODE);
  const [guideRatingsEnabled, setGuideRatingsEnabled] = usePref('guide_ratings', false);
  const [guideYearEnabled, setGuideYearEnabled] = usePref('guide_year', false);
  const [guideResolutionEnabled, setGuideResolutionEnabled] = usePref('guide_resolution', false);
  const [guideHdrEnabled, setGuideHdrEnabled] = usePref('guide_hdr', false);
  const [guideArtworkEnabled, setGuideArtworkEnabled] = usePref('guide_artwork', false);
  const [guideTomatoEnabled, setGuideTomatoEnabled] = usePref('guide_tomato', false);
  const [clockFormat, setClockFormat] = usePref<ClockFormat>('clock_format', DEFAULT_CLOCK_FORMAT);
  const [tickerEnabled, setTickerEnabled] = usePref('ticker_enabled', true);
  const [tickerSpeedId, setTickerSpeedId] = usePref('ticker_speed', DEFAULT_TICKER_SPEED_ID);
  const tickerSpeed = findTickerSpeedPreset(tickerSpeedId);

  // Ensure theme is applied on mount
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorTheme);
  }, [colorTheme]);

  // Load settings from DB on mount
  useEffect(() => {
    getSettings()
      .then((s) => {
        const v = s[PREVIEW_BG_KEY];
        if (v === 'theme' || v === 'black' || v === 'white') {
          setPreviewBgState(v);
          applyPreviewBg(v);
        }
      })
      .catch(() => {});
  }, []);

  const handleThemeChange = (themeId: string) => {
    setColorThemeId(themeId);
    document.documentElement.setAttribute('data-theme', themeId);
    window.dispatchEvent(new CustomEvent('themechange', { detail: { themeId } }));
  };

  const handlePreviewBgChange = async (value: PreviewBgOption) => {
    setPreviewBgState(value);
    applyPreviewBg(value);
    try {
      await updateSettings({ [PREVIEW_BG_KEY]: value });
    } catch {
      // Keep applied locally even if save fails
    }
  };

  const handlePreviewStyleChange = (style: PreviewStyle) => {
    setPreviewStyle(style);
    window.dispatchEvent(new CustomEvent('previewstylechange', { detail: { style } }));
  };


  const handleAutoScrollToggle = () => {
    const newValue = !autoScrollEnabled;
    setAutoScrollEnabled(newValue);
    window.dispatchEvent(new CustomEvent('autoscrollchange', { detail: { enabled: newValue } }));
  };

  const handleTickerToggle = () => {
    const newValue = !tickerEnabled;
    setTickerEnabled(newValue);
    window.dispatchEvent(new CustomEvent('tickerchange', { detail: { enabled: newValue } }));
  };

  const handleTickerSpeedChange = (speedId: string) => {
    const preset = TICKER_SPEED_PRESETS.find(p => p.id === speedId);
    if (preset) {
      setTickerSpeedId(preset.id);
      window.dispatchEvent(new CustomEvent('tickerspeedchange', { detail: { speedId: preset.id } }));
    }
  };

  const handleScrollSpeedChange = (speedId: string) => {
    const preset = SCROLL_SPEED_PRESETS.find(p => p.id === speedId);
    if (preset) {
      setAutoScrollSpeedId(speedId);
      window.dispatchEvent(new CustomEvent('autoscrollspeedchange', { detail: { speedId } }));
    }
  };

  const handleGuideColorsToggle = () => {
    const newValue = !guideColorsEnabled;
    setGuideColorsEnabled(newValue);
    window.dispatchEvent(new CustomEvent('guidecolorschange'));
  };

  const handleGuideColorMovieChange = (color: string) => {
    setGuideColorMovie(color);
    window.dispatchEvent(new CustomEvent('guidecolorschange'));
  };

  const handleGuideColorEpisodeChange = (color: string) => {
    setGuideColorEpisode(color);
    window.dispatchEvent(new CustomEvent('guidecolorschange'));
  };

  const handleResetGuideColors = () => {
    setGuideColorMovie(DEFAULT_GUIDE_COLOR_MOVIE);
    setGuideColorEpisode(DEFAULT_GUIDE_COLOR_EPISODE);
    window.dispatchEvent(new CustomEvent('guidecolorschange'));
  };

  const handleGuideRatingsToggle = () => {
    const newValue = !guideRatingsEnabled;
    setGuideRatingsEnabled(newValue);
    window.dispatchEvent(new CustomEvent('guidebadgeschange'));
  };

  const handleGuideYearToggle = () => {
    const newValue = !guideYearEnabled;
    setGuideYearEnabled(newValue);
    window.dispatchEvent(new CustomEvent('guidebadgeschange'));
  };

  const handleGuideResolutionToggle = () => {
    const newValue = !guideResolutionEnabled;
    setGuideResolutionEnabled(newValue);
    window.dispatchEvent(new CustomEvent('guidebadgeschange'));
  };

  const handleGuideHdrToggle = () => {
    const newValue = !guideHdrEnabled;
    setGuideHdrEnabled(newValue);
    window.dispatchEvent(new CustomEvent('guidebadgeschange'));
  };

  const handleGuideArtworkToggle = () => {
    const newValue = !guideArtworkEnabled;
    setGuideArtworkEnabled(newValue);
    window.dispatchEvent(new CustomEvent('guideartworkchange'));
  };

  const handleGuideTomatoToggle = () => {
    const newValue = !guideTomatoEnabled;
    setGuideTomatoEnabled(newValue);
    window.dispatchEvent(new CustomEvent('guidebadgeschange'));
  };

  const handleClockFormatChange = (format: ClockFormat) => {
    setClockFormat(format);
    window.dispatchEvent(new CustomEvent('clockformatchange', { detail: { format } }));
  };


  const handleVisibleChannelsChange = (value: number) => {
    setVisibleChannels(value);
  };

  const handleChannelCountChange = (value: number) => {
    const clamped = Math.max(MIN_CHANNEL_COUNT, Math.min(MAX_CHANNEL_COUNT, value));
    setChannelCount(clamped);
    window.dispatchEvent(new CustomEvent('channelcountchange', { detail: { count: clamped } }));
  };

  const handleGuideHoursChange = (value: number) => {
    const clamped = Math.max(MIN_GUIDE_HOURS, Math.min(MAX_GUIDE_HOURS, value));
    setGuideHours(clamped);
    window.dispatchEvent(new CustomEvent('guidehourschange', { detail: { hours: clamped } }));
  };

  const handleQualityChange = (qualityId: string) => {
    const preset = QUALITY_PRESETS.find(p => p.id === qualityId);
    if (preset) {
      setVideoQualityId(qualityId);
      // Dispatch a custom event so the Player can react to quality changes
      window.dispatchEvent(new CustomEvent('qualitychange', { detail: { qualityId } }));
    }
  };


  return (
    <div className="settings-section">
      {!panel && <h3>DISPLAY</h3>}

      {show('player') && (<>
      {!panel && <div className="settings-group-heading">PLAYBACK</div>}

      <div className="settings-subsection">
        <h4>VIDEO QUALITY</h4>
        <p className="settings-field-hint">
          Maximum streaming quality. Lower quality uses less bandwidth and loads faster.
          You can also change this while watching using the settings button.
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


      </>)}

      {show('theme') && (<>
      {!panel && <div className="settings-group-heading">APPEARANCE</div>}

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

      </>)}

      {show('player') && (<>
      <div className="settings-subsection">
        <h4>PREVIEW BACKGROUND</h4>
        <p className="settings-field-hint">
          Color of the preview area when no channel is selected.
        </p>
        <div className="settings-preview-bg-options">
          {(['theme', 'black', 'white'] as const).map((opt) => (
            <button
              key={opt}
              className={`settings-preview-bg-btn ${previewBg === opt ? 'active' : ''}`}
              onClick={() => handlePreviewBgChange(opt)}
              style={
                opt === 'theme'
                  ? undefined
                  : opt === 'black'
                    ? { '--preview-bg-swatch': '#000' } as React.CSSProperties
                    : { '--preview-bg-swatch': '#fff' } as React.CSSProperties
              }
            >
              <span className="settings-preview-bg-swatch" />
              <span className="settings-preview-bg-label">
                {opt === 'theme' ? 'Theme' : opt === 'black' ? 'Black' : 'White'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-subsection">
        <h4>PREVIEW STYLE</h4>
        <p className="settings-field-hint">
          Layout style for the channel preview area. Classic shows a split-panel
          inspired by the 90s Prevue Channel. Left/Right controls which side the video appears on.
        </p>
        <div className="settings-preview-bg-options">
          {(['modern', 'classic-left', 'classic-right'] as const).map((opt) => (
            <button
              key={opt}
              className={`settings-preview-bg-btn ${previewStyle === opt ? 'active' : ''}`}
              onClick={() => handlePreviewStyleChange(opt)}
            >
              <span className="settings-preview-bg-label">
                {opt === 'modern' ? 'Modern' : opt === 'classic-left' ? 'Classic Left' : 'Classic Right'}
              </span>
            </button>
          ))}
        </div>
      </div>

      </>)}

      {show('guide') && (<>
      {!panel && <div className="settings-group-heading">GUIDE</div>}

      <div className="settings-subsection">
        <h4>LAYOUT</h4>
        <p className="settings-field-hint">
          Channels visible at once in the guide grid. Fewer channels means larger rows.
        </p>
        <div className="settings-channel-count-options" role="group" aria-label="Visible channels">
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
        <h4>ZOOM</h4>
        <p className="settings-field-hint">
          Hours visible on screen at once. Lower values zoom in for more detail.
        </p>
        <div className="settings-channel-count-options" role="group" aria-label="Guide hours">
          {[1, 2, 3, 4].map((hours) => (
            <button
              key={hours}
              className={`settings-channel-count-btn ${guideHours === hours ? 'active' : ''}`}
              onClick={() => handleGuideHoursChange(hours)}
              aria-label={`Guide hours: ${hours}`}
              aria-pressed={guideHours === hours}
            >
              {hours}h
            </button>
          ))}
        </div>
      </div>

      <div className="settings-subsection">
        <h4>CLOCK FORMAT</h4>
        <p className="settings-field-hint">
          Display times in 12-hour (AM/PM) or 24-hour format.
        </p>
        <div className="settings-channel-count-options" role="group" aria-label="Clock format">
          {(['12h', '24h'] as const).map((fmt) => (
            <button
              key={fmt}
              className={`settings-channel-count-btn ${clockFormat === fmt ? 'active' : ''}`}
              onClick={() => handleClockFormatChange(fmt)}
            >
              {fmt === '12h' ? '12H' : '24H'}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-subsection">
        <h4>BLOCK COLORS</h4>
        <p className="settings-field-hint">
          Color-code schedule blocks by content type.
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={guideColorsEnabled}
              onChange={handleGuideColorsToggle}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {guideColorsEnabled ? 'ON' : 'OFF'}
          </span>
        </div>
        {guideColorsEnabled && (
          <div className="settings-color-options">
            <div className="settings-color-row">
              <input
                type="color"
                className="settings-color-swatch"
                value={guideColorMovie}
                onChange={(e) => handleGuideColorMovieChange(e.target.value)}
              />
              <span className="settings-color-label">Movies</span>
            </div>
            <div className="settings-color-row">
              <input
                type="color"
                className="settings-color-swatch"
                value={guideColorEpisode}
                onChange={(e) => handleGuideColorEpisodeChange(e.target.value)}
              />
              <span className="settings-color-label">Shows</span>
            </div>
            <button
              className="settings-btn-sm"
              onClick={handleResetGuideColors}
              style={{ marginTop: 8 }}
            >
              RESET TO DEFAULTS
            </button>
          </div>
        )}
      </div>

      <div className="settings-subsection">
        <h4>GUIDE BADGES</h4>
        <p className="settings-field-hint">
          Show metadata badges on schedule blocks in the guide.
        </p>
        <div className="settings-badge-group">
          <div className="settings-badge-row">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={guideRatingsEnabled}
                onChange={handleGuideRatingsToggle}
              />
              <span className="settings-toggle-slider" />
            </label>
            <span className="settings-badge-label">Rating</span>
            <span className="settings-badge-example guide-rating-badge">PG-13</span>
          </div>
          <div className="settings-badge-row">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={guideYearEnabled}
                onChange={handleGuideYearToggle}
              />
              <span className="settings-toggle-slider" />
            </label>
            <span className="settings-badge-label">Year</span>
            <span className="settings-badge-example guide-year-badge">2024</span>
          </div>
          <div className="settings-badge-row">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={guideResolutionEnabled}
                onChange={handleGuideResolutionToggle}
              />
              <span className="settings-toggle-slider" />
            </label>
            <span className="settings-badge-label">Resolution</span>
            <span className="settings-badge-example guide-resolution-badge">4K</span>
          </div>
          <div className="settings-badge-row">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={guideHdrEnabled}
                onChange={handleGuideHdrToggle}
              />
              <span className="settings-toggle-slider" />
            </label>
            <span className="settings-badge-label">HDR</span>
            <span className="settings-badge-example guide-hdr-badge">HDR</span>
          </div>
          <div className="settings-badge-row">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={guideTomatoEnabled}
                onChange={handleGuideTomatoToggle}
              />
              <span className="settings-toggle-slider" />
            </label>
            <span className="settings-badge-label">Tomato Score</span>
            <span className="settings-badge-example guide-tomato-badge">92%</span>
          </div>
        </div>
      </div>

      <div className="settings-subsection">
        <h4>ARTWORK</h4>
        <p className="settings-field-hint">
          Show program artwork thumbnails in guide schedule blocks.
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={guideArtworkEnabled}
              onChange={handleGuideArtworkToggle}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {guideArtworkEnabled ? 'ON' : 'OFF'}
          </span>
        </div>
      </div>

      <div className="settings-subsection">
        <h4>AUTO-SCROLL</h4>
        <p className="settings-field-hint">
          Scroll through channels automatically like the classic TV Guide channel.
          Any input pauses scrolling temporarily.
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
        <h4>CHANNEL TICKER</h4>
        <p className="settings-field-hint">
          Scrolling marquee showing tonight's highlights, new additions, and library stats.
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={tickerEnabled}
              onChange={handleTickerToggle}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            {tickerEnabled ? 'ON' : 'OFF'}
          </span>
        </div>
        {tickerEnabled && (
          <div className="settings-speed-options">
            <span className="settings-speed-label">Speed:</span>
            {TICKER_SPEED_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={`settings-speed-btn ${tickerSpeed.id === preset.id ? 'active' : ''}`}
                onClick={() => handleTickerSpeedChange(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </div>

      </>)}

      {show('player') && (<>
      <div className="settings-subsection">
        <h4>IN-VIDEO NOTIFICATIONS</h4>
        <p className="settings-field-hint">
          Broadcast-style notifications that appear over the video during playback.
        </p>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={promoOverlay}
              onChange={(e) => {
                setPromoOverlay(e.target.checked);
                window.dispatchEvent(new CustomEvent('promooverlaychange', { detail: { enabled: e.target.checked } }));
              }}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            Now watching / Up next
          </span>
        </div>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={startingSoon}
              onChange={(e) => {
                setStartingSoon(e.target.checked);
                window.dispatchEvent(new CustomEvent('startingsoonchange', { detail: { enabled: e.target.checked } }));
              }}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            Starting soon on other channels
          </span>
        </div>
      </div>

      </>)}

      {show('channels') && (<>
      <div className="settings-subsection">
        <h4>TOTAL CHANNELS</h4>
        <p className="settings-field-hint">
          Maximum channels to auto-generate. More channels = more variety but may spread content thinner.
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
      </>)}

    </div>
  );
}
