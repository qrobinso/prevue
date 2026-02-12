import { useRef, useEffect, useState, useCallback } from 'react';
import Hls from 'hls.js';
import type { ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import { getPlaybackInfo, stopPlayback } from '../../services/api';
import './Guide.css';

// Low quality preset for preview (480p, low bitrate)
const PREVIEW_QUALITY = { bitrate: 2000000, maxWidth: 854 };

interface PreviewPanelProps {
  channel: ChannelWithProgram | null;
  program: ScheduleProgram | null;
  currentTime: Date;
  streamingPaused?: boolean;
  onTune?: () => void;
}

export default function PreviewPanel({ channel, program, currentTime, streamingPaused = false, onTune }: PreviewPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const currentItemIdRef = useRef<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [videoError, setVideoError] = useState(false);

  // Cleanup function to stop playback
  const cleanup = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (currentItemIdRef.current) {
      stopPlayback(currentItemIdRef.current).catch(() => {});
      currentItemIdRef.current = null;
    }
    setVideoReady(false);
    setVideoError(false);
  }, []);

  // Load preview video when channel changes
  useEffect(() => {
    // Don't start streaming if paused (settings open)
    if (streamingPaused) {
      return;
    }

    if (!channel || !program || program.type === 'interstitial') {
      cleanup();
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    // Don't reload if same item
    if (currentItemIdRef.current === program.jellyfin_item_id) {
      return;
    }

    // Cleanup previous stream
    cleanup();

    let cancelled = false;

    const loadPreview = async () => {
      try {
        const info = await getPlaybackInfo(channel.id, PREVIEW_QUALITY);
        
        if (cancelled || !info.stream_url || info.is_interstitial) return;

        currentItemIdRef.current = info.program.jellyfin_item_id;
        const startPosition = info.seek_position_seconds || 0;

        if (Hls.isSupported()) {
          const hls = new Hls({
            startPosition,
            maxBufferLength: 10,
            maxMaxBufferLength: 20,
            maxBufferSize: 10 * 1000 * 1000, // 10MB
            fragLoadingMaxRetry: 2,
            manifestLoadingMaxRetry: 2,
            levelLoadingMaxRetry: 2,
          });

          hlsRef.current = hls;
          hls.loadSource(info.stream_url);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (!cancelled) {
              video.muted = true; // Preview is muted
              video.play().catch(() => {});
              setVideoReady(true);
            }
          });

          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal && !cancelled) {
              setVideoError(true);
              hls.destroy();
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Native HLS (Safari)
          video.src = info.stream_url;
          video.muted = true;
          video.currentTime = startPosition;
          video.play().catch(() => {});
          setVideoReady(true);
        }
      } catch (err) {
        if (!cancelled) {
          setVideoError(true);
        }
      }
    };

    // Small delay to prevent rapid-fire requests while navigating
    const timer = setTimeout(loadPreview, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [channel?.id, program?.jellyfin_item_id, cleanup, streamingPaused]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
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

  const timeStr = currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const showVideo = program && program.type !== 'interstitial';

  const handleClick = useCallback(() => {
    if (onTune && channel && program) {
      onTune();
    }
  }, [onTune, channel, program]);

  return (
    <div 
      className={`preview-panel ${onTune ? 'preview-panel-clickable' : ''}`}
      onClick={handleClick}
      role={onTune ? 'button' : undefined}
      tabIndex={onTune ? 0 : undefined}
      onKeyDown={onTune ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); } : undefined}
    >
      {/* Video fills entire panel */}
      <div className="preview-video-container">
        {showVideo && (
          <video
            ref={videoRef}
            className={`preview-video ${videoReady ? 'ready' : ''}`}
            muted
            playsInline
          />
        )}
        {(!videoReady || videoError) && program?.thumbnail_url && (
          <img
            className="preview-thumbnail-img"
            src={program.thumbnail_url}
            alt={program.title}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
      </div>
      {/* Info overlay on top of video */}
      <div className="preview-overlay">
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
        <div className="preview-clock">{timeStr}</div>
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
