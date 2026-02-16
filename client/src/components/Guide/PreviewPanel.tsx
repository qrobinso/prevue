import { useRef, useEffect, useState, useCallback } from 'react';
import { useSwipe } from '../../hooks/useSwipe';
import Hls from 'hls.js';
import type { ScheduleProgram } from '../../types';
import type { AudioTrackInfo, SubtitleTrackInfo } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import { getPlaybackInfo, stopPlayback, reportPlaybackProgress, updateSettings, metricsStart, metricsStop } from '../../services/api';
import { getClientId } from '../../services/clientIdentity';
import {
  consumePlaybackHandoff,
  requestPlaybackHandoff,
  shouldPreservePlaybackOnUnmount,
  updateActivePlaybackSession,
  updatePlaybackPosition,
} from '../../services/playbackHandoff';
import { useVolume, useVideoVolume } from '../../hooks/useVolume';
import { formatAudioTrackNameFromServer, formatSubtitleTrackNameFromServer } from './audioTrackUtils';
import { formatPlaybackError } from '../../utils/playbackError';
import './Guide.css';

/** Delay before starting preview stream (user may be browsing) */
const PREVIEW_STREAM_DELAY_MS = 1000;

const SUBTITLE_INDEX_KEY = 'prevue_subtitle_index';
const VIDEO_FIT_KEY = 'prevue_video_fit';
const OVERLAY_VISIBLE_MS = 5000;
const DOUBLE_TAP_MS = 300;

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
  guideHours?: number;
}

const PREVIEW_BASE_SIZES = {
  channelNum: 14,
  channelName: 11,
  title: 16,
  subtitle: 13,
  year: 10,
  rating: 9,
  time: 10,
} as const;

