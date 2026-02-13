import { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { getPlaybackInfo, stopPlayback, updateSettings } from '../../services/api';
import { useKeyboard } from '../../hooks/useKeyboard';
import { useSwipe } from '../../hooks/useSwipe';
import { useVolume, useVideoVolume } from '../../hooks/useVolume';
import { getVideoQuality, setVideoQuality, QUALITY_PRESETS, type QualityPreset } from '../Settings/DisplaySettings';
import InfoOverlay from './InfoOverlay';
import NextUpCard from './NextUpCard';
import type { Channel, ScheduleProgram } from '../../types';
import type { AudioTrackInfo, SubtitleTrackInfo } from '../../types';
import { formatAudioTrackNameFromServer, formatSubtitleTrackNameFromServer } from '../Guide/audioTrackUtils';
import './Player.css';

interface PlayerProps {
  channel: Channel;
  program: ScheduleProgram | null;
  onBack: () => void;
  onChannelUp?: () => void;
  onChannelDown?: () => void;
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

export default function Player({ channel, program, onBack, onChannelUp, onChannelDown }: PlayerProps) {
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
  const [serverAudioTracks, setServerAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<number | null>(null);
  const overlayTimer = useRef<ReturnType<typeof setTimeout>>();
  const checkTimer = useRef<ReturnType<typeof setInterval>>();
  const errorCountRef = useRef(0);
  const streamReloadAttemptedRef = useRef(false);
  const currentItemIdRef = useRef<string | null>(null);
  const lastTapTimeRef = useRef(0);
  const selectedSubtitleIndexRef = useRef<number | null>(getStoredSubtitleIndex());
  const selectedAudioStreamIndexRef = useRef<number | null>(null);
  const prevVideoReadyRef = useRef(false);
  const removePlayingListenersRef = useRef<(() => void) | null>(null);

  // Show overlay briefly on tune-in
  const showOverlayBriefly = useCallback(() => {
    setShowOverlay(true);
    if (overlayTimer.current) clearTimeout(overlayTimer.current);
    overlayTimer.current = setTimeout(() => setShowOverlay(false), 5000);
  }, []);

  // Load and start playback (optionally with a specific audio track)
  const loadPlayback = useCallback(async (quality?: QualityPreset, audioStreamIndex?: number, isRecoveryReload?: boolean) => {
    try {
      setLoading(true);
      setError(null);
      setVideoReady(false);
      if (!isRecoveryReload) {
        streamReloadAttemptedRef.current = false;
      }
      // Clean up any previous playing listeners
      if (removePlayingListenersRef.current) {
        removePlayingListenersRef.current();
        removePlayingListenersRef.current = null;
      }

      const qualityToUse = quality || currentQuality;
      const isAutoQuality = qualityToUse.id === 'auto';
      const info = await getPlaybackInfo(channel.id, {
        ...(isAutoQuality ? {} : { bitrate: qualityToUse.bitrate, maxWidth: qualityToUse.maxWidth }),
        ...(audioStreamIndex !== undefined && { audioStreamIndex }),
      });

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

        // Set up listeners to fade in video once it starts playing
        const onFirstPlaying = () => {
          removePlayingListeners();
          // Wait a brief moment for video to actually render frames before fading in
          setTimeout(() => setVideoReady(true), 300);
        };
        const removePlayingListeners = () => {
          video.removeEventListener('playing', onFirstPlaying);
          video.removeEventListener('loadeddata', onFirstPlaying);
          if (removePlayingListenersRef.current === removePlayingListeners) {
            removePlayingListenersRef.current = null;
          }
        };
        if (removePlayingListenersRef.current) {
          removePlayingListenersRef.current();
        }
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
          errorCountRef.current = 0; // Reset on success
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
        const startPosition = info.seek_position_seconds || 0;
        video.src = info.stream_url;

        // Set up listeners to fade in video once it starts playing
        const onFirstPlaying = () => {
          removePlayingListeners();
          setTimeout(() => setVideoReady(true), 300);
        };
        const removePlayingListeners = () => {
          video.removeEventListener('playing', onFirstPlaying);
          if (removePlayingListenersRef.current === removePlayingListeners) {
            removePlayingListenersRef.current = null;
          }
        };
        if (removePlayingListenersRef.current) {
          removePlayingListenersRef.current();
        }
        removePlayingListenersRef.current = removePlayingListeners;
        video.addEventListener('playing', onFirstPlaying);

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

  // Load stream on mount and when channel/quality changes. Cleanup runs when channel
  // changes or on unmount: we tell Jellyfin to stop the transcode session (saves resources).
  useEffect(() => {
    loadPlayback();

    const handleBeforeUnload = () => {
      if (currentItemIdRef.current) {
        const data = JSON.stringify({ itemId: currentItemIdRef.current });
        navigator.sendBeacon('/api/stream/stop', new Blob([data], { type: 'application/json' }));
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (removePlayingListenersRef.current) {
        removePlayingListenersRef.current();
        removePlayingListenersRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (overlayTimer.current) clearTimeout(overlayTimer.current);
      if (checkTimer.current) clearInterval(checkTimer.current);
      // Stop Jellyfin transcode session when leaving or when user changes channel
      if (currentItemIdRef.current) {
        stopPlayback(currentItemIdRef.current).catch(() => {});
      }
    };
  }, [loadPlayback]);

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

  // Apply volume settings to video element
  useVideoVolume(videoRef, volume, muted);

  // Click/tap handler with double-tap detection
  const handleClick = useCallback(() => {
    const now = Date.now();
    const timeSinceLastTap = now - lastTapTimeRef.current;
    
    if (timeSinceLastTap < DOUBLE_TAP_DELAY) {
      // Double tap detected - toggle video fit
      toggleVideoFit();
      lastTapTimeRef.current = 0; // Reset to prevent triple tap
    } else {
      // Single tap - close settings, or show overlay
      if (showSettingsOpen) {
        setShowSettingsOpen(false);
      } else {
        showOverlayBriefly();
      }
      lastTapTimeRef.current = now;
    }
  }, [showOverlayBriefly, showSettingsOpen, toggleVideoFit]);

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

  // When video is ready to play, fade out loading overlay over 2s then hide it (like preview)
  useEffect(() => {
    const wasReady = prevVideoReadyRef.current;
    prevVideoReadyRef.current = videoReady;
    if (!videoReady) {
      setLoadingFadeOut(false);
      return;
    }
    if (!wasReady) {
      setLoadingFadeOut(true);
      const t = setTimeout(() => setLoadingFadeOut(false), 2000);
      return () => clearTimeout(t);
    }
  }, [videoReady]);

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

  const swipe = useSwipe({ onSwipeUp: onChannelUp, onSwipeDown: onChannelDown });

  return (
    <div
      ref={playerContainerRef}
      className="player"
      onClick={handleClick}
      onTouchStart={swipe.onTouchStart}
      onTouchEnd={swipe.onTouchEnd}
    >
      {/* Video element */}
      {!isInterstitial && (
        <video
          ref={videoRef}
          className={`player-video ${videoFit === 'cover' ? 'player-video-fill' : ''} ${videoReady ? 'player-video-ready' : ''}`}
          playsInline
          autoPlay
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

      {/* Back button - visible on hover or when overlay/settings is showing */}
      <button 
        className={`player-back-btn ${showOverlay || showSettingsOpen ? 'visible' : ''}`} 
        onClick={(e) => { e.stopPropagation(); onBack(); }}
      >
        ← GUIDE
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
