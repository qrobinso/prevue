import { useRef, useEffect, useState, useCallback } from 'react';
import { useSwipe } from '../../hooks/useSwipe';
import Hls from 'hls.js';
import type { ScheduleProgram } from '../../types';
import type { AudioTrackInfo, SubtitleTrackInfo } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import { getPlaybackInfo, stopPlayback, updateSettings } from '../../services/api';
import { useVolume, useVideoVolume } from '../../hooks/useVolume';
import { formatAudioTrackNameFromServer, formatSubtitleTrackNameFromServer } from './audioTrackUtils';
import './Guide.css';

// Lightweight preset for fast preview start (lower bitrate/size = faster first frame)
const PREVIEW_QUALITY = { bitrate: 1200000, maxWidth: 640 };
/** Delay before starting preview stream (user may be browsing) */
const PREVIEW_STREAM_DELAY_MS = 1000;

const SUBTITLE_INDEX_KEY = 'prevue_subtitle_index';
const VIDEO_FIT_KEY = 'prevue_video_fit';
const OVERLAY_VISIBLE_MS = 5000;
const DOUBLE_TAP_WINDOW_MS = 5000;

function getStoredVideoFit(): 'contain' | 'cover' {
  const stored = localStorage.getItem(VIDEO_FIT_KEY);
  return stored === 'cover' ? 'cover' : 'contain';
}

function getStoredSubtitleIndex(): number | null {
  const stored = localStorage.getItem(SUBTITLE_INDEX_KEY);
  if (stored === '' || stored === null) return null;
  const n = parseInt(stored, 10);
  return Number.isNaN(n) ? null : n;
}

interface PreviewPanelProps {
  channel: ChannelWithProgram | null;
  program: ScheduleProgram | null;
  currentTime: Date;
  streamingPaused?: boolean;
  onTune?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
}