export default function PreviewPanel({ channel, program, currentTime, streamingPaused = false, onTune, onSwipeUp, onSwipeDown, guideHours = 4 }: PreviewPanelProps) {
  const zoomFontScale = Math.min(1.4, 4 / guideHours);
  const previewFontSizes = {
    channelNum: Math.round(PREVIEW_BASE_SIZES.channelNum * zoomFontScale),
    channelName: Math.round(PREVIEW_BASE_SIZES.channelName * zoomFontScale),
    title: Math.round(PREVIEW_BASE_SIZES.title * zoomFontScale),
    subtitle: Math.round(PREVIEW_BASE_SIZES.subtitle * zoomFontScale),
    year: Math.round(PREVIEW_BASE_SIZES.year * zoomFontScale),
    rating: Math.round(PREVIEW_BASE_SIZES.rating * zoomFontScale),
    time: Math.round(PREVIEW_BASE_SIZES.time * zoomFontScale),
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const currentItemIdRef = useRef<string | null>(null);
  const currentChannelIdRef = useRef<number | null>(null);
  const selectedSubtitleIndexRef = useRef<number | null>(getStoredSubtitleIndex());
  const overlayHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapTimeRef = useRef<number>(0);
  const removePlayingListenersRef = useRef<(() => void) | null>(null);
  /** Tracks item we're loading so we don't start a duplicate load (e.g. React Strict Mode or rapid re-runs) */
  const loadingItemIdRef = useRef<string | null>(null);
  // ─── Playback progress tracking ──────────────────────
  const watchStartRef = useRef<number>(0);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressActivatedRef = useRef(false);

  const [videoReady, setVideoReady] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferingMessage, setBufferingMessage] = useState('BUFFERING...');
  const [overlayVisible, setOverlayVisible] = useState(true);
  const { volume, muted, setVolume, toggleMute } = useVolume();
  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  mutedRef.current = muted;
  volumeRef.current = volume;
  const [showAudioMoreMenu, setShowAudioMoreMenu] = useState(false);
  const [serverAudioTracks, setServerAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<number | null>(null);
  const [serverSubtitleTracks, setServerSubtitleTracks] = useState<SubtitleTrackInfo[]>([]);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(getStoredSubtitleIndex);
  const [videoFit, setVideoFit] = useState<'contain' | 'cover'>(getStoredVideoFit);
  currentChannelIdRef.current = channel?.id ?? null;

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
    // Release browser media buffers so memory is freed immediately
    const vid = videoRef.current;
    if (vid) {
      vid.removeAttribute('src');
      vid.load();
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    if (currentItemIdRef.current) {
      const itemId = currentItemIdRef.current;
      const channelId = currentChannelIdRef.current;
      const positionMs = videoRef.current ? Math.round(videoRef.current.currentTime * 1000) : undefined;
      if (channelId != null && shouldPreservePlaybackOnUnmount('guide', channelId, itemId)) {
        updatePlaybackPosition('guide', itemId, (positionMs ?? 0) / 1000);
      } else {
        stopPlayback(itemId, undefined, positionMs).catch(() => {});
        metricsStop(getClientId()).catch(() => {});
      }
      currentItemIdRef.current = null;
    }
    loadingItemIdRef.current = null;
    progressActivatedRef.current = false;
    setVideoReady(false);
    setVideoError(null);
    setIsBuffering(false);
    setBufferingMessage('BUFFERING...');
  }, []);

  // Load HLS from playback info (shared by initial load and audio track switch).
  // We set videoReady only when the video fires 'playing', so the static placeholder stays until a real frame is shown.
  const loadStreamWithInfo = useCallback((
    info: Awaited<ReturnType<typeof getPlaybackInfo>>,
    cancelled: { current: boolean },
    startPositionOverrideSec?: number
  ) => {
    const video = videoRef.current;
    if (!video || !info.stream_url || info.is_interstitial) return;

    currentItemIdRef.current = info.program.jellyfin_item_id;
    const startPosition = startPositionOverrideSec ?? (info.seek_position_seconds || 0);
    updateActivePlaybackSession('guide', currentChannelIdRef.current ?? info.channel.id, info, startPosition);

    // Report metrics for this preview playback
    const isEpisode = info.program.content_type === 'episode';
    metricsStart({
      client_id: getClientId(),
      channel_id: currentChannelIdRef.current ?? info.channel.id,
      channel_name: info.channel.name,
      item_id: info.program.jellyfin_item_id,
      title: isEpisode ? (info.program.subtitle || info.program.title) : info.program.title,
      series_name: isEpisode ? info.program.title : undefined,
      content_type: info.program.content_type ?? undefined,
    }).catch(() => {});

    // Reset playback progress tracking for the new item
    watchStartRef.current = Date.now();
    progressActivatedRef.current = false;

    let canplayHandler: (() => void) | null = null;
    const removePlayingListeners = () => {
      video.removeEventListener('playing', onFirstPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onWaiting);
      if (canplayHandler) {
        video.removeEventListener('canplay', canplayHandler);
        canplayHandler = null;
      }
      if (removePlayingListenersRef.current === removePlayingListeners) {
        removePlayingListenersRef.current = null;
      }
    };

    const onFirstPlaying = () => {
      if (cancelled.current) return;
      removePlayingListeners();
      setIsBuffering(false);
      // Restore user's volume/muted (we start muted for iOS autoplay compat)
      video.muted = mutedRef.current;
      video.volume = volumeRef.current;
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
    const onWaiting = () => {
      setBufferingMessage('Connection interrupted. Buffering...');
      setIsBuffering(true);
    };

    if (Hls.isSupported()) {
      const hls = new Hls({
        startPosition,
        maxBufferLength: 10,
        maxMaxBufferLength: 20,
        maxBufferSize: 10 * 1000 * 1000,
        fragLoadingMaxRetry: 4,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;
      hls.loadSource(info.stream_url);
      hls.attachMedia(video);
      // Only use 'playing' — 'loadeddata' can fire before frames render,
      // causing the overlay to fade over a black/frozen video.
      video.addEventListener('playing', onFirstPlaying);
      video.addEventListener('waiting', onWaiting);
      video.addEventListener('stalled', onWaiting);
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
          video.muted = true; // iOS: autoplay requires muted
          video.play().catch(() => {});
          setIsBuffering(false);
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
          setIsBuffering(false);
          setVideoError(formatPlaybackError(data));
          hls.destroy();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.addEventListener('playing', onFirstPlaying);
      video.addEventListener('waiting', onWaiting);
      video.addEventListener('stalled', onWaiting);
      canplayHandler = () => {
        if (cancelled.current) return;
        if (canplayHandler) {
          video.removeEventListener('canplay', canplayHandler);
          canplayHandler = null;
        }
        if (startPosition > 0) video.currentTime = startPosition;
        video.muted = true; // iOS: autoplay requires muted
        setIsBuffering(false);
        video.play().catch(() => {});
      };
      video.src = info.stream_url;
      video.addEventListener('canplay', canplayHandler);
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
        const handoff = consumePlaybackHandoff('guide', channel.id, itemId);
        if (handoff) {
          setServerAudioTracks(handoff.info.audio_tracks ?? []);
          setSelectedAudioStreamIndex(handoff.info.audio_stream_index ?? null);
          setServerSubtitleTracks(handoff.info.subtitle_tracks ?? []);
          const subtitleTracks = handoff.info.subtitle_tracks ?? [];
          const preferredSub =
            handoff.info.subtitle_index !== undefined ? handoff.info.subtitle_index : getStoredSubtitleIndex();
          const initialSub =
            preferredSub !== null && preferredSub >= 0 && preferredSub < subtitleTracks.length
              ? preferredSub
              : null;
          setSelectedSubtitleIndex(initialSub);
          selectedSubtitleIndexRef.current = initialSub;
          loadStreamWithInfo(handoff.info, cancelled, handoff.positionSec);
          loadingItemIdRef.current = null;
          return;
        }

        const info = await getPlaybackInfo(channel.id);
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
          setVideoError(formatPlaybackError(err instanceof Error ? err : String(err)));
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

  // Playback progress reporting to Jellyfin (after 5 min watch threshold)
  useEffect(() => {
    const WATCH_THRESHOLD_MS = 5 * 60 * 1000;  // 5 minutes
    const REPORT_INTERVAL_MS = 30 * 1000;       // every 30 seconds

    progressIntervalRef.current = setInterval(() => {
      const video = videoRef.current;
      const itemId = currentItemIdRef.current;
      if (!video || !itemId || video.paused) return;

      const watchedMs = Date.now() - watchStartRef.current;
      if (watchedMs >= WATCH_THRESHOLD_MS) {
        if (!progressActivatedRef.current) {
          progressActivatedRef.current = true;
          console.log(`[Preview] 5-min watch threshold reached for ${itemId}, starting progress reports`);
        }
        const positionMs = Math.round(video.currentTime * 1000);
        updatePlaybackPosition('guide', itemId, positionMs / 1000);
        reportPlaybackProgress(itemId, positionMs).catch(() => {});
      }
    }, REPORT_INTERVAL_MS);

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, []);

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
      const info = await getPlaybackInfo(channel.id, { audioStreamIndex: index });
      if (!info.stream_url || info.is_interstitial) return;
      const video = videoRef.current;
      if (!video) return;
      loadStreamWithInfo(info, { current: false });
    } catch (err) {
      setVideoError(formatPlaybackError(err instanceof Error ? err : 'Audio track switch failed'));
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

  const handleSelectSubtitleTrack = useCallback(async (positionIndex: number | null) => {
    if (!channel) return;
    setSelectedSubtitleIndex(positionIndex);
    selectedSubtitleIndexRef.current = positionIndex;
    localStorage.setItem(SUBTITLE_INDEX_KEY, positionIndex === null ? '' : String(positionIndex));
    setShowAudioMoreMenu(false);
    cleanup();
    try {
      await updateSettings({ preferred_subtitle_index: positionIndex });
      const info = await getPlaybackInfo(channel.id);
      if (!info.stream_url || info.is_interstitial) return;
      setServerSubtitleTracks(info.subtitle_tracks ?? []);
      loadStreamWithInfo(info, { current: false });
    } catch (err) {
      setVideoError(formatPlaybackError(err instanceof Error ? err : 'Subtitle switch failed'));
    }
  }, [channel, cleanup, loadStreamWithInfo]);

  // When channel/program changes: show overlay, then fade out after 5s
  useEffect(() => {
    if (!channel || !program || program.type === 'interstitial') return;
    setOverlayVisible(true);
    lastTapTimeRef.current = 0; // Reset so first tap after channel change isn't mistaken for double-tap
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
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
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
  const artworkSources = program ? getPreviewArtworkSources(program) : [];

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

  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePreviewTap = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      if (!channel || !program || program.type === 'interstitial') return;
      if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return;
      if ('target' in e && e.target instanceof Node) {
        const target = e.target as HTMLElement;
        if (target.closest('button') || target.closest('input') || target.closest('.preview-audio-more-menu')) return;
      }

      const now = Date.now();

      // Double-tap: open the player
      if (now - lastTapTimeRef.current <= DOUBLE_TAP_MS) {
        // Cancel pending single-tap action
        if (singleTapTimerRef.current) {
          clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        lastTapTimeRef.current = 0;
        const itemId = currentItemIdRef.current;
        if (itemId) {
          requestPlaybackHandoff(
            'guide',
            'player',
            channel.id,
            itemId,
            videoRef.current?.currentTime ?? 0
          );
        }
        onTune?.();
        return;
      }

      // First tap: defer the single-tap action to distinguish from double-tap
      lastTapTimeRef.current = now;
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }
      singleTapTimerRef.current = setTimeout(() => {
        singleTapTimerRef.current = null;
        // Single tap: toggle overlay visibility
        if (overlayVisible) {
          if (overlayHideTimerRef.current) {
            clearTimeout(overlayHideTimerRef.current);
            overlayHideTimerRef.current = null;
          }
          setOverlayVisible(false);
        } else {
          setOverlayVisible(true);
          scheduleOverlayHide();
        }
      }, DOUBLE_TAP_MS);
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
            {artworkSources.length > 0 ? (
              <img
                className="preview-loading-banner"
                src={artworkSources[0] ?? ''}
                data-fallback-index="0"
                alt=""
                onError={(e) => {
                  applyArtworkFallback(e.currentTarget, artworkSources);
                }}
              />
            ) : (
              <div className="preview-loading-banner preview-loading-banner-fallback" />
            )}
            <div className="preview-loading-text">TUNING...</div>
          </div>
        )}
        {/* Buffering overlay for transient connection interruptions */}
        {videoReady && isBuffering && !videoError && program && (
          <div className="preview-loading preview-error-overlay">
            {artworkSources.length > 0 ? (
              <img
                className="preview-loading-banner"
                src={artworkSources[0] ?? ''}
                data-fallback-index="0"
                alt=""
                onError={(e) => {
                  applyArtworkFallback(e.currentTarget, artworkSources);
                }}
              />
            ) : (
              <div className="preview-loading-banner preview-loading-banner-fallback" />
            )}
            <div className="preview-error-text-wrap">
              <span className="preview-error-title preview-buffering-title">BUFFERING</span>
              <span className="preview-error-detail">{bufferingMessage}</span>
            </div>
          </div>
        )}
        {/* Error overlay (same style as TUNING) */}
        {videoError && program && (
          <div className="preview-loading preview-error-overlay">
            {artworkSources.length > 0 ? (
              <img
                className="preview-loading-banner"
                src={artworkSources[0] ?? ''}
                data-fallback-index="0"
                alt=""
                onError={(e) => {
                  applyArtworkFallback(e.currentTarget, artworkSources);
                }}
              />
            ) : (
              <div className="preview-loading-banner preview-loading-banner-fallback" />
            )}
            <div className="preview-error-text-wrap">
              <span className="preview-error-title">ERROR</span>
              <span className="preview-error-detail">{videoError}</span>
            </div>
          </div>
        )}
      </div>
      {/* Info overlay on top of video — fades out after 5s; tap to show, tap again within 5s to tune */}
      <div
        className={`preview-overlay ${overlayVisible ? 'preview-overlay-visible' : 'preview-overlay-hidden'}`}
        aria-hidden={!overlayVisible}
      >
        <div className="preview-info">
          <div className="preview-channel-badge">
            <span className="preview-channel-num" style={{ fontSize: previewFontSizes.channelNum }}>CH {channel.number}</span>
            <span className="preview-channel-name" style={{ fontSize: previewFontSizes.channelName }}>{channel.name}</span>
          </div>
          {program && (
            <>
              <div className="preview-title" style={{ fontSize: previewFontSizes.title }}>{program.title}</div>
              {program.subtitle && (
                <div className="preview-subtitle" style={{ fontSize: previewFontSizes.subtitle }}>{program.subtitle}</div>
              )}
              <div className="preview-meta">
                {program.year && <span className="preview-year" style={{ fontSize: previewFontSizes.year }}>{program.year}</span>}
                {program.rating && <span className="preview-rating" style={{ fontSize: previewFontSizes.rating }}>{program.rating}</span>}
                {program.duration_ms > 0 && <span className="preview-runtime" style={{ fontSize: previewFontSizes.year }}>{formatRuntime(program.duration_ms)}</span>}
              </div>
              <div className="preview-time" style={{ fontSize: previewFontSizes.time }}>
                {formatTime(program.start_time)} - {formatTime(program.end_time)}
              </div>
              {program.description && (
                <div className="preview-description" style={{ fontSize: previewFontSizes.year }}>{program.description}</div>
              )}
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

function formatRuntime(durationMs: number): string {
  const totalMinutes = Math.round(durationMs / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function getProgress(program: ScheduleProgram, now: Date): number {
  const start = new Date(program.start_time).getTime();
  const end = new Date(program.end_time).getTime();
  const current = now.getTime();
  if (current <= start) return 0;
  if (current >= end) return 100;
  return ((current - start) / (end - start)) * 100;
}

function getPreviewArtworkSources(program: ScheduleProgram): string[] {
  const candidates = [
    program.backdrop_url,
    program.guide_url || (program.jellyfin_item_id ? `/api/images/${program.jellyfin_item_id}/Guide` : null),
    program.thumbnail_url,
    program.banner_url,
  ];
  return candidates.filter((value): value is string => Boolean(value));
}

function applyArtworkFallback(img: HTMLImageElement, sources: string[]): void {
  const currentIndex = Number.parseInt(img.dataset.fallbackIndex ?? '0', 10);
  const nextIndex = Number.isFinite(currentIndex) ? currentIndex + 1 : 1;
  if (nextIndex < sources.length) {
    img.dataset.fallbackIndex = String(nextIndex);
    img.src = sources[nextIndex] ?? '';
    return;
  }
  img.style.display = 'none';
}
