import { useState, useEffect } from 'react';
import { getSettings, updateSettings } from '../../services/api';
import './Settings.css';

const PREVIEW_BG_KEY = 'preview_bg';

const VISIBLE_CHANNELS_KEY = 'prevue_visible_channels';
const CHANNEL_COUNT_KEY = 'prevue_channel_count';
const GUIDE_HOURS_KEY = 'prevue_guide_hours';
const CHANNEL_OPTIONS = [3, 5, 7, 10, 15];
const DEFAULT_VISIBLE_CHANNELS = 5;
const MIN_CHANNEL_COUNT = 3;
const MAX_CHANNEL_COUNT = 200;
const DEFAULT_CHANNEL_COUNT = 8;
const DEFAULT_GUIDE_HOURS = 1;
const MIN_GUIDE_HOURS = 1;
const MAX_GUIDE_HOURS = 4;

const VIDEO_QUALITY_KEY = 'prevue_video_quality';
const COLOR_THEME_KEY = 'prevue_color_theme';
const AUTO_SCROLL_KEY = 'prevue_auto_scroll';
const AUTO_SCROLL_SPEED_KEY = 'prevue_auto_scroll_speed';
const GUIDE_COLORS_ENABLED_KEY = 'prevue_guide_colors_enabled';
const GUIDE_COLOR_MOVIE_KEY = 'prevue_guide_color_movie';
const GUIDE_COLOR_EPISODE_KEY = 'prevue_guide_color_episode';
const DEFAULT_GUIDE_COLOR_MOVIE = '#1a3a5c';
const DEFAULT_GUIDE_COLOR_EPISODE = '#2d4a1e';
const GUIDE_RATINGS_KEY = 'prevue_guide_ratings';
const GUIDE_YEAR_KEY = 'prevue_guide_year';
const GUIDE_RESOLUTION_KEY = 'prevue_guide_resolution';
const GUIDE_HDR_KEY = 'prevue_guide_hdr';
const GUIDE_ARTWORK_KEY = 'prevue_guide_artwork';
const GUIDE_TOMATO_KEY = 'prevue_guide_tomato';
const PREVIEW_STYLE_KEY = 'prevue_preview_style';
const CLOCK_FORMAT_KEY = 'prevue_clock_format';
const PROMO_OVERLAY_KEY = 'prevue_promo_overlay';
const STARTING_SOON_KEY = 'prevue_starting_soon';
const TICKER_KEY = 'prevue_ticker_enabled';
const TICKER_SPEED_KEY = 'prevue_ticker_speed';

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

export type PreviewBgOption = 'theme' | 'black' | 'white';
export type PreviewStyle = 'modern' | 'classic-left' | 'classic-right';
export type ClockFormat = '12h' | '24h';

export function getClockFormat(): ClockFormat {
  try {
    const stored = localStorage.getItem(CLOCK_FORMAT_KEY);
    if (stored === '12h' || stored === '24h') return stored;
  } catch {}
  return '12h';
}

export function setClockFormat(format: ClockFormat): void {
  localStorage.setItem(CLOCK_FORMAT_KEY, format);
  window.dispatchEvent(new CustomEvent('clockformatchange', { detail: { format } }));
}