export default function PreviewPanel({ channel, program, currentTime, streamingPaused = false, onTune, onSwipeUp, onSwipeDown }: PreviewPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const currentItemIdRef = useRef<string | null>(null);
  const selectedSubtitleIndexRef = useRef<number | null>(getStoredSubtitleIndex());
  const overlayHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapTimeRef = useRef<number>(0);
  const removePlayingListenersRef = useRef<(() => void) | null>(null);
  /** Tracks item we're loading so we don't start a duplicate load (e.g. React Strict Mode or rapid re-runs) */
  const loadingItemIdRef = useRef<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const { volume, muted, setVolume, toggleMute } = useVolume();
  const [showAudioMoreMenu, setShowAudioMoreMenu] = useState(false);
  const [serverAudioTracks, setServerAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<number | null>(null);
  const [serverSubtitleTracks, setServerSubtitleTracks] = useState<SubtitleTrackInfo[]>([]);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(getStoredSubtitleIndex);
  const [videoFit, setVideoFit] = useState<'contain' | 'cover'>(getStoredVideoFit);

  const toggleVideoFit = useCallback(() => {
    setVideoFit(prev => {
      const next = prev === 'contain' ? 'cover' : 'contain';
      localStorage.setItem(VIDEO_FIT_KEY, next);
      return next;
    });
  }, []);

  // Apply volume to video (using global volume state)
  useVideoVolume(videoRef, volume, muted);

  const cleanup = useCallback(() => {
    if (removePlayingListenersRef.current) {
      removePlayingListenersRef.current();
      removePlayingListenersRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (currentItemIdRef.current) {
      stopPlayback(currentItemIdRef.current).catch(() => {});
      currentItemIdRef.current = null;
    }
    loadingItemIdRef.current = null;
    setVideoReady(false);
    setVideoError(false);
  }, []);

  // Load HLS from playback info (shared by initial load and audio track switch).
  // We set videoReady only when the video fires 'playing', so the static placeholder stays until a real frame is shown.
  const loadStreamWithInfo = useCallback((info: Awaited<ReturnType<typeof getPlaybackInfo>>, cancelled: { current: boolean }) => {
    const video = videoRef.current;
    if (!video || !info.stream_url || info.is_interstitial) return;

    currentItemIdRef.current = info.program.jellyfin_item_id;
    const startPosition = info.seek_position_seconds || 0;

    const removePlayingListeners = () => {
      video.removeEventListener('playing', onFirstPlaying);
      video.removeEventListener('loadeddata', onFirstPlaying);
      if (removePlayingListenersRef.current === removePlayingListeners) {
        removePlayingListenersRef.current = null;
      }
    };

    const onFirstPlaying = () => {
      if (cancelled.current) return;
      removePlayingListeners();
      // Wait 0.5s of actual video playback before revealing (so video plays behind the static briefly)
      setTimeout(() => {
        if (!cancelled.current) {
          setVideoReady(true);
        }
      }, 500);
    };

    if (removePlayingListenersRef.current) {
      removePlayingListenersRef.current();
      removePlayingListenersRef.current = null;
    }
    removePlayingListenersRef.current = removePlayingListeners;

    if (Hls.isSupported()) {
      const hls = new Hls({
        startPosition,
        maxBufferLength: 3,
        maxMaxBufferLength: 8,
        maxBufferSize: 4 * 1000 * 1000,
        fragLoadingMaxRetry: 2,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 2,
      });
      hlsRef.current = hls;
      hls.loadSource(info.stream_url);
      hls.attachMedia(video);
      video.addEventListener('playing', onFirstPlaying);
      video.addEventListener('loadeddata', onFirstPlaying);
      // Helper to set native text track mode
      const setNativeSubtitleMode = (posIdx: number | null) => {
        if (video.textTracks) {
          for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (track.kind === 'subtitles' || track.kind === 'captions') {
              track.mode = (posIdx !== null && i === posIdx) ? 'showing' : 'hidden';
            }
          }
        }
      };
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!cancelled.current) {
          video.play().catch(() => {});
          const idx = selectedSubtitleIndexRef.current;
          if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
            hls.subtitleDisplay = idx !== null && idx >= 0;
            hls.subtitleTrack = idx !== null && idx >= 0 && idx < hls.subtitleTracks.length ? idx : -1;
          }
          setTimeout(() => setNativeSubtitleMode(idx), 100);
        }
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        if (cancelled.current) return;
        const idx = selectedSubtitleIndexRef.current;
        if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
          hls.subtitleDisplay = idx !== null && idx >= 0;
          hls.subtitleTrack = idx !== null && idx >= 0 && idx < hls.subtitleTracks.length ? idx : -1;
        }
        setTimeout(() => setNativeSubtitleMode(idx), 100);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal && !cancelled.current) {
          removePlayingListeners();
          setVideoError(true);
          hls.destroy();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.addEventListener('playing', onFirstPlaying);
      video.addEventListener('loadeddata', onFirstPlaying);
      video.src = info.stream_url;
      video.currentTime = startPosition;
      video.play().catch(() => {});
    }
  }, []);

  // Load preview when channel/program changes (with delay so quick browsing doesn't kick off streams)
  useEffect(() => {
    if (streamingPaused) return;
    if (!channel || !program || program.type === 'interstitial') {
      cleanup();
      setServerAudioTracks([]);
      setSelectedAudioStreamIndex(null);
      setServerSubtitleTracks([]);
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    const itemId = program.jellyfin_item_id;
    if (currentItemIdRef.current === itemId) {
      return; // already playing this item
    }
    if (loadingItemIdRef.current === itemId) {
      return; // load already in progress, avoid duplicate request
    }

    cleanup();
    const cancelled = { current: false };

    const loadPreview = async () => {
      if (cancelled.current) return;
      loadingItemIdRef.current = itemId;
      try {
        const info = await getPlaybackInfo(channel.id, PREVIEW_QUALITY);
        if (cancelled.current || !info.stream_url || info.is_interstitial) {
          if (!cancelled.current) loadingItemIdRef.current = null;
          return;
        }

        setServerAudioTracks(info.audio_tracks ?? []);
        setSelectedAudioStreamIndex(info.audio_stream_index ?? null);
        setServerSubtitleTracks(info.subtitle_tracks ?? []);
        const subtitleTracks = info.subtitle_tracks ?? [];
        const preferredSub =
          info.subtitle_index !== undefined ? info.subtitle_index : getStoredSubtitleIndex();
        const initialSub =
          preferredSub !== null && preferredSub >= 0 && preferredSub < subtitleTracks.length
            ? preferredSub
            : null;
        setSelectedSubtitleIndex(initialSub);
        selectedSubtitleIndexRef.current = initialSub;
        if (info.subtitle_index !== undefined) {
          localStorage.setItem(SUBTITLE_INDEX_KEY, initialSub === null ? '' : String(initialSub));
        }
        loadStreamWithInfo(info, cancelled);
        loadingItemIdRef.current = null;
      } catch (err) {
        if (!cancelled.current) {
          setVideoError(true);
          loadingItemIdRef.current = null;
        }
      }
    };

    const timer = setTimeout(loadPreview, PREVIEW_STREAM_DELAY_MS);
    return () => {
      cancelled.current = true;
      loadingItemIdRef.current = null;
      clearTimeout(timer);
    };
  }, [channel?.id, program?.jellyfin_item_id, cleanup, streamingPaused, loadStreamWithInfo]);

  // Switch audio track: save as preferred language, refetch with audioStreamIndex, reload stream
  const handleSelectServerAudioTrack = useCallback(async (index: number) => {
    if (!channel) return;
    const track = serverAudioTracks.find((t) => t.index === index);
    if (track) {
      updateSettings({ preferred_audio_language: track.language }).catch(() => {});
    }
    setSelectedAudioStreamIndex(index);
    setShowAudioMoreMenu(false);
    cleanup();
    try {
      const info = await getPlaybackInfo(channel.id, { ...PREVIEW_QUALITY, audioStreamIndex: index });
      if (!info.stream_url || info.is_interstitial) return;
      const video = videoRef.current;
      if (!video) return;
      loadStreamWithInfo(info, { current: false });
    } catch {
      setVideoError(true);
    }
  }, [channel, serverAudioTracks, cleanup, loadStreamWithInfo]);

  // Helper to apply subtitle to hls.js and native text tracks
  const applySubtitleTrack = useCallback((positionIndex: number | null) => {
    const hls = hlsRef.current;
    const video = videoRef.current;
    if (hls && hls.subtitleTracks && hls.subtitleTracks.length > 0) {
      hls.subtitleDisplay = positionIndex !== null && positionIndex >= 0;
      hls.subtitleTrack = positionIndex !== null && positionIndex >= 0 && positionIndex < hls.subtitleTracks.length ? positionIndex : -1;
    }
    // Also set native text track mode for browser rendering
    if (video && video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i];
        if (track.kind === 'subtitles' || track.kind === 'captions') {
          track.mode = (positionIndex !== null && i === positionIndex) ? 'showing' : 'hidden';
        }
      }
    }
  }, []);

  const handleSelectSubtitleTrack = useCallback((positionIndex: number | null) => {
    setSelectedSubtitleIndex(positionIndex);
    selectedSubtitleIndexRef.current = positionIndex;
    localStorage.setItem(SUBTITLE_INDEX_KEY, positionIndex === null ? '' : String(positionIndex));
    updateSettings({ preferred_subtitle_index: positionIndex }).catch(() => {});
    applySubtitleTrack(positionIndex);
  }, [applySubtitleTrack]);

  // When channel/program changes: show overlay, then fade out after 5s
  useEffect(() => {
    if (!channel || !program || program.type === 'interstitial') return;
    setOverlayVisible(true);
    lastTapTimeRef.current = Date.now();
    if (overlayHideTimerRef.current) {
      clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = null;
    }
    overlayHideTimerRef.current = setTimeout(() => {
      overlayHideTimerRef.current = null;
      setOverlayVisible(false);
    }, OVERLAY_VISIBLE_MS);
    return () => {
      if (overlayHideTimerRef.current) {
        clearTimeout(overlayHideTimerRef.current);
        overlayHideTimerRef.current = null;
      }
    };
  }, [channel?.id, program?.jellyfin_item_id, program?.type]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (overlayHideTimerRef.current) clearTimeout(overlayHideTimerRef.current);
      cleanup();
    };
  }, [cleanup]);

  // Pause/stop streaming when settings is open
  useEffect(() => {
    if (streamingPaused) {
      cleanup();
    }
  }, [streamingPaused, cleanup]);

  if (!channel) {
    return (
      <div className="preview-panel">
        <div className="preview-logo">
          <div className="preview-logo-text">PREVUE</div>
          <div className="preview-logo-sub">CHANNEL GUIDE</div>
        </div>
      </div>
    );
  }

  const showVideo = program && program.type !== 'interstitial';

  const swipe = useSwipe({ onSwipeUp, onSwipeDown });

  const scheduleOverlayHide = useCallback(() => {
    if (overlayHideTimerRef.current) {
      clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = null;
    }
    overlayHideTimerRef.current = setTimeout(() => {
      overlayHideTimerRef.current = null;
      setOverlayVisible(false);
    }, OVERLAY_VISIBLE_MS);
  }, []);

  const handlePreviewTap = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      if (!channel || !program || program.type === 'interstitial') return;
      if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return;
      if ('target' in e && e.target instanceof Node) {
        const target = e.target as HTMLElement;
        if (target.closest('button') || target.closest('input') || target.closest('.preview-audio-more-menu')) return;
      }
      const now = Date.now();
      if (!overlayVisible) {
        setOverlayVisible(true);
        lastTapTimeRef.current = now;
        scheduleOverlayHide();
        return;
      }
      if (now - lastTapTimeRef.current <= DOUBLE_TAP_WINDOW_MS) {
        onTune?.();
        return;
      }
      lastTapTimeRef.current = now;
      scheduleOverlayHide();
    },
    [channel, program, overlayVisible, onTune, scheduleOverlayHide]
  );

  return (
    <div 
      className={`preview-panel ${onTune ? 'preview-panel-clickable' : ''} ${showAudioMoreMenu ? 'preview-panel-audio-open' : ''}`}
      onClick={handlePreviewTap}
      role={onTune ? 'button' : undefined}
      tabIndex={onTune ? 0 : undefined}
      onKeyDown={onTune ? handlePreviewTap : undefined}
      onTouchStart={swipe.onTouchStart}
      onTouchEnd={swipe.onTouchEnd}
    >
      {/* Video fills entire panel */}
      <div className="preview-video-container">
        {showVideo && (
          <video
            ref={videoRef}
            className={`preview-video ${videoReady ? 'ready' : ''} ${videoFit === 'contain' ? 'preview-video-letterbox' : ''}`}
            playsInline
          />
        )}
        {/* Loading overlay (same as full-screen player): banner in background + TUNING text */}
        {!videoReady && !videoError && program && program.type !== 'interstitial' && (
          <div className="preview-loading" key={program.jellyfin_item_id}>
            {program.banner_url || program.thumbnail_url ? (
              <img
                className="preview-loading-banner"
                src={(program.thumbnail_url || program.banner_url) ?? ''}
                alt=""
                onError={(e) => {
                  const el = e.target as HTMLImageElement;
                  const triedThumb = el.src.includes('/Primary');
                  const fallback = triedThumb ? program?.banner_url : program?.thumbnail_url;
                  if (fallback && el.src !== fallback) {
                    el.src = fallback;
                  } else {
                    el.style.display = 'none';
                  }
                }}
              />
            ) : (
              <div className="preview-loading-banner preview-loading-banner-fallback" />
            )}
            <div className="preview-loading-text">TUNING...</div>
          </div>
        )}
        {/* Error fallback: static thumbnail when stream fails */}
        {videoError && program && (program.banner_url || program.thumbnail_url) && (
          <img
            className="preview-thumbnail-img preview-placeholder-img"
            src={(program.thumbnail_url || program.banner_url) ?? ''}
            alt=""
            onError={(e) => {
              const el = e.target as HTMLImageElement;
              const triedThumb = el.src.includes('/Primary');
              const fallback = triedThumb ? program?.banner_url : program?.thumbnail_url;
              if (fallback && el.src !== fallback) {
                el.src = fallback;
              } else {
                el.style.display = 'none';
              }
            }}
          />
        )}
      </div>
      {/* Info overlay on top of video — fades out after 5s; tap to show, tap again within 5s to tune */}
      <div
        className={`preview-overlay ${overlayVisible ? 'preview-overlay-visible' : 'preview-overlay-hidden'}`}
        aria-hidden={!overlayVisible}
      >
        <div className="preview-info">
          <div className="preview-channel-badge">
            <span className="preview-channel-num">CH {channel.number}</span>
            <span className="preview-channel-name">{channel.name}</span>
          </div>
          {program && (
            <>
              <div className="preview-title">{program.title}</div>
              {program.subtitle && (
                <div className="preview-subtitle">{program.subtitle}</div>
              )}
              <div className="preview-meta">
                {program.year && <span className="preview-year">{program.year}</span>}
                {program.rating && <span className="preview-rating">{program.rating}</span>}
              </div>
              <div className="preview-time">
                {formatTime(program.start_time)} - {formatTime(program.end_time)}
              </div>
              {program.type === 'program' && (
                <div className="preview-progress">
                  <div
                    className="preview-progress-bar"
                    style={{ width: `${getProgress(program, currentTime)}%` }}
                  />
                </div>
              )}
            </>
          )}
        </div>
        <div className="preview-right">
          {/* Combined Audio menu (volume + audio track) */}
          <div
            className={`preview-audio-more-wrap ${showAudioMoreMenu ? 'preview-audio-more-wrap-open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (showAudioMoreMenu && e.target === e.currentTarget) setShowAudioMoreMenu(false);
            }}
          >
            <button
              className={`preview-audio-more-btn ${showAudioMoreMenu ? 'open' : ''}`}
              onClick={(e) => { e.stopPropagation(); setShowAudioMoreMenu(prev => !prev); }}
              title="Audio"
            >
              {muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
            </button>
            {showAudioMoreMenu && (
              <div className="preview-audio-more-menu">
                <div className="preview-audio-more-section">
                  <div className="preview-audio-more-section-title">VOLUME</div>
                  <div className="preview-audio-more-volume-row">
                    <button
                      className={`preview-audio-more-mute ${muted ? 'muted' : ''}`}
                      onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                      title={muted ? 'Unmute' : 'Mute'}
                    >
                      {muted || volume === 0 ? '🔇' : '🔊'}
                    </button>
                    <input
                      type="range"
                      className="preview-audio-more-slider"
                      min="0"
                      max="1"
                      step="0.05"
                      value={muted ? 0 : volume}
                      onChange={(e) => {
                        e.stopPropagation();
                        setVolume(parseFloat(e.target.value));
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ '--volume-fill': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
                    />
                  </div>
                </div>
                {serverAudioTracks.length >= 1 && (
                  <div className="preview-audio-more-section">
                    <div className="preview-audio-more-section-title">AUDIO TRACK</div>
                    {serverAudioTracks.map((track) => (
                      <button
                        key={track.index}
                        className={`preview-audio-more-option ${selectedAudioStreamIndex === track.index || (selectedAudioStreamIndex === null && track.index === serverAudioTracks[0]?.index) ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectServerAudioTrack(track.index);
                        }}
                      >
                        <span className="preview-audio-more-option-label">{formatAudioTrackNameFromServer(track)}</span>
                        <span className="preview-audio-more-option-lang">{(track.language || 'und').toUpperCase()}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="preview-audio-more-section">
                  <div className="preview-audio-more-section-title">SUBTITLES</div>
                  <button
                    className={`preview-audio-more-option ${selectedSubtitleIndex === null ? 'active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectSubtitleTrack(null);
                    }}
                  >
                    <span className="preview-audio-more-option-label">Off</span>
                  </button>
                  {serverSubtitleTracks.length === 0 ? (
                    <div className="preview-audio-more-option preview-audio-more-option-empty">No subtitles available</div>
                  ) : (
                    serverSubtitleTracks.map((track, positionIndex) => (
                      <button
                        key={track.index}
                        className={`preview-audio-more-option ${selectedSubtitleIndex === positionIndex ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectSubtitleTrack(positionIndex);
                        }}
                      >
                        <span className="preview-audio-more-option-label">{formatSubtitleTrackNameFromServer(track)}</span>
                        <span className="preview-audio-more-option-lang">{(track.language || 'und').toUpperCase()}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Letterbox / Fill toggle to the right of audio (same preference as fullscreen player) */}
          <button
            type="button"
            className="preview-fit-btn"
            onClick={(e) => { e.stopPropagation(); toggleVideoFit(); }}
            title={videoFit === 'contain' ? 'Fill (crop to fill)' : 'Letterbox (fit entire video)'}
            aria-label={videoFit === 'contain' ? 'Switch to fill' : 'Switch to letterbox'}
          >
            {videoFit === 'contain' ? '⊡' : '▢'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getProgress(program: ScheduleProgram, now: Date): number {
  const start = new Date(program.start_time).getTime();
  const end = new Date(program.end_time).getTime();
  const current = now.getTime();
  if (current <= start) return 0;
  if (current >= end) return 100;
  return ((current - start) / (end - start)) * 100;
}
