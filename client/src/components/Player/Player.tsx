import { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { getPlaybackInfo, stopPlayback, reportPlaybackProgress, updateSettings } from '../../services/api';
import { useKeyboard } from '../../hooks/useKeyboard';
import { useSwipe } from '../../hooks/useSwipe';
import { useVolume, useVideoVolume } from '../../hooks/useVolume';
import {
  consumePlaybackHandoff,
  requestPlaybackHandoff,
  shouldPreservePlaybackOnUnmount,
  updateActivePlaybackSession,
  updatePlaybackPosition,
} from '../../services/playbackHandoff';
import { getVideoQuality, setVideoQuality, QUALITY_PRESETS, type QualityPreset } from '../Settings/DisplaySettings';
import InfoOverlay from './InfoOverlay';
import NextUpCard from './NextUpCard';
import type { Channel, ScheduleProgram } from '../../types';
import type { AudioTrackInfo, SubtitleTrackInfo } from '../../types';
import { formatAudioTrackNameFromServer, formatSubtitleTrackNameFromServer } from '../Guide/audioTrackUtils';
import { formatPlaybackError } from '../../utils/playbackError';
import './Player.css';

interface PlayerProps {
  channel: Channel;
  program: ScheduleProgram | null;
  onBack: () => void;
  onChannelUp?: () => void;
  onChannelDown?: () => void;
  enterFullscreenOnMount?: boolean;
}

const MAX_RETRIES = 2;
const DOUBLE_TAP_DELAY = 300; // ms to detect double tap

// Local storage keys for player preferences
const SUBTITLE_INDEX_KEY = 'prevue_subtitle_index';
const VIDEO_FIT_KEY = 'prevue_video_fit';

function getStoredSubtitleIndex(): number | null {
  const stored = localStorage.getItem(SUBTITLE_INDEX_KEY);
  if (stored === '' || stored === null) return null;
  const n = parseInt(stored, 10);
  return Number.isNaN(n) ? null : n;
}

function setStoredSubtitleIndex(index: number | null): void {
  localStorage.setItem(SUBTITLE_INDEX_KEY, index === null ? '' : String(index));
}

function getVideoFit(): 'contain' | 'cover' {
  const stored = localStorage.getItem(VIDEO_FIT_KEY);
  return stored === 'cover' ? 'cover' : 'contain';
}

function setVideoFitSetting(fit: 'contain' | 'cover'): void {
  localStorage.setItem(VIDEO_FIT_KEY, fit);
}

// Nerd stats: video/stream info for the stats overlay
interface NerdStatsData {
  // Video element
  resolution: string;
  displaySize: string;
  currentTime: string;
  duration: string;
  bufferAhead: string;
  playbackRate: string;
  readyState: string;
  networkState: string;
  // HLS / stream (when available)
  streamType: string;
  currentLevel: string;
  levelBitrate: string;
  levelResolution: string;
  bandwidthEstimate: string;
  levelsCount: string;
  streamUrl: string;
  videoCodec: string;
  audioCodec: string;
  fragmentDuration: string;
  liveLatency: string;
  realBitrate: string;
  droppedFrames: string;
  totalFrames: string;
  bytesLoaded: string;
}

const READY_STATE_LABELS = ['Nothing', 'Metadata', 'Current data', 'Future data', 'Enough data'];
const NETWORK_STATE_LABELS = ['Empty', 'Idle', 'Loading', 'No source'];

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function formatMbps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  return `${(bps / 1e6).toFixed(2)} Mbps`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes} B`;
}

function truncateUrl(url: string, maxLen = 60): string {
  if (!url || url.length <= maxLen) return url || '—';
  return url.slice(0, maxLen - 3) + '...';
}

function collectNerdStats(video: HTMLVideoElement | null, hls: Hls | null): NerdStatsData | null {
  if (!video) return null;
  const buffered = video.buffered;
  let bufferEnd = 0;
  if (buffered.length > 0) {
    bufferEnd = buffered.end(buffered.length - 1);
  }
  const bufferAheadSec = bufferEnd - video.currentTime;

  const resolution = video.videoWidth && video.videoHeight
    ? `${video.videoWidth}×${video.videoHeight}`
    : '—';
  const displaySize = video.clientWidth && video.clientHeight
    ? `${video.clientWidth}×${video.clientHeight}`
    : '—';

  let streamType = 'Native';
  let currentLevel = '—';
  let levelBitrate = '—';
  let levelResolution = '—';
  let bandwidthEstimate = '—';
  let levelsCount = '—';
  let streamUrl = '—';
  let videoCodec = '—';
  let audioCodec = '—';
  let fragmentDuration = '—';
  let liveLatency = '—';
  let realBitrate = '—';
  let bytesLoaded = '—';

  if (hls) {
    streamType = 'HLS.js';
    streamUrl = truncateUrl(hls.url || '');
    const levels = hls.levels || [];
    levelsCount = String(levels.length);
    const h = hls as { bandwidthEstimate?: number; getBandwidthEstimate?: () => number };
    const bw = typeof h.getBandwidthEstimate === 'function' ? h.getBandwidthEstimate() : h.bandwidthEstimate;
    if (typeof bw === 'number' && Number.isFinite(bw)) {
      bandwidthEstimate = formatMbps(bw);
    }
    const levelIndex = hls.currentLevel;
    if (levelIndex >= 0 && levels[levelIndex]) {
      const level = levels[levelIndex];
      currentLevel = `${levelIndex} (${levels.length} total)`;
      levelBitrate = level.bitrate ? formatMbps(level.bitrate) : '—';
      levelResolution = (level.width && level.height) ? `${level.width}×${level.height}` : (level.height ? `${level.height}p` : '—');
      videoCodec = level.videoCodec || '—';
      audioCodec = level.audioCodec || '—';
      if (level.details?.targetduration != null) {
        fragmentDuration = `${level.details.targetduration.toFixed(1)} s`;
      }
      if (level.realBitrate && level.realBitrate > 0) {
        realBitrate = formatMbps(level.realBitrate);
      }
      if (level.loaded?.bytes != null) {
        bytesLoaded = formatBytes(level.loaded.bytes);
      }
    } else if (levels.length > 0) {
      currentLevel = `Auto (${levels.length} levels)`;
    }
    if (typeof hls.latency === 'number' && Number.isFinite(hls.latency)) {
      liveLatency = `${hls.latency.toFixed(2)} s`;
    }
  }

  let droppedFrames = '—';
  let totalFrames = '—';
  if (video.getVideoPlaybackQuality) {
    const q = video.getVideoPlaybackQuality();
    droppedFrames = String(q.droppedVideoFrames ?? '—');
    totalFrames = String(q.totalVideoFrames ?? '—');
  }

  return {
    resolution,
    displaySize,
    currentTime: formatTime(video.currentTime),
    duration: formatTime(video.duration),
    bufferAhead: Number.isFinite(bufferAheadSec) ? `${bufferAheadSec.toFixed(1)} s` : '—',
    playbackRate: `${video.playbackRate}x`,
    readyState: READY_STATE_LABELS[video.readyState] ?? String(video.readyState),
    networkState: NETWORK_STATE_LABELS[video.networkState] ?? String(video.networkState),
    streamType,
    currentLevel,
    levelBitrate,
    levelResolution,
    bandwidthEstimate,
    levelsCount,
    streamUrl,
    videoCodec,
    audioCodec,
    fragmentDuration,
    liveLatency,
    realBitrate,
    droppedFrames,
    totalFrames,
    bytesLoaded,
  };
}

function isFullscreenElement(el: Element | null): boolean {
  if (!el) return false;
  const doc = document as Document & { webkitFullscreenElement?: Element; msFullscreenElement?: Element };
  return document.fullscreenElement === el || doc.webkitFullscreenElement === el || doc.msFullscreenElement === el;
}

function getFullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element; msFullscreenElement?: Element };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.msFullscreenElement ?? null;
}

export default function Player({ channel, program, onBack, onChannelUp, onChannelDown, enterFullscreenOnMount }: PlayerProps) {
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentProgram, setCurrentProgram] = useState<ScheduleProgram | null>(program);
  const [nextProgram, setNextProgram] = useState<ScheduleProgram | null>(null);
  const [isInterstitial, setIsInterstitial] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [showSettingsOpen, setShowSettingsOpen] = useState(false);
  const [showNerdStats, setShowNerdStats] = useState(false);
  const [nerdStats, setNerdStats] = useState<NerdStatsData | null>(null);
  const [loadingFadeOut, setLoadingFadeOut] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [loadingArtworkUrl, setLoadingArtworkUrl] = useState<string | null>(null);
  const [currentQuality, setCurrentQuality] = useState<QualityPreset>(getVideoQuality);
  const [serverSubtitleTracks, setServerSubtitleTracks] = useState<SubtitleTrackInfo[]>([]);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(getStoredSubtitleIndex);
  const [videoFit, setVideoFit] = useState<'contain' | 'cover'>(getVideoFit);
  const { volume, muted, setVolume, toggleMute } = useVolume();
  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  mutedRef.current = muted;
  volumeRef.current = volume;
  const [serverAudioTracks, setServerAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<number | null>(null);
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const errorCountRef = useRef(0);
  const streamReloadAttemptedRef = useRef(false);
  const currentItemIdRef = useRef<string | null>(null);
  const lastTapTimeRef = useRef(0);
  const selectedSubtitleIndexRef = useRef<number | null>(getStoredSubtitleIndex());
  const selectedAudioStreamIndexRef = useRef<number | null>(null);
  const removePlayingListenersRef = useRef<(() => void) | null>(null);
  const stopPlaybackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopPlaybackChannelIdRef = useRef<number | null>(null);
  const autoAdvanceDisabledRef = useRef(false);

  // ─── Playback progress tracking ──────────────────────
  const watchStartRef = useRef<number>(0);           // wall-clock when this item started playing
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressActivatedRef = useRef(false);        // whether we've passed the 5-min threshold

  // Show overlay briefly on tune-in
  const showOverlayBriefly = useCallback(() => {
    setShowOverlay(true);
    if (overlayTimer.current) clearTimeout(overlayTimer.current);
    overlayTimer.current = setTimeout(() => setShowOverlay(false), 5000);
  }, []);

  // Load and start playback (optionally with a specific audio track)
  // cancelledRef: when set to true (e.g. in effect cleanup), skip further state updates to avoid double-load
  const loadPlayback = useCallback(async (
    quality?: QualityPreset,
    audioStreamIndex?: number,
    isRecoveryReload?: boolean,
    cancelledRef?: { current: boolean },
    reuseInfo?: { info: Awaited<ReturnType<typeof getPlaybackInfo>>; startPositionSec?: number }
  ) => {
    autoAdvanceDisabledRef.current = false; // Re-enable auto-advance when loading new program
    try {
      setLoading(true);
      setError(null);
      if (!isRecoveryReload) {
        setVideoReady(false);
        setLoadingFadeOut(false);
        streamReloadAttemptedRef.current = false;
      }
      // Clean up any previous playing listeners
      const removePlayingListeners = removePlayingListenersRef.current;
      if (removePlayingListeners) {
        removePlayingListeners();
        removePlayingListenersRef.current = null;
      }

      const qualityToUse = quality || currentQuality;
      const isAutoQuality = qualityToUse.id === 'auto';
      const info = reuseInfo?.info ?? await getPlaybackInfo(channel.id, {
        ...(isAutoQuality ? {} : { bitrate: qualityToUse.bitrate, maxWidth: qualityToUse.maxWidth }),
        ...(audioStreamIndex !== undefined && { audioStreamIndex }),
      });

      if (cancelledRef?.current) return;

      setCurrentProgram(info.program);
      setNextProgram(info.next_program);
      setIsInterstitial(info.is_interstitial);
      setServerAudioTracks(info.audio_tracks ?? []);
      const audioIdx = audioStreamIndex != null ? audioStreamIndex : (info.audio_stream_index ?? null);
      setSelectedAudioStreamIndex(audioIdx);
      selectedAudioStreamIndexRef.current = audioIdx;
      const subtitleTracks = info.subtitle_tracks ?? [];
      setServerSubtitleTracks(subtitleTracks);
      const preferredSub =
        info.subtitle_index !== undefined
          ? info.subtitle_index
          : getStoredSubtitleIndex();
      const initialSub =
        preferredSub !== null && preferredSub >= 0 && preferredSub < subtitleTracks.length
          ? preferredSub
          : null;
      setSelectedSubtitleIndex(initialSub);
      selectedSubtitleIndexRef.current = initialSub;
      if (info.subtitle_index !== undefined) {
        setStoredSubtitleIndex(initialSub);
      }

      currentItemIdRef.current = info.program?.jellyfin_item_id || null;
      updateActivePlaybackSession('player', channel.id, info, reuseInfo?.startPositionSec ?? (info.seek_position_seconds || 0));

      // Reset playback progress tracking for the new item
      watchStartRef.current = Date.now();
      progressActivatedRef.current = false;

      if (info.is_interstitial || !info.stream_url) {
        if (!cancelledRef?.current) setLoading(false);
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
        const startPosition = reuseInfo?.startPositionSec ?? (info.seek_position_seconds || 0);
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

        // Set up listeners to fade in video once it starts playing
        const onFirstPlaying = () => {
          if (cancelledRef?.current) return;
          removePlayingListeners();
          // Restore user's volume/muted (we start muted for iOS autoplay compat)
          video.muted = mutedRef.current;
          video.volume = volumeRef.current;
          // Wait a brief moment for video to actually render frames before fading in
          setTimeout(() => {
            if (cancelledRef?.current) return;
            setVideoReady(true);
            setLoadingFadeOut(true);
          }, 300);
        };
        const removePlayingListeners = () => {
          video.removeEventListener('playing', onFirstPlaying);
          video.removeEventListener('loadeddata', onFirstPlaying);
          if (removePlayingListenersRef.current === removePlayingListeners) {
            removePlayingListenersRef.current = null;
          }
        };
        const removePlayingListenersNow = removePlayingListenersRef.current;
        if (removePlayingListenersNow) removePlayingListenersNow();
        removePlayingListenersRef.current = removePlayingListeners;
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
          if (cancelledRef?.current) return;
          errorCountRef.current = 0; // Reset on success
          video.muted = true; // iOS: autoplay requires muted
          video.play().catch(() => {});
          setLoading(false);
          showOverlayBriefly();
          // Apply subtitle selection via hls.js (so subtitles actually display)
          const idx = selectedSubtitleIndexRef.current;
          if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
            hls.subtitleDisplay = idx !== null && idx >= 0;
            hls.subtitleTrack = idx !== null && idx >= 0 && idx < hls.subtitleTracks.length ? idx : -1;
          }
          // Set native track mode after a brief delay for HLS.js to add tracks
          setTimeout(() => setNativeSubtitleMode(idx), 100);
        });
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
          const idx = selectedSubtitleIndexRef.current;
          if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
            hls.subtitleDisplay = idx !== null && idx >= 0;
            hls.subtitleTrack = idx !== null && idx >= 0 && idx < hls.subtitleTracks.length ? idx : -1;
          }
          setTimeout(() => setNativeSubtitleMode(idx), 100);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            errorCountRef.current++;

            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              // First NETWORK_ERROR: retry with same source (e.g. transient 500)
              if (errorCountRef.current === 1) {
                setError(`Playback error. Retry ${errorCountRef.current}/${MAX_RETRIES}...`);
                setTimeout(() => hls.startLoad(), 2000);
                return;
              }
              // Second NETWORK_ERROR (e.g. segment 500 after Jellyfin/FFmpeg transcoding switch):
              // get a new stream session instead of retrying the same broken one
              if (errorCountRef.current >= 2 && !streamReloadAttemptedRef.current) {
                streamReloadAttemptedRef.current = true;
                setError('Reconnecting with new stream...');
                hls.destroy();
                hlsRef.current = null;
                loadPlayback(currentQuality, selectedAudioStreamIndexRef.current ?? undefined, true);
                return;
              }
            }

            if (errorCountRef.current >= MAX_RETRIES) {
              setError('Playback failed. The server may be busy - please try again later.');
              setLoading(false);
              hls.destroy();
              hlsRef.current = null;
              return;
            }

            setError(`Playback error. Retry ${errorCountRef.current}/${MAX_RETRIES}...`);
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            } else {
              setError('Playback failed. Please try again later.');
              setLoading(false);
              hls.destroy();
              hlsRef.current = null;
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS (Safari)
        const startPosition = reuseInfo?.startPositionSec ?? (info.seek_position_seconds || 0);
        video.src = info.stream_url;

        // Set up listeners to fade in video once it starts playing
        const onFirstPlaying = () => {
          if (cancelledRef?.current) return;
          removePlayingListeners();
          // Restore user's volume/muted (we start muted for iOS autoplay compat)
          video.muted = mutedRef.current;
          video.volume = volumeRef.current;
          setTimeout(() => {
            if (cancelledRef?.current) return;
            setVideoReady(true);
            setLoadingFadeOut(true);
          }, 300);
        };
        const removePlayingListeners = () => {
          video.removeEventListener('playing', onFirstPlaying);
          video.removeEventListener('canplay', onCanPlay);
          if (removePlayingListenersRef.current === removePlayingListeners) {
            removePlayingListenersRef.current = null;
          }
        };
        const removePlayingListenersNow = removePlayingListenersRef.current;
        if (removePlayingListenersNow) removePlayingListenersNow();
        removePlayingListenersRef.current = removePlayingListeners;
        video.addEventListener('playing', onFirstPlaying);

        // Use canplay (not loadedmetadata) for native HLS - iOS needs enough data before play()
        const onCanPlay = () => {
          if (cancelledRef?.current) return;
          if (startPosition > 0) video.currentTime = startPosition;
          video.muted = true; // iOS: autoplay requires muted
          video.play().catch(() => {});
          setLoading(false);
          showOverlayBriefly();
        };
        video.addEventListener('canplay', onCanPlay);
      } else {
        setError('HLS playback not supported in this browser');
        setLoading(false);
      }
    } catch (err) {
      setError(formatPlaybackError(err instanceof Error ? err : String(err)));
      setLoading(false);
    }
  }, [channel.id, currentQuality, showOverlayBriefly]);

  // Load stream on mount and when channel/quality changes. Cleanup runs when channel
  // changes or on unmount: we tell Jellyfin to stop the transcode session (saves resources).
  // Defer stopPlayback so React Strict Mode's double-mount doesn't tear down the session
  // before the effect re-runs (which would cause video to start, stop, then start again).
  useEffect(() => {
    // Cancel deferred stop only if we're re-running for the SAME channel (React Strict Mode).
    // When changing channel, let the stop run to tear down the previous session.
    if (stopPlaybackTimeoutRef.current && stopPlaybackChannelIdRef.current === channel.id) {
      clearTimeout(stopPlaybackTimeoutRef.current);
      stopPlaybackTimeoutRef.current = null;
      stopPlaybackChannelIdRef.current = null;
    }

    const cancelled = { current: false };
    const handoffItemId = program?.jellyfin_item_id ?? null;
    const handoff = handoffItemId ? consumePlaybackHandoff('player', channel.id, handoffItemId) : null;
    if (handoff) {
      loadPlayback(undefined, undefined, undefined, cancelled, { info: handoff.info, startPositionSec: handoff.positionSec });
    } else {
      loadPlayback(undefined, undefined, undefined, cancelled);
    }

    const handleBeforeUnload = () => {
      if (currentItemIdRef.current) {
        const positionMs = videoRef.current ? Math.round(videoRef.current.currentTime * 1000) : undefined;
        const data = JSON.stringify({ itemId: currentItemIdRef.current, positionMs });
        navigator.sendBeacon('/api/stream/stop', new Blob([data], { type: 'application/json' }));
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      cancelled.current = true;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      const removePlayingListeners = removePlayingListenersRef.current;
      if (removePlayingListeners) {
        removePlayingListeners();
        removePlayingListenersRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (overlayTimer.current) clearTimeout(overlayTimer.current);
      if (checkTimer.current) clearInterval(checkTimer.current);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
      // Defer stopPlayback: if effect re-runs for SAME channel (Strict Mode), we cancel and never stop.
      // When channel changes or unmount, the stop will run.
      const itemId = currentItemIdRef.current;
      if (itemId) {
        const positionMs = videoRef.current ? Math.round(videoRef.current.currentTime * 1000) : undefined;
        if (shouldPreservePlaybackOnUnmount('player', channel.id, itemId)) {
          updatePlaybackPosition('player', itemId, (positionMs ?? 0) / 1000);
          return;
        }
        stopPlaybackChannelIdRef.current = channel.id;
        stopPlaybackTimeoutRef.current = setTimeout(() => {
          stopPlaybackTimeoutRef.current = null;
          stopPlaybackChannelIdRef.current = null;
          stopPlayback(itemId, undefined, positionMs).catch(() => {});
        }, 0);
      }
    };
  }, [loadPlayback, channel.id, program?.jellyfin_item_id]);

  // Sync loading artwork URL when program changes
  useEffect(() => {
    const prog = currentProgram ?? program;
    setLoadingArtworkUrl((prog?.thumbnail_url || prog?.banner_url) ?? null);
  }, [currentProgram?.jellyfin_item_id, program?.jellyfin_item_id]);

  // Progress tracking and auto-advance
  useEffect(() => {
    checkTimer.current = setInterval(async () => {
      if (currentProgram) {
        const now = Date.now();
        const start = new Date(currentProgram.start_time).getTime();
        const end = new Date(currentProgram.end_time).getTime();
        const prog = Math.min(100, ((now - start) / (end - start)) * 100);
        setProgress(prog);

        // Auto-advance when program ends (disabled if user restarted - they stay until manual switch)
        if (now >= end && !autoAdvanceDisabledRef.current) {
          loadPlayback();
        }
      }
    }, 1000);

    return () => {
      if (checkTimer.current) clearInterval(checkTimer.current);
    };
  }, [currentProgram, loadPlayback]);

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
          console.log(`[Player] 5-min watch threshold reached for ${itemId}, starting progress reports`);
        }
        const positionMs = Math.round(video.currentTime * 1000);
        updatePlaybackPosition('player', itemId, positionMs / 1000);
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

  // Keyboard controls
  const handleBackToGuide = useCallback(() => {
    const itemId = currentItemIdRef.current;
    if (itemId) {
      requestPlaybackHandoff('player', 'guide', channel.id, itemId, videoRef.current?.currentTime ?? 0);
    }
    onBack();
  }, [channel.id, onBack]);

  useKeyboard('player', {
    onEscape: handleBackToGuide,
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

  // Apply volume settings to video element
  useVideoVolume(videoRef, volume, muted);

  // Click/tap handler with double-tap detection
  const handleClick = useCallback(() => {
    // iOS fallback: if video loaded but is paused (autoplay blocked), tap-to-play
    const video = videoRef.current;
    if (video && !isInterstitial && video.paused && video.readyState >= 2) {
      video.muted = true;
      video.play().then(() => {
        video.muted = mutedRef.current;
        video.volume = volumeRef.current;
      }).catch(() => {});
      return;
    }

    const now = Date.now();
    const timeSinceLastTap = now - lastTapTimeRef.current;
    
    if (timeSinceLastTap < DOUBLE_TAP_DELAY) {
      // Double tap detected - toggle video fit
      toggleVideoFit();
      lastTapTimeRef.current = 0; // Reset to prevent triple tap
    } else {
      // Single tap - close settings, or toggle overlay (tap to show, tap again to dismiss)
      if (showSettingsOpen) {
        setShowSettingsOpen(false);
      } else if (showOverlay) {
        if (overlayTimer.current) {
          clearTimeout(overlayTimer.current);
          overlayTimer.current = null;
        }
        setShowOverlay(false);
      } else {
        showOverlayBriefly();
      }
      lastTapTimeRef.current = now;
    }
  }, [showOverlayBriefly, showOverlay, showSettingsOpen, toggleVideoFit, isInterstitial]);

  // Restart current program from the beginning (client-side only; progress is lost on back/reload)
  const handleRestartProgram = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (video && !isInterstitial) {
      autoAdvanceDisabledRef.current = true; // Disable auto-advance to next program
      video.currentTime = 0;
      video.muted = true; // iOS: autoplay requires muted
      video.play().then(() => {
        video.muted = mutedRef.current;
        video.volume = volumeRef.current;
      }).catch(() => {});
      setShowSettingsOpen(false);
    }
  }, [isInterstitial]);

  // Toggle unified settings panel
  const toggleSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowSettingsOpen(prev => !prev);
    if (!showSettingsOpen) showOverlayBriefly();
  }, [showOverlayBriefly, showSettingsOpen]);

  // Browser fullscreen (take over entire screen)
  const toggleFullscreen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const el = playerContainerRef.current;
    if (!el) return;
    if (isFullscreenElement(el)) {
      const doc = document as Document & { exitFullscreen?: () => Promise<void>; webkitExitFullscreen?: () => void; msExitFullscreen?: () => void };
      if (doc.exitFullscreen) doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      else if (doc.msExitFullscreen) doc.msExitFullscreen();
    } else {
      const htmlEl = el as HTMLElement & { requestFullscreen?: () => Promise<void>; webkitRequestFullscreen?: () => void; msRequestFullscreen?: () => void };
      if (htmlEl.requestFullscreen) htmlEl.requestFullscreen();
      else if (htmlEl.webkitRequestFullscreen) htmlEl.webkitRequestFullscreen();
      else if (htmlEl.msRequestFullscreen) htmlEl.msRequestFullscreen();
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(getFullscreenElement() === playerContainerRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('MSFullscreenChange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      document.removeEventListener('MSFullscreenChange', onFullscreenChange);
    };
  }, []);

  // When navigating from guide in fullscreen, enter fullscreen on the player
  useEffect(() => {
    if (!enterFullscreenOnMount) return;
    const el = playerContainerRef.current;
    if (!el) return;
    const htmlEl = el as HTMLElement & { requestFullscreen?: () => Promise<void>; webkitRequestFullscreen?: () => void; msRequestFullscreen?: () => void };
    const req = htmlEl.requestFullscreen ?? htmlEl.webkitRequestFullscreen ?? htmlEl.msRequestFullscreen;
    if (req) {
      // Brief delay so the player DOM is ready after route transition
      const id = requestAnimationFrame(() => {
        req.call(htmlEl);
      });
      return () => cancelAnimationFrame(id);
    }
  }, [enterFullscreenOnMount]);

  // Poll nerd stats in real time when overlay is open
  useEffect(() => {
    if (!showNerdStats) return;
    const tick = () => {
      setNerdStats(collectNerdStats(videoRef.current, hlsRef.current));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [showNerdStats]);

  // When fade-out starts, hide loading overlay after the transition duration.
  useEffect(() => {
    if (!loadingFadeOut) return;
    // Match transition duration (2s) + small buffer so overlay is fully faded before removal.
    const t = setTimeout(() => setLoadingFadeOut(false), 2100);
    return () => clearTimeout(t);
  }, [loadingFadeOut]);

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

  // Select subtitle track (position index in list); null = Off
  const handleSelectSubtitleTrack = useCallback((positionIndex: number | null) => {
    setSelectedSubtitleIndex(positionIndex);
    selectedSubtitleIndexRef.current = positionIndex;
    setStoredSubtitleIndex(positionIndex);
    updateSettings({ preferred_subtitle_index: positionIndex }).catch(() => {});
    setShowSettingsOpen(false);
    applySubtitleTrack(positionIndex);
    showOverlayBriefly();
  }, [showOverlayBriefly, applySubtitleTrack]);

  // Keep ref in sync and apply subtitle to hls when selection changes (e.g. from guide)
  useEffect(() => {
    selectedSubtitleIndexRef.current = selectedSubtitleIndex;
    applySubtitleTrack(selectedSubtitleIndex);
  }, [selectedSubtitleIndex, applySubtitleTrack]);

  // Handle quality change
  const handleQualityChange = useCallback(async (preset: QualityPreset) => {
    setCurrentQuality(preset);
    setVideoQuality(preset.id);
    setShowSettingsOpen(false);
    
    // Stop current playback and restart with new quality
    if (currentItemIdRef.current) {
      await stopPlayback(currentItemIdRef.current).catch(() => {});
    }
    
    // Reload with new quality
    loadPlayback(preset);
  }, [loadPlayback]);

  const handleSelectServerAudioTrack = useCallback((index: number) => {
    const track = serverAudioTracks.find((t) => t.index === index);
    if (track) {
      updateSettings({ preferred_audio_language: track.language }).catch(() => {});
    }
    setSelectedAudioStreamIndex(index);
    selectedAudioStreamIndexRef.current = index;
    setShowSettingsOpen(false);
    loadPlayback(undefined, index);
  }, [loadPlayback, serverAudioTracks]);

  const swipe = useSwipe({
    onSwipeUp: onChannelUp,
    onSwipeDown: onChannelDown,
    enabled: !showSettingsOpen,
  });

  const handleClickWithSwipeGuard = useCallback(() => {
    if (swipe.didSwipeRef.current) return;
    handleClick();
  }, [handleClick]);

  return (
    <div
      ref={playerContainerRef}
      className="player"
      onClick={handleClickWithSwipeGuard}
      onTouchStart={swipe.onTouchStart}
      onTouchEnd={swipe.onTouchEnd}
    >
      {/* Video element */}
      {!isInterstitial && (
        <video
          ref={videoRef}
          className={`player-video ${videoFit === 'cover' ? 'player-video-fill' : ''} ${videoReady ? 'player-video-ready' : ''}`}
          playsInline
        />
      )}

      {/* Interstitial "Next Up" card */}
      {isInterstitial && currentProgram && (
        <NextUpCard
          program={currentProgram}
          nextProgram={nextProgram}
        />
      )}

      {/* Loading: box art (thumbnail) until video is ready, then fades out over 2s (like preview) */}
      {(!videoReady || loadingFadeOut) && !isInterstitial && (() => {
        const prog = currentProgram ?? program;
        return (
          <div className={`player-loading ${loadingFadeOut ? 'player-loading-fade-out' : ''}`} key={prog?.jellyfin_item_id}>
            <div className="player-loading-banner player-loading-banner-fallback" />
            {loadingArtworkUrl && (
              <>
                <div className="player-loading-banner player-loading-banner-blur" style={{ backgroundImage: `url(${loadingArtworkUrl})` }} />
                <div className="player-loading-artwork-wrap">
                  <img
                    className="player-loading-banner-img"
                    src={loadingArtworkUrl}
                    alt=""
                    onError={() => {
                      const triedThumb = loadingArtworkUrl.includes('/Primary');
                      const fallback = triedThumb ? prog?.banner_url : prog?.thumbnail_url;
                      if (fallback && loadingArtworkUrl !== fallback) {
                        setLoadingArtworkUrl(fallback);
                      } else {
                        setLoadingArtworkUrl(null);
                      }
                    }}
                  />
                </div>
              </>
            )}
            <div className="player-loading-text">TUNING...</div>
          </div>
        );
      })()}

      {/* Error display (same overlay style as TUNING) */}
      {error && !isInterstitial && (() => {
        const prog = currentProgram ?? program;
        return (
          <div className="player-error-overlay">
            <div className="player-loading-banner player-loading-banner-fallback" />
            {loadingArtworkUrl && (
              <div className="player-loading-banner player-loading-banner-blur" style={{ backgroundImage: `url(${loadingArtworkUrl})` }} />
            )}
            <div className="player-error-text-wrap">
              <span className="player-error-title">ERROR</span>
              <span className="player-error-detail">{error}</span>
            </div>
          </div>
        );
      })()}

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

      {/* Back button - visible on hover or when overlay/settings is showing */}
      <button 
        className={`player-back-btn ${showOverlay || showSettingsOpen ? 'visible' : ''}`} 
        onClick={(e) => { e.stopPropagation(); handleBackToGuide(); }}
      >
        Back To Guide
      </button>

      {/* Fullscreen + Settings (right side) */}
      {!isInterstitial && (
        <div className={`player-controls-right ${showOverlay || showSettingsOpen ? 'visible' : ''}`}>
          <button
            type="button"
            className={`player-control-btn player-fullscreen-btn ${isFullscreen ? 'active' : ''}`}
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <span className="player-btn-icon">{isFullscreen ? '⤓' : '⤢'}</span>
          </button>
          <button
            className={`player-control-btn player-settings-btn ${showSettingsOpen ? 'active' : ''}`}
            onClick={toggleSettings}
            title="Playback settings"
          >
            <span className="player-btn-icon">⚙</span>
          </button>
        </div>
      )}

      {/* Unified settings panel - bottom sheet on mobile, panel on desktop */}
      {showSettingsOpen && (
        <div
          className="player-settings-backdrop"
          onClick={() => setShowSettingsOpen(false)}
          aria-hidden="true"
        >
          <div className="player-settings-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Playback settings">
            <div className="player-settings-drag-handle" aria-hidden="true" />
            <div className="player-settings-inner">
              <div className="player-settings-header">
                <span className="player-settings-title">Settings</span>
                <button type="button" className="player-settings-close" onClick={() => setShowSettingsOpen(false)} aria-label="Close settings">✕</button>
              </div>

              {!isInterstitial && (
                <div className="player-settings-section">
                  <button
                    type="button"
                    className="player-settings-option player-settings-restart-btn"
                    onClick={handleRestartProgram}
                    title="Restart from the beginning (progress is lost when you leave)"
                  >
                    <span className="player-btn-icon">↺</span>
                    Restart program
                  </button>
                </div>
              )}

              <div className="player-settings-section">
                <div className="player-settings-section-title">Volume</div>
                <div className="player-settings-volume-row">
                  <button
                    type="button"
                    className={`player-settings-mute ${muted ? 'muted' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                    title={muted ? 'Unmute' : 'Mute'}
                    aria-label={muted ? 'Unmute' : 'Mute'}
                  >
                    {muted || volume === 0 ? '🔇' : '🔊'}
                  </button>
                  <input
                    type="range"
                    className="player-settings-slider"
                    min="0"
                    max="1"
                    step="0.05"
                    value={muted ? 0 : volume}
                    onChange={(e) => { e.stopPropagation(); setVolume(parseFloat(e.target.value)); }}
                    onClick={(e) => e.stopPropagation()}
                    style={{ '--volume-fill': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
                    aria-label="Volume"
                  />
                </div>
              </div>

              <div className="player-settings-section">
                <div className="player-settings-section-title">Video fit</div>
                <div className="player-settings-fit-row">
                  <button
                    type="button"
                    className={`player-settings-option ${videoFit === 'contain' ? 'active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setVideoFitSetting('contain'); setVideoFit('contain'); }}
                  >
                    Letterbox
                  </button>
                  <button
                    type="button"
                    className={`player-settings-option ${videoFit === 'cover' ? 'active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setVideoFitSetting('cover'); setVideoFit('cover'); }}
                  >
                    Fill
                  </button>
                </div>
              </div>

              <div className="player-settings-section">
                <div className="player-settings-section-title">Quality</div>
                <div className="player-settings-options-grid">
                  {QUALITY_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`player-settings-option ${currentQuality.id === preset.id ? 'active' : ''}`}
                      onClick={() => handleQualityChange(preset)}
                      title={preset.description}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {serverAudioTracks.length >= 1 && (
                <div className="player-settings-section">
                  <div className="player-settings-section-title">Audio track</div>
                  <div className="player-settings-options-list">
                    {serverAudioTracks.map((track) => (
                      <button
                        key={track.index}
                        type="button"
                        className={`player-settings-option ${selectedAudioStreamIndex === track.index || (selectedAudioStreamIndex === null && track.index === serverAudioTracks[0]?.index) ? 'active' : ''}`}
                      onClick={() => handleSelectServerAudioTrack(track.index)}
                    >
                      {formatAudioTrackNameFromServer(track)}
                    </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="player-settings-section">
                <div className="player-settings-section-title">Subtitles</div>
                <div className="player-settings-options-list">
                  <button
                    type="button"
                    className={`player-settings-option ${selectedSubtitleIndex === null ? 'active' : ''}`}
                    onClick={() => handleSelectSubtitleTrack(null)}
                  >
                    Off
                  </button>
                  {serverSubtitleTracks.length === 0 ? (
                    <div className="player-settings-empty">No subtitles available</div>
                  ) : (
                    serverSubtitleTracks.map((track, positionIndex) => (
                      <button
                        key={track.index}
                        type="button"
                        className={`player-settings-option ${selectedSubtitleIndex === positionIndex ? 'active' : ''}`}
                        onClick={() => handleSelectSubtitleTrack(positionIndex)}
                      >
                        {formatSubtitleTrackNameFromServer(track)}
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="player-settings-section player-settings-footer">
                <button
                  type="button"
                  className="player-settings-option player-settings-nerd-btn"
                  onClick={(e) => { e.stopPropagation(); setShowSettingsOpen(false); setShowNerdStats(true); }}
                >
                  Stream info
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Nerd stats overlay (realtime video/stream info) */}
      {showNerdStats && (
        <div className="player-nerd-stats-overlay" onClick={() => setShowNerdStats(false)}>
          <div className="player-nerd-stats-panel" onClick={(e) => e.stopPropagation()}>
            <div className="player-nerd-stats-header">
              <span className="player-nerd-stats-title">STREAM & VIDEO INFO</span>
              <button type="button" className="player-nerd-stats-close" onClick={() => setShowNerdStats(false)} aria-label="Close">✕</button>
            </div>
            <div className="player-nerd-stats-body">
              {nerdStats ? (
                <table className="player-nerd-stats-table">
                  <tbody>
                    <tr><td className="player-nerd-stats-label">Stream</td><td>{nerdStats.streamType}</td></tr>
                    <tr><td className="player-nerd-stats-label">Stream URL</td><td title={nerdStats.streamUrl}>{nerdStats.streamUrl}</td></tr>
                    <tr><td className="player-nerd-stats-label">Video codec</td><td>{nerdStats.videoCodec}</td></tr>
                    <tr><td className="player-nerd-stats-label">Audio codec</td><td>{nerdStats.audioCodec}</td></tr>
                    <tr><td className="player-nerd-stats-label">Resolution (decoded)</td><td>{nerdStats.resolution}</td></tr>
                    <tr><td className="player-nerd-stats-label">Display size</td><td>{nerdStats.displaySize}</td></tr>
                    <tr><td className="player-nerd-stats-label">Current time</td><td>{nerdStats.currentTime} / {nerdStats.duration}</td></tr>
                    <tr><td className="player-nerd-stats-label">Buffer ahead</td><td>{nerdStats.bufferAhead}</td></tr>
                    <tr><td className="player-nerd-stats-label">Fragment duration</td><td>{nerdStats.fragmentDuration}</td></tr>
                    <tr><td className="player-nerd-stats-label">Playback rate</td><td>{nerdStats.playbackRate}</td></tr>
                    <tr><td className="player-nerd-stats-label">Ready state</td><td>{nerdStats.readyState}</td></tr>
                    <tr><td className="player-nerd-stats-label">Network state</td><td>{nerdStats.networkState}</td></tr>
                    <tr><td className="player-nerd-stats-label">HLS level</td><td>{nerdStats.currentLevel}</td></tr>
                    <tr><td className="player-nerd-stats-label">Level resolution</td><td>{nerdStats.levelResolution}</td></tr>
                    <tr><td className="player-nerd-stats-label">Level bitrate</td><td>{nerdStats.levelBitrate}</td></tr>
                    <tr><td className="player-nerd-stats-label">Real bitrate</td><td>{nerdStats.realBitrate}</td></tr>
                    <tr><td className="player-nerd-stats-label">Bandwidth estimate</td><td>{nerdStats.bandwidthEstimate}</td></tr>
                    <tr><td className="player-nerd-stats-label">Bytes loaded</td><td>{nerdStats.bytesLoaded}</td></tr>
                    <tr><td className="player-nerd-stats-label">Levels available</td><td>{nerdStats.levelsCount}</td></tr>
                    <tr><td className="player-nerd-stats-label">Live latency</td><td>{nerdStats.liveLatency}</td></tr>
                    <tr><td className="player-nerd-stats-label">Dropped frames</td><td>{nerdStats.droppedFrames}</td></tr>
                    <tr><td className="player-nerd-stats-label">Total frames</td><td>{nerdStats.totalFrames}</td></tr>
                  </tbody>
                </table>
              ) : (
                <div className="player-nerd-stats-empty">No video element — start playback to see stats.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Double-tap hint (shown briefly on first use) */}
      {showOverlay && (
        <div className="player-hint">Double-tap to toggle fill mode</div>
      )}
    </div>
  );
}