export function getPromoOverlayEnabled(): boolean {
  try {
    const stored = localStorage.getItem(PROMO_OVERLAY_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return true; // default: enabled
}

export function setPromoOverlayEnabled(enabled: boolean): void {
  localStorage.setItem(PROMO_OVERLAY_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('promooverlaychange', { detail: { enabled } }));
}

export function getStartingSoonEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STARTING_SOON_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return true; // default: enabled
}

export function setStartingSoonEnabled(enabled: boolean): void {
  localStorage.setItem(STARTING_SOON_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('startingsoonchange', { detail: { enabled } }));
}

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

// Channel ticker helpers
export function getTickerEnabled(): boolean {
  try {
    const stored = localStorage.getItem(TICKER_KEY);
    if (stored !== null) return stored === 'true';
  } catch {}
  return true; // Default on
}

export function setTickerEnabled(enabled: boolean): void {
  localStorage.setItem(TICKER_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('tickerchange', { detail: { enabled } }));
}

export function getTickerSpeed(): TickerSpeedPreset {
  try {
    const stored = localStorage.getItem(TICKER_SPEED_KEY);
    if (stored) {
      const preset = TICKER_SPEED_PRESETS.find(p => p.id === stored);
      if (preset) return preset;
    }
  } catch {}
  return TICKER_SPEED_PRESETS.find(p => p.id === 'standard')!;
}

export function setTickerSpeed(speedId: TickerSpeedId): void {
  localStorage.setItem(TICKER_SPEED_KEY, speedId);
  window.dispatchEvent(new CustomEvent('tickerspeedchange', { detail: { speedId } }));
}

// Guide color-coding helpers
export function getGuideColorsEnabled(): boolean {
  try {
    return localStorage.getItem(GUIDE_COLORS_ENABLED_KEY) === 'true';
  } catch {}
  return false;
}

export function setGuideColorsEnabled(enabled: boolean): void {
  localStorage.setItem(GUIDE_COLORS_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('guidecolorschange'));
}

export function getGuideColorMovie(): string {
  try {
    const stored = localStorage.getItem(GUIDE_COLOR_MOVIE_KEY);
    if (stored && /^#[0-9a-fA-F]{6}$/.test(stored)) return stored;
  } catch {}
  return DEFAULT_GUIDE_COLOR_MOVIE;
}

export function setGuideColorMovie(color: string): void {
  localStorage.setItem(GUIDE_COLOR_MOVIE_KEY, color);
  window.dispatchEvent(new CustomEvent('guidecolorschange'));
}

export function getGuideColorEpisode(): string {
  try {
    const stored = localStorage.getItem(GUIDE_COLOR_EPISODE_KEY);
    if (stored && /^#[0-9a-fA-F]{6}$/.test(stored)) return stored;
  } catch {}
  return DEFAULT_GUIDE_COLOR_EPISODE;
}

export function setGuideColorEpisode(color: string): void {
  localStorage.setItem(GUIDE_COLOR_EPISODE_KEY, color);
  window.dispatchEvent(new CustomEvent('guidecolorschange'));
}

export function resetGuideColors(): void {
  localStorage.removeItem(GUIDE_COLOR_MOVIE_KEY);
  localStorage.removeItem(GUIDE_COLOR_EPISODE_KEY);
  window.dispatchEvent(new CustomEvent('guidecolorschange'));
}

// Guide ratings badge helpers
export function getGuideRatings(): boolean {
  try {
    return localStorage.getItem(GUIDE_RATINGS_KEY) === 'true';
  } catch {}
  return false;
}

export function setGuideRatings(enabled: boolean): void {
  localStorage.setItem(GUIDE_RATINGS_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('guidebadgeschange'));
}

// Guide year badge helpers
export function getGuideYear(): boolean {
  try {
    return localStorage.getItem(GUIDE_YEAR_KEY) === 'true';
  } catch {}
  return false;
}

export function setGuideYear(enabled: boolean): void {
  localStorage.setItem(GUIDE_YEAR_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('guidebadgeschange'));
}

// Guide resolution badge helpers
export function getGuideResolution(): boolean {
  try {
    return localStorage.getItem(GUIDE_RESOLUTION_KEY) === 'true';
  } catch {}
  return false;
}

export function setGuideResolution(enabled: boolean): void {
  localStorage.setItem(GUIDE_RESOLUTION_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('guidebadgeschange'));
}

// Guide HDR badge helpers
export function getGuideHdr(): boolean {
  try {
    return localStorage.getItem(GUIDE_HDR_KEY) === 'true';
  } catch {}
  return false;
}

export function setGuideHdr(enabled: boolean): void {
  localStorage.setItem(GUIDE_HDR_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('guidebadgeschange'));
}

// Guide artwork thumbnail helpers
export function getGuideArtwork(): boolean {
  try {
    return localStorage.getItem(GUIDE_ARTWORK_KEY) === 'true';
  } catch {}
  return false;
}

export function setGuideArtwork(enabled: boolean): void {
  localStorage.setItem(GUIDE_ARTWORK_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('guideartworkchange'));
}

// Guide tomato rating badge helpers
export function getGuideTomato(): boolean {
  try {
    return localStorage.getItem(GUIDE_TOMATO_KEY) === 'true';
  } catch {}
  return false;
}

export function setGuideTomato(enabled: boolean): void {
  localStorage.setItem(GUIDE_TOMATO_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('guidebadgeschange'));
}

// Preview style helpers
export function getPreviewStyle(): PreviewStyle {
  try {
    const stored = localStorage.getItem(PREVIEW_STYLE_KEY);
    if (stored === 'modern' || stored === 'classic-left' || stored === 'classic-right') return stored;
    // Migrate legacy 'classic' value to 'classic-right'
    if (stored === 'classic') return 'classic-right';
  } catch {}
  return 'modern';
}

export function setPreviewStyle(style: PreviewStyle): void {
  localStorage.setItem(PREVIEW_STYLE_KEY, style);
  window.dispatchEvent(new CustomEvent('previewstylechange', { detail: { style } }));
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
  { id: 'auto', label: 'Auto', bitrate: 120000000, description: 'Full quality, direct stream' },
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
  const [previewBg, setPreviewBgState] = useState<PreviewBgOption>('theme');
  const [previewStyle, setPreviewStyleState] = useState<PreviewStyle>(getPreviewStyle);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(getAutoScroll);
  const [autoScrollSpeed, setAutoScrollSpeedState] = useState(getAutoScrollSpeed);
  const [promoOverlay, setPromoOverlay] = useState(getPromoOverlayEnabled);
  const [startingSoon, setStartingSoon] = useState(getStartingSoonEnabled);
  const [guideColorsEnabled, setGuideColorsEnabledState] = useState(getGuideColorsEnabled);
  const [guideColorMovie, setGuideColorMovieState] = useState(getGuideColorMovie);
  const [guideColorEpisode, setGuideColorEpisodeState] = useState(getGuideColorEpisode);
  const [guideRatingsEnabled, setGuideRatingsEnabledState] = useState(getGuideRatings);
  const [guideYearEnabled, setGuideYearEnabledState] = useState(getGuideYear);
  const [guideResolutionEnabled, setGuideResolutionEnabledState] = useState(getGuideResolution);
  const [guideHdrEnabled, setGuideHdrEnabledState] = useState(getGuideHdr);
  const [guideArtworkEnabled, setGuideArtworkEnabledState] = useState(getGuideArtwork);
  const [guideTomatoEnabled, setGuideTomatoEnabledState] = useState(getGuideTomato);
  const [clockFormat, setClockFormatState] = useState<ClockFormat>(getClockFormat);
  const [tickerEnabled, setTickerEnabledState] = useState(getTickerEnabled);
  const [tickerSpeed, setTickerSpeedState] = useState(getTickerSpeed);
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
    setColorThemeState(themeId);
    setColorTheme(themeId);
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
    setPreviewStyleState(style);
    setPreviewStyle(style);
  };


  const handleAutoScrollToggle = () => {
    const newValue = !autoScrollEnabled;
    setAutoScrollEnabled(newValue);
    setAutoScroll(newValue);
  };

  const handleTickerToggle = () => {
    const newValue = !tickerEnabled;
    setTickerEnabledState(newValue);
    setTickerEnabled(newValue);
  };

  const handleTickerSpeedChange = (speedId: string) => {
    const preset = TICKER_SPEED_PRESETS.find(p => p.id === speedId);
    if (preset) {
      setTickerSpeedState(preset);
      setTickerSpeed(preset.id);
    }
  };

  const handleScrollSpeedChange = (speedId: string) => {
    const preset = SCROLL_SPEED_PRESETS.find(p => p.id === speedId);
    if (preset) {
      setAutoScrollSpeedState(preset);
      setAutoScrollSpeed(speedId);
    }
  };

  const handleGuideColorsToggle = () => {
    const newValue = !guideColorsEnabled;
    setGuideColorsEnabledState(newValue);
    setGuideColorsEnabled(newValue);
  };

  const handleGuideColorMovieChange = (color: string) => {
    setGuideColorMovieState(color);
    setGuideColorMovie(color);
  };

  const handleGuideColorEpisodeChange = (color: string) => {
    setGuideColorEpisodeState(color);
    setGuideColorEpisode(color);
  };

  const handleResetGuideColors = () => {
    setGuideColorMovieState(DEFAULT_GUIDE_COLOR_MOVIE);
    setGuideColorEpisodeState(DEFAULT_GUIDE_COLOR_EPISODE);
    resetGuideColors();
  };

  const handleGuideRatingsToggle = () => {
    const newValue = !guideRatingsEnabled;
    setGuideRatingsEnabledState(newValue);
    setGuideRatings(newValue);
  };

  const handleGuideYearToggle = () => {
    const newValue = !guideYearEnabled;
    setGuideYearEnabledState(newValue);
    setGuideYear(newValue);
  };

  const handleGuideResolutionToggle = () => {
    const newValue = !guideResolutionEnabled;
    setGuideResolutionEnabledState(newValue);
    setGuideResolution(newValue);
  };

  const handleGuideHdrToggle = () => {
    const newValue = !guideHdrEnabled;
    setGuideHdrEnabledState(newValue);
    setGuideHdr(newValue);
  };

  const handleGuideArtworkToggle = () => {
    const newValue = !guideArtworkEnabled;
    setGuideArtworkEnabledState(newValue);
    setGuideArtwork(newValue);
  };

  const handleGuideTomatoToggle = () => {
    const newValue = !guideTomatoEnabled;
    setGuideTomatoEnabledState(newValue);
    setGuideTomato(newValue);
  };

  const handleClockFormatChange = (format: ClockFormat) => {
    setClockFormatState(format);
    setClockFormat(format);
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


  return (
    <div className="settings-section">
      <h3>DISPLAY</h3>

      {/* ── Playback ─────────────────────────────────────── */}
      <div className="settings-group-heading">PLAYBACK</div>

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


      {/* ── Appearance ───────────────────────────────────── */}
      <div className="settings-group-heading">APPEARANCE</div>

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

      {/* ── Guide ────────────────────────────────────────── */}
      <div className="settings-group-heading">GUIDE</div>

      <div className="settings-subsection">
        <h4>LAYOUT</h4>
        <p className="settings-field-hint">
          Channels visible at once in the guide grid. Fewer channels means larger rows.
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
        <h4>ZOOM</h4>
        <p className="settings-field-hint">
          Hours visible on screen at once. Lower values zoom in for more detail.
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
        <h4>CLOCK FORMAT</h4>
        <p className="settings-field-hint">
          Display times in 12-hour (AM/PM) or 24-hour format.
        </p>
        <div className="settings-channel-count-options">
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
                setPromoOverlayEnabled(e.target.checked);
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
                setStartingSoonEnabled(e.target.checked);
              }}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            Starting soon on other channels
          </span>
        </div>
      </div>

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

    </div>
  );
}
