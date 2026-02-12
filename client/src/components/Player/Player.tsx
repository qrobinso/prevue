import { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { getPlaybackInfo, stopPlayback } from '../../services/api';
import { useKeyboard } from '../../hooks/useKeyboard';
import { getVideoQuality, setVideoQuality, QUALITY_PRESETS, type QualityPreset } from '../Settings/DisplaySettings';
import InfoOverlay from './InfoOverlay';
import NextUpCard from './NextUpCard';
import type { Channel, ScheduleProgram, SubtitleTrack } from '../../types';
import './Player.css';

interface PlayerProps {
  channel: Channel;
  program: ScheduleProgram | null;
  onBack: () => void;
}

const MAX_RETRIES = 2;
const DOUBLE_TAP_DELAY = 300; // ms to detect double tap

// Local storage keys for player preferences
const SUBTITLES_KEY = 'prevue_subtitles_enabled';
const SUBTITLE_TRACK_KEY = 'prevue_subtitle_track'; // Stores preferred language
const VIDEO_FIT_KEY = 'prevue_video_fit';

function getSubtitlesEnabled(): boolean {
  const stored = localStorage.getItem(SUBTITLES_KEY);
  return stored === 'true';
}

function setSubtitlesEnabled(enabled: boolean): void {
  localStorage.setItem(SUBTITLES_KEY, String(enabled));
}

function getPreferredSubtitleLanguage(): string | null {
  return localStorage.getItem(SUBTITLE_TRACK_KEY);
}

function setPreferredSubtitleLanguage(language: string): void {
  localStorage.setItem(SUBTITLE_TRACK_KEY, language);
}

function getVideoFit(): 'contain' | 'cover' {
  const stored = localStorage.getItem(VIDEO_FIT_KEY);
  return stored === 'cover' ? 'cover' : 'contain';
}

function setVideoFitSetting(fit: 'contain' | 'cover'): void {
  localStorage.setItem(VIDEO_FIT_KEY, fit);
}

export default function Player({ channel, program, onBack }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [currentProgram, setCurrentProgram] = useState<ScheduleProgram | null>(program);
  const [nextProgram, setNextProgram] = useState<ScheduleProgram | null>(null);
  const [isInterstitial, setIsInterstitial] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [currentQuality, setCurrentQuality] = useState<QualityPreset>(getVideoQuality);
  const [subtitlesEnabled, setSubtitlesEnabledState] = useState(getSubtitlesEnabled);
  const [videoFit, setVideoFit] = useState<'contain' | 'cover'>(getVideoFit);
  const [availableSubtitles, setAvailableSubtitles] = useState<SubtitleTrack[]>([]);
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState<number | null>(null);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const overlayTimer = useRef<ReturnType<typeof setTimeout>>();
  const checkTimer = useRef<ReturnType<typeof setInterval>>();
  const errorCountRef = useRef(0);
  const currentItemIdRef = useRef<string | null>(null);
  const lastTapTimeRef = useRef(0);

  // Show overlay briefly on tune-in
  const showOverlayBriefly = useCallback(() => {
    setShowOverlay(true);
    if (overlayTimer.current) clearTimeout(overlayTimer.current);
    overlayTimer.current = setTimeout(() => setShowOverlay(false), 5000);
  }, []);

  // Load and start playback
  const loadPlayback = useCallback(async (quality?: QualityPreset) => {
    try {
      setLoading(true);
      setError(null);
      
      // Use passed quality or get current setting
      const qualityToUse = quality || currentQuality;

      const info = await getPlaybackInfo(channel.id, {
        bitrate: qualityToUse.bitrate,
        maxWidth: qualityToUse.maxWidth,
      });
      setCurrentProgram(info.program);
      setNextProgram(info.next_program);
      setIsInterstitial(info.is_interstitial);
      
      // Track current item for cleanup
      currentItemIdRef.current = info.program?.jellyfin_item_id || null;

      // Store available subtitles from server
      const subtitles = info.subtitles || [];
      setAvailableSubtitles(subtitles);
      
      // Select default subtitle track based on user preference or defaults
      if (subtitles.length > 0 && subtitlesEnabled) {
        const preferredLang = getPreferredSubtitleLanguage();
        // Find preferred language, or default track, or forced track, or first track
        const preferredTrack = preferredLang 
          ? subtitles.find((s: SubtitleTrack) => s.language.toLowerCase() === preferredLang.toLowerCase())
          : null;
        const defaultTrack = subtitles.find((s: SubtitleTrack) => s.isDefault);
        const forcedTrack = subtitles.find((s: SubtitleTrack) => s.isForced);
        const selectedTrack = preferredTrack || defaultTrack || forcedTrack || subtitles[0];
        setActiveSubtitleIndex(selectedTrack.index);
        console.log(`[Player] Selected subtitle track: ${selectedTrack.displayTitle} (index ${selectedTrack.index})`);
      } else {
        setActiveSubtitleIndex(null);
      }

      if (info.is_interstitial || !info.stream_url) {
        setLoading(false);
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      // Destroy previous HLS instance
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      if (Hls.isSupported()) {
        // Reset error count on new playback attempt
        errorCountRef.current = 0;
        
        // Use seek_position_seconds to start playback at the correct time
        // This is calculated server-side based on how far into the program we are
        const startPosition = info.seek_position_seconds || 0;
        console.log(`[Player] Starting at position: ${startPosition.toFixed(1)}s (${(startPosition / 60).toFixed(1)} min)`);
        
        const hls = new Hls({
          startPosition: startPosition,  // Start at the scheduled position
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          // Limit retries to avoid hammering the server
          fragLoadingMaxRetry: 2,
          manifestLoadingMaxRetry: 2,
          levelLoadingMaxRetry: 2,
          fragLoadingRetryDelay: 2000,
          manifestLoadingRetryDelay: 2000,
          levelLoadingRetryDelay: 2000,
        });

        hlsRef.current = hls;
        hls.loadSource(info.stream_url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          errorCountRef.current = 0; // Reset on success
          video.play().catch(() => {});
          setLoading(false);
          showOverlayBriefly();
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            errorCountRef.current++;
            
            if (errorCountRef.current >= MAX_RETRIES) {
              // Stop retrying after max attempts
              setError('Playback failed. The server may be busy - please try again later.');
              setLoading(false);
              hls.destroy();
              hlsRef.current = null;
              return;
            }
            
            setError(`Playback error. Retry ${errorCountRef.current}/${MAX_RETRIES}...`);
            
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              // Wait before retrying to give server time to recover
              setTimeout(() => hls.startLoad(), 2000);
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            } else {
              // Other fatal errors - stop trying
              setError('Playback failed. Please try again later.');
              setLoading(false);
              hls.destroy();
              hlsRef.current = null;
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS (Safari)
        const startPosition = info.seek_position_seconds || 0;
        video.src = info.stream_url;
        video.addEventListener('loadedmetadata', () => {
          // Seek to scheduled position
          if (startPosition > 0) {
            video.currentTime = startPosition;
          }
          video.play().catch(() => {});
          setLoading(false);
          showOverlayBriefly();
        });
      } else {
        setError('HLS playback not supported in this browser');
        setLoading(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }, [channel.id, currentQuality, showOverlayBriefly]);

  // Initial load
  useEffect(() => {
    loadPlayback();
    
    // Handle page close/navigate away - use sendBeacon for reliability
    const handleBeforeUnload = () => {
      if (currentItemIdRef.current) {
        // Use sendBeacon for reliable delivery even during page unload
        const data = JSON.stringify({ itemId: currentItemIdRef.current });
        navigator.sendBeacon('/api/stream/stop', new Blob([data], { type: 'application/json' }));
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      
      // Cleanup: destroy HLS instance and stop server-side transcoding
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (overlayTimer.current) clearTimeout(overlayTimer.current);
      if (checkTimer.current) clearInterval(checkTimer.current);
      
      // Tell server to stop transcoding (saves resources)
      if (currentItemIdRef.current) {
        stopPlayback(currentItemIdRef.current).catch(() => {
          // Ignore errors - this is best-effort cleanup
        });
      }
    };
  }, [loadPlayback]);

  // Progress tracking and auto-advance
  useEffect(() => {
    checkTimer.current = setInterval(async () => {
      if (currentProgram) {
        const now = Date.now();
        const start = new Date(currentProgram.start_time).getTime();
        const end = new Date(currentProgram.end_time).getTime();
        const prog = Math.min(100, ((now - start) / (end - start)) * 100);
        setProgress(prog);

        // Auto-advance when program ends
        if (now >= end) {
          loadPlayback();
        }
      }
    }, 1000);

    return () => {
      if (checkTimer.current) clearInterval(checkTimer.current);
    };
  }, [currentProgram, loadPlayback]);

  // Keyboard controls
  useKeyboard('player', {
    onEscape: onBack,
    onEnter: showOverlayBriefly,
  });

  // Toggle video fit between letterbox (contain) and fill (cover)
  const toggleVideoFit = useCallback(() => {
    setVideoFit(prev => {
      const newFit = prev === 'contain' ? 'cover' : 'contain';
      setVideoFitSetting(newFit);
      return newFit;
    });
  }, []);

  // Click/tap handler with double-tap detection
  const handleClick = useCallback(() => {
    const now = Date.now();
    const timeSinceLastTap = now - lastTapTimeRef.current;
    
    if (timeSinceLastTap < DOUBLE_TAP_DELAY) {
      // Double tap detected - toggle video fit
      toggleVideoFit();
      lastTapTimeRef.current = 0; // Reset to prevent triple tap
    } else {
      // Single tap - show overlay or close menus
      if (showQualityMenu || showSubtitleMenu) {
        setShowQualityMenu(false);
        setShowSubtitleMenu(false);
      } else {
        showOverlayBriefly();
      }
      lastTapTimeRef.current = now;
    }
  }, [showOverlayBriefly, showQualityMenu, showSubtitleMenu, toggleVideoFit]);

  // Toggle subtitles on/off or show menu if multiple tracks
  const toggleSubtitles = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    
    // If multiple subtitle tracks, show selection menu
    if (availableSubtitles.length > 1) {
      setShowSubtitleMenu(prev => !prev);
      setShowQualityMenu(false); // Close quality menu if open
      showOverlayBriefly();
      return;
    }
    
    // Single track or no tracks - just toggle on/off
    setSubtitlesEnabledState(prev => {
      const newValue = !prev;
      setSubtitlesEnabled(newValue);
      
      // If turning on and we have subtitles, select the first one
      if (newValue && availableSubtitles.length > 0 && activeSubtitleIndex === null) {
        setActiveSubtitleIndex(availableSubtitles[0].index);
      } else if (!newValue) {
        setActiveSubtitleIndex(null);
      }
      
      return newValue;
    });
    showOverlayBriefly();
  }, [showOverlayBriefly, availableSubtitles, activeSubtitleIndex]);

  // Select a specific subtitle track
  const selectSubtitleTrack = useCallback((track: SubtitleTrack | null) => {
    if (track === null) {
      // Turn off subtitles
      setSubtitlesEnabledState(false);
      setSubtitlesEnabled(false);
      setActiveSubtitleIndex(null);
    } else {
      // Select this track
      setSubtitlesEnabledState(true);
      setSubtitlesEnabled(true);
      setActiveSubtitleIndex(track.index);
      setPreferredSubtitleLanguage(track.language);
    }
    setShowSubtitleMenu(false);
    showOverlayBriefly();
  }, [showOverlayBriefly]);

  // Apply subtitle track selection when video loads or track changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const applySubtitleTrack = () => {
      // Hide all tracks first, then show the selected one
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i];
        // Match by the data-index attribute we set, or by position
        const trackIndex = parseInt(track.label.split('|')[0] || '-1', 10);
        if (subtitlesEnabled && activeSubtitleIndex !== null && trackIndex === activeSubtitleIndex) {
          track.mode = 'showing';
        } else {
          track.mode = 'hidden';
        }
      }
    };

    // Apply immediately
    applySubtitleTrack();

    // Also apply when text tracks are added
    video.textTracks.addEventListener('addtrack', applySubtitleTrack);
    video.textTracks.addEventListener('change', applySubtitleTrack);
    return () => {
      video.textTracks.removeEventListener('addtrack', applySubtitleTrack);
      video.textTracks.removeEventListener('change', applySubtitleTrack);
    };
  }, [subtitlesEnabled, activeSubtitleIndex]);

  // Handle quality change
  const handleQualityChange = useCallback(async (preset: QualityPreset) => {
    setCurrentQuality(preset);
    setVideoQuality(preset.id);
    setShowQualityMenu(false);
    
    // Stop current playback and restart with new quality
    if (currentItemIdRef.current) {
      await stopPlayback(currentItemIdRef.current).catch(() => {});
    }
    
    // Reload with new quality
    loadPlayback(preset);
  }, [loadPlayback]);

  // Toggle quality menu
  const toggleQualityMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowQualityMenu(prev => !prev);
    setShowSubtitleMenu(false); // Close subtitle menu if open
    showOverlayBriefly();
  }, [showOverlayBriefly]);

  return (
    <div className="player" onClick={handleClick}>
      {/* Video element */}
      {!isInterstitial && (
        <video
          ref={videoRef}
          className={`player-video ${videoFit === 'cover' ? 'player-video-fill' : ''}`}
          playsInline
          autoPlay
          crossOrigin="anonymous"
        >
          {/* Subtitle tracks from server */}
          {availableSubtitles.map((sub) => (
            <track
              key={sub.index}
              kind="subtitles"
              src={sub.url}
              srcLang={sub.language}
              label={`${sub.index}|${sub.displayTitle}`}
              default={subtitlesEnabled && activeSubtitleIndex === sub.index}
            />
          ))}
        </video>
      )}

      {/* Interstitial "Next Up" card */}
      {isInterstitial && currentProgram && (
        <NextUpCard
          program={currentProgram}
          nextProgram={nextProgram}
        />
      )}

      {/* Loading spinner */}
      {loading && (
        <div className="player-loading">
          <div className="player-loading-text">TUNING...</div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="player-error">
          <div className="player-error-text">{error}</div>
        </div>
      )}

      {/* Info overlay */}
      {showOverlay && currentProgram && (
        <InfoOverlay
          channel={channel}
          program={currentProgram}
          nextProgram={nextProgram}
          progress={progress}
        />
      )}

      {/* Non-interactive progress bar */}
      {!isInterstitial && currentProgram && (
        <div className="player-progress">
          <div className="player-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      )}

      {/* Back button - visible on hover or when overlay is showing */}
      <button 
        className={`player-back-btn ${showOverlay || showQualityMenu || showSubtitleMenu ? 'visible' : ''}`} 
        onClick={(e) => { e.stopPropagation(); onBack(); }}
      >
        ← GUIDE
      </button>

      {/* Control buttons container (right side) */}
      {!isInterstitial && (
        <div className={`player-controls-right ${showOverlay || showQualityMenu || showSubtitleMenu ? 'visible' : ''}`}>
          {/* Subtitles button - only show if subtitles are available */}
          {availableSubtitles.length > 0 && (
            <button 
              className={`player-control-btn player-subtitles-btn ${subtitlesEnabled ? 'active' : ''}`}
              onClick={toggleSubtitles}
              title={subtitlesEnabled ? 'Subtitles On' : 'Subtitles Off'}
            >
              <span className="player-btn-icon">CC</span>
              {availableSubtitles.length > 1 && (
                <span className="player-btn-badge">{availableSubtitles.length}</span>
              )}
            </button>
          )}

          {/* Video fit button */}
          <button 
            className={`player-control-btn player-fit-btn ${videoFit === 'cover' ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleVideoFit(); showOverlayBriefly(); }}
            title={videoFit === 'contain' ? 'Letterbox' : 'Fill Screen'}
          >
            <span className="player-btn-icon">{videoFit === 'contain' ? '⊡' : '⊞'}</span>
          </button>

          {/* Quality button */}
          <button 
            className="player-control-btn player-quality-btn"
            onClick={toggleQualityMenu}
          >
            {currentQuality.label}
          </button>
        </div>
      )}

      {/* Quality selection menu */}
      {showQualityMenu && (
        <div className="player-quality-menu" onClick={(e) => e.stopPropagation()}>
          <div className="player-quality-menu-title">VIDEO QUALITY</div>
          {QUALITY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={`player-quality-option ${currentQuality.id === preset.id ? 'active' : ''}`}
              onClick={() => handleQualityChange(preset)}
            >
              <span className="player-quality-option-label">{preset.label}</span>
              <span className="player-quality-option-desc">{preset.description}</span>
            </button>
          ))}
        </div>
      )}

      {/* Subtitle selection menu */}
      {showSubtitleMenu && (
        <div className="player-subtitle-menu" onClick={(e) => e.stopPropagation()}>
          <div className="player-subtitle-menu-title">SUBTITLES</div>
          <button
            className={`player-subtitle-option ${!subtitlesEnabled ? 'active' : ''}`}
            onClick={() => selectSubtitleTrack(null)}
          >
            <span className="player-subtitle-option-label">Off</span>
          </button>
          {availableSubtitles.map((sub) => (
            <button
              key={sub.index}
              className={`player-subtitle-option ${subtitlesEnabled && activeSubtitleIndex === sub.index ? 'active' : ''}`}
              onClick={() => selectSubtitleTrack(sub)}
            >
              <span className="player-subtitle-option-label">{sub.displayTitle}</span>
              {sub.isDefault && <span className="player-subtitle-option-badge">Default</span>}
              {sub.isForced && <span className="player-subtitle-option-badge">Forced</span>}
            </button>
          ))}
        </div>
      )}

      {/* Double-tap hint (shown briefly on first use) */}
      {showOverlay && (
        <div className="player-hint">Double-tap to toggle fill mode</div>
      )}
    </div>
  );
}
