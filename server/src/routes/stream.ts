import type { Express } from 'express';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { JellyfinClient } from '../services/JellyfinClient.js';
import * as queries from '../db/queries.js';

export const streamRoutes = Router();

// Track active play sessions so we can stop them when user leaves
// Maps itemId -> { playSessionId, mediaSourceId }
const activeSessions = new Map<string, { playSessionId: string; mediaSourceId: string }>();
const progressStartedSessions = new Set<string>(); // playSessionId set when PlaybackStart has been reported

// Last proxy activity (segment/playlist request) per itemId — used to stop idle transcodes
const lastActivityByItemId = new Map<string, number>();

const IDLE_CLEANUP_INTERVAL_MS = 2 * 60 * 1000;  // 2 minutes
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;         // stop if no activity for 5 minutes

// Request deduplication: coalesce concurrent requests for the same URL
// This prevents multiple FFmpeg processes from starting when hls.js retries
const pendingRequests = new Map<string, Promise<{ ok: boolean; status: number; headers: Headers; buffer: ArrayBuffer | null; text: string | null }>>();

function isProgressSharingEnabled(rawSetting: unknown): boolean {
  if (typeof rawSetting === 'boolean') return rawSetting;
  if (typeof rawSetting === 'string') {
    const normalized = rawSetting.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  if (typeof rawSetting === 'number') return rawSetting !== 0;
  return false;
}

// POST /api/stream/stop - Stop playback and release server resources
// Client should call this when user leaves video or closes page
streamRoutes.post('/stream/stop', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
    const { itemId, playSessionId, positionMs } = req.body;
    
    // Use provided playSessionId or look up from active sessions
    const session = activeSessions.get(itemId);
    const sessionId = playSessionId || session?.playSessionId;
    
    if (sessionId) {
      // Report playback stopped to Jellyfin if progress sharing is enabled and we have position data
      let reportedStop = false;
      if (positionMs != null && session) {
        const { db } = req.app.locals;
        const enabled = isProgressSharingEnabled(queries.getSetting(db, 'share_playback_progress'));
        if (enabled) {
          // Jellyfin requires PlaybackStart before PlaybackStopped to persist position.
          // If the user watched less than 5 minutes, the progress endpoint never fired,
          // so we send PlaybackStart here first.
          if (!progressStartedSessions.has(sessionId)) {
            console.log(`[Stream Progress] Sending PlaybackStart (on stop) item=${itemId} session=${sessionId} positionMs=${positionMs}`);
            await jf.reportPlaybackStart(itemId, sessionId, session.mediaSourceId, positionMs).catch(() => {});
            progressStartedSessions.add(sessionId);
          }
          console.log(`[Stream Progress] Sending PlaybackStopped item=${itemId} session=${sessionId} positionMs=${positionMs}`);
          await jf.reportPlaybackStopped(itemId, sessionId, session.mediaSourceId, positionMs).catch(() => {});
          reportedStop = true;
        }
      }
      // Only send a bare session stop if reportPlaybackStopped didn't already hit
      // the same /Sessions/Playing/Stopped endpoint (avoids overwriting position data).
      if (!reportedStop) {
        await jf.stopPlaybackSession(sessionId);
      }
      await jf.deleteTranscodingJob(sessionId);
      progressStartedSessions.delete(sessionId);
      activeSessions.delete(itemId);
      lastActivityByItemId.delete(itemId);
      console.log(`[Stream] Stopped playback for item: ${itemId}, session: ${sessionId}`);
      res.json({ success: true, stopped: sessionId });
    } else {
      console.log(`[Stream] No active session found for item: ${itemId}`);
      res.json({ success: true, stopped: null });
    }
  } catch (err) {
    console.error(`[Stream] Error stopping playback:`, err);
    // Still return success - stopping is best-effort
    res.json({ success: true, error: (err as Error).message });
  }
});

// POST /api/stream/progress - Report playback progress to Jellyfin
// Client sends this periodically after the 5-minute watch threshold
streamRoutes.post('/stream/progress', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient, db } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;

    // Check if progress sharing is enabled
    const enabled = isProgressSharingEnabled(queries.getSetting(db, 'share_playback_progress'));
    if (!enabled) {
      console.log(`[Stream Progress] Skipped (disabled) item=${req.body?.itemId ?? 'unknown'} positionMs=${req.body?.positionMs ?? 'unknown'}`);
      res.json({ success: true, reported: false, reason: 'disabled' });
      return;
    }

    const { itemId, positionMs } = req.body;
    if (!itemId || positionMs == null) {
      res.status(400).json({ error: 'itemId and positionMs are required' });
      return;
    }

    const session = activeSessions.get(itemId);
    if (!session) {
      console.log(`[Stream Progress] Skipped (no active session) item=${itemId} positionMs=${positionMs}`);
      res.json({ success: true, reported: false, reason: 'no_session' });
      return;
    }

    // Jellyfin expects PlaybackStart before progress updates for robust watch tracking.
    if (!progressStartedSessions.has(session.playSessionId)) {
      console.log(`[Stream Progress] Starting playback share item=${itemId} session=${session.playSessionId} positionMs=${positionMs}`);
      await jf.reportPlaybackStart(itemId, session.playSessionId, session.mediaSourceId, positionMs);
      progressStartedSessions.add(session.playSessionId);
    }

    console.log(`[Stream Progress] Reporting playback progress item=${itemId} session=${session.playSessionId} positionMs=${positionMs}`);
    await jf.reportPlaybackProgress(
      itemId,
      session.playSessionId,
      session.mediaSourceId,
      positionMs
    );
    res.json({ success: true, reported: true });
  } catch (err) {
    console.error(`[Stream] Error reporting progress:`, err);
    res.json({ success: true, reported: false, error: (err as Error).message });
  }
});

// GET /api/stream/sessions - List active sessions (debugging)
streamRoutes.get('/stream/sessions', (_req: Request, res: Response) => {
  const sessions = Array.from(activeSessions.entries()).map(([itemId, session]) => ({
    itemId,
    playSessionId: session.playSessionId,
  }));
  res.json({ count: sessions.length, sessions });
});

// DELETE /api/stream/sessions - Stop all active sessions
streamRoutes.delete('/stream/sessions', async (req: Request, res: Response) => {
  const { jellyfinClient } = req.app.locals;
  const jf = jellyfinClient as JellyfinClient;
  
  const count = activeSessions.size;
  const stopped: string[] = [];
  
  for (const [itemId, session] of activeSessions.entries()) {
    try {
      await jf.stopPlaybackSession(session.playSessionId);
      await jf.deleteTranscodingJob(session.playSessionId);
      stopped.push(session.playSessionId);
    } catch (err) {
      console.error(`[Stream] Failed to stop session ${session.playSessionId}:`, err);
    }
  }
  activeSessions.clear();
  progressStartedSessions.clear();
  lastActivityByItemId.clear();
  console.log(`[Stream] Stopped ${stopped.length}/${count} sessions`);
  res.json({ cleared: count, stopped });
});

// Helper to track a new session
export function trackSession(itemId: string, playSessionId: string, mediaSourceId?: string): void {
  activeSessions.set(itemId, { playSessionId, mediaSourceId: mediaSourceId || itemId });
  progressStartedSessions.delete(playSessionId);
}

// Helper to look up session info for an item
export function getSessionInfo(itemId: string): { playSessionId: string; mediaSourceId: string } | undefined {
  return activeSessions.get(itemId);
}

// Helper: rewrite M3U8 URLs to route through our proxy
function rewriteM3u8Urls(body: string, baseDir: string, playSessionId: string, deviceId: string): string {
  return body.replace(
    /^(?!#)(.*\.(m3u8|ts|vtt).*)$/gm,
    (match) => {
      // If already absolute URL, extract just the path+query portion
      let path: string;
      let query: string;
      
      if (match.startsWith('http')) {
        try {
          const url = new URL(match);
          path = url.pathname;
          query = url.search;
        } catch {
          return match;
        }
      } else {
        // Split into path and query
        const qIdx = match.indexOf('?');
        const matchPath = qIdx >= 0 ? match.substring(0, qIdx) : match;
        query = qIdx >= 0 ? match.substring(qIdx) : '';
        path = matchPath.startsWith('/') ? matchPath : `${baseDir}${matchPath}`;
      }

      // Ensure PlaySessionId and DeviceId are in the query string
      const params = new URLSearchParams(query);
      if (!params.has('PlaySessionId')) {
        params.set('PlaySessionId', playSessionId);
      }
      if (!params.has('DeviceId')) {
        params.set('DeviceId', deviceId);
      }
      
      // IMPORTANT: Strip StartTimeTicks from segment (.ts) URLs at rewrite time
      // Jellyfin only allows StartTimeTicks on the master playlist, not segments
      const isSegment = path.endsWith('.ts');
      if (isSegment) {
        params.delete('StartTimeTicks');
      }

      return `/api/stream/proxy${path}?${params.toString()}`;
    }
  );
}

// Allowed proxy path patterns — only Jellyfin video/subtitle paths
const ALLOWED_PROXY_PATTERNS = [
  /^\/Videos\//,
  /^\/video\//i,
];

// GET /api/stream/proxy/* - Proxy HLS sub-requests (child playlists & segments)
// All HLS requests go through this proxy so we can add auth headers.
// Must be registered before /stream/:itemId to avoid :itemId matching "proxy".
streamRoutes.get('/stream/proxy/*', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
    const baseUrl = jf.getBaseUrl();
    const authHeaders = jf.getProxyHeaders();
    const deviceId = jf.getDeviceId();

    const jellyfinPath = '/' + req.params[0];

    // Security: only allow known Jellyfin media paths through the proxy
    if (!ALLOWED_PROXY_PATTERNS.some(re => re.test(jellyfinPath))) {
      res.status(403).json({ error: 'Proxy path not allowed' });
      return;
    }
    const isSegment = jellyfinPath.endsWith('.ts') || jellyfinPath.endsWith('.mp4');
    const isPlaylist = jellyfinPath.includes('.m3u8');

    // Reconstruct query string from the raw URL
    const rawUrl = req.originalUrl;
    const qIndex = rawUrl.indexOf('?');
    let queryString = qIndex >= 0 ? rawUrl.substring(qIndex) : '';

    // IMPORTANT: Strip StartTimeTicks from segment requests - Jellyfin doesn't allow it
    // StartTimeTicks is only valid on the master playlist request
    if (isSegment && queryString.includes('StartTimeTicks')) {
      const params = new URLSearchParams(queryString.substring(1));
      params.delete('StartTimeTicks');
      queryString = '?' + params.toString();
    }

    const jellyfinUrl = `${baseUrl}${jellyfinPath}${queryString}`;
    
    // Request deduplication: if we already have a pending request for this exact URL,
    // wait for it instead of making a new one. This prevents FFmpeg conflicts when
    // hls.js retries failed requests rapidly.
    let responseData: { ok: boolean; status: number; headers: Headers; buffer: ArrayBuffer | null; text: string | null };
    
    const existingRequest = pendingRequests.get(jellyfinUrl);
    if (existingRequest) {
      responseData = await existingRequest;
    } else {
      // Create new request and track it
      const requestPromise = (async () => {
        console.log(`[Stream Proxy] ${isSegment ? 'Segment' : 'Playlist'}: ${jellyfinPath.substring(0, 80)}`);
        const response = await fetch(jellyfinUrl, { headers: authHeaders });
        
        let buffer: ArrayBuffer | null = null;
        let text: string | null = null;
        
        if (response.ok) {
          if (isPlaylist) {
            text = await response.text();
          } else {
            buffer = await response.arrayBuffer();
          }
        }
        
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          buffer,
          text,
        };
      })();
      
      pendingRequests.set(jellyfinUrl, requestPromise);
      
      try {
        responseData = await requestPromise;
      } finally {
        // Clean up after request completes (with small delay to catch rapid retries)
        setTimeout(() => pendingRequests.delete(jellyfinUrl), 100);
      }
    }

    if (!responseData.ok) {
      console.error(`[Stream Proxy] Jellyfin returned ${responseData.status}`);

      // On 500 errors, tell Jellyfin to stop the transcode job so cache can be freed
      if (responseData.status === 500) {
        const match = jellyfinPath.match(/\/Videos\/([^/]+)\//);
        const params = new URLSearchParams(queryString.substring(1));
        const playSessionId = params.get('PlaySessionId');
        if (match && playSessionId) {
          const itemId = match[1];
          console.log(`[Stream Proxy] Stopping Jellyfin transcode for ${itemId} due to 500 error`);
          try {
            await jf.stopPlaybackSession(playSessionId);
            await jf.deleteTranscodingJob(playSessionId);
          } catch (err) {
            console.error(`[Stream Proxy] Failed to stop session ${playSessionId}:`, err);
          }
          activeSessions.delete(itemId);
          lastActivityByItemId.delete(itemId);
        }
      }

      res.status(responseData.status).end();
      return;
    }

    // Track activity so idle cleanup doesn't stop active streams
    const pathMatch = jellyfinPath.match(/\/Videos\/([^/]+)\//);
    if (pathMatch) {
      lastActivityByItemId.set(pathMatch[1], Date.now());
    }

    // Forward relevant headers
    const contentType = responseData.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    // Extract PlaySessionId from query for URL rewriting
    const params = new URLSearchParams(queryString);
    const playSessionId = params.get('PlaySessionId') || '';

    // If it's an M3U8 playlist, rewrite internal URLs to go through proxy
    if (isPlaylist && responseData.text) {
      const baseDir = jellyfinPath.substring(0, jellyfinPath.lastIndexOf('/') + 1);
      res.send(rewriteM3u8Urls(responseData.text, baseDir, playSessionId, deviceId));
    } else if (responseData.buffer) {
      // Binary content (TS segments) — stream directly
      res.send(Buffer.from(responseData.buffer));
    } else {
      res.status(500).end();
    }
  } catch (err) {
    console.error(`[Stream Proxy] Error:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/stream/:itemId - Initiate HLS stream and return master playlist
// Note: We do NOT pass StartTimeTicks to Jellyfin because:
// 1. Jellyfin uses static HLS transcoding (not dynamic/on-demand)
// 2. StartTimeTicks causes FFmpeg conflicts (exit code 234) when switching videos
// 3. The seek is handled client-side by hls.js using startPosition
//
// If Jellyfin logs "FFmpeg exited with code 234" during VAAPI transcoding, that is a
// Jellyfin/FFmpeg/VAAPI issue (e.g. try disabling "Low power encoding" in Jellyfin
// transcoding settings). The client recovers by requesting a new stream session on 500s.
streamRoutes.get('/stream/:itemId', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
    const itemId = req.params.itemId as string;
    
    // Get quality, audio track, and subtitle track from query string. Omit for "auto" = prefer direct stream (no transcoding).
    const hasExplicitQuality = req.query.bitrate != null || req.query.maxWidth != null;
    const bitrate = req.query.bitrate ? parseInt(req.query.bitrate as string, 10) : 120000000;
    const maxWidth = req.query.maxWidth ? parseInt(req.query.maxWidth as string, 10) : undefined;
    const audioStreamIndex = req.query.audioStreamIndex != null
      ? parseInt(req.query.audioStreamIndex as string, 10)
      : undefined;
    const subtitleStreamIndex = req.query.subtitleStreamIndex != null
      ? parseInt(req.query.subtitleStreamIndex as string, 10)
      : undefined;
    const clientSupportsHevc = req.query.hevc === '1';

    const baseUrl = jf.getBaseUrl();
    const headers = jf.getProxyHeaders();
    const deviceId = jf.getDeviceId();

    // Reuse session from /api/playback when available (avoids a redundant Jellyfin
    // getPlaybackInfo round-trip). Fall back to getHlsStreamUrl for direct requests.
    const prefetchedPlaySessionId = req.query.playSessionId as string | undefined;
    const prefetchedMediaSourceId = req.query.mediaSourceId as string | undefined;

    let playSessionId: string;
    let mediaSourceId: string;
    let isHdrSource: boolean;
    if (prefetchedPlaySessionId && prefetchedMediaSourceId) {
      playSessionId = prefetchedPlaySessionId;
      mediaSourceId = prefetchedMediaSourceId;
      isHdrSource = false; // HDR detection only used for logging
    } else {
      const hlsInfo = await jf.getHlsStreamUrl(itemId);
      playSessionId = hlsInfo.playSessionId;
      mediaSourceId = hlsInfo.mediaSourceId;
      isHdrSource = hlsInfo.isHdrSource;
    }

    activeSessions.set(itemId, { playSessionId, mediaSourceId });
    lastActivityByItemId.set(itemId, Date.now());
    console.log(`[Stream Master] Session ${playSessionId} item=${itemId} directStream=${!hasExplicitQuality} bitrate=${bitrate} maxWidth=${maxWidth || 'auto'} hevc=${clientSupportsHevc} hdr=${isHdrSource} audioStreamIndex=${audioStreamIndex ?? 'default'} subtitleStreamIndex=${subtitleStreamIndex ?? 'off'}`);

    // Build Jellyfin HLS URL for browser playback via HLS.js.
    // Match Jellyfin Web behavior on capable clients: prefer direct-stream HEVC (including HDR).
    // If the browser can't do HEVC, fall back to h264 transcoding.
    // AllowStreamCopy tells FFmpeg to copy streams when input codec matches output.
    // VideoBitrate explicitly sets the encoding bitrate (Jellyfin bug: resolution is calculated
    // from bitrate, so setting a high VideoBitrate ensures high resolution output).
    const allowHevcStreamCopy = clientSupportsHevc;
    const videoCodec = allowHevcStreamCopy ? 'hevc,h264' : 'h264';
    const segmentContainer = allowHevcStreamCopy ? 'mp4' : 'ts';
    const params = new URLSearchParams({
      DeviceId: deviceId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      VideoCodec: videoCodec,
      AudioCodec: 'aac',
      MaxStreamingBitrate: String(bitrate),
      VideoBitrate: String(bitrate),
      TranscodingMaxAudioChannels: '2',
      SegmentContainer: segmentContainer,
      MinSegments: '2',
      BreakOnNonKeyFrames: 'true',
    });

    if (!hasExplicitQuality) {
      // Auto: allow stream copy where possible (same as Jellyfin web direct-stream preference).
      // MaxWidth/MaxHeight 3840x2160 tells Jellyfin to allow up to 4K resolution.
      params.set('AllowVideoStreamCopy', 'true');
      params.set('AllowAudioStreamCopy', 'true');
      params.set('EnableAutoStreamCopy', 'true');
      params.set('MaxWidth', '3840');
      params.set('MaxHeight', '2160');
    } else if (maxWidth) {
      params.set('MaxWidth', String(maxWidth));
    }
    if (audioStreamIndex != null && !Number.isNaN(audioStreamIndex)) {
      params.set('AudioStreamIndex', String(audioStreamIndex));
    }
    if (subtitleStreamIndex != null && !Number.isNaN(subtitleStreamIndex)) {
      params.set('SubtitleStreamIndex', String(subtitleStreamIndex));
    }

    const jellyfinUrl = `${baseUrl}/Videos/${itemId}/master.m3u8?${params}`;
    console.log(`[Stream Master] Fetching master playlist for item=${itemId}`);

    const response = await fetch(jellyfinUrl, { headers });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[Stream Master] Jellyfin returned ${response.status}: ${errorText.slice(0, 500)}`);
      try {
        await jf.stopPlaybackSession(playSessionId);
        await jf.deleteTranscodingJob(playSessionId);
      } catch (_err) { /* best-effort */ }
      activeSessions.delete(itemId);
      lastActivityByItemId.delete(itemId);
      res.status(response.status).json({ error: 'Jellyfin stream unavailable' });
      return;
    }

    // Forward content type
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    // Rewrite internal URLs to route through our proxy with session info
    const body = await response.text();
    const baseDir = `/Videos/${itemId}/`;
    res.send(rewriteM3u8Urls(body, baseDir, playSessionId, deviceId));
  } catch (err) {
    console.error(`[Stream Master] Error:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/images/:itemId/:imageType - Proxy Jellyfin images
streamRoutes.get('/images/:itemId/:imageType', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
    const itemId = req.params.itemId as string;
    const imageType = req.params.imageType as string;
    const maxWidth = parseInt(req.query.maxWidth as string || '400', 10);

    const baseUrl = jf.getBaseUrl();
    const headers = jf.getProxyHeaders();
    const url = `${baseUrl}/Items/${itemId}/Images/${imageType}?maxWidth=${maxWidth}&quality=90`;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      res.status(response.status).end();
      return;
    }

    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) {
      res.setHeader('Cache-Control', cacheControl);
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch {
    res.status(500).end();
  }
});

/**
 * Start periodic cleanup of idle transcoding sessions so Jellyfin's transcode cache
 * doesn't grow when clients leave without calling stop (e.g. closed tab).
 * Call once after app is ready (e.g. from index.ts).
 */
export function startTranscodeIdleCleanup(app: Express): void {
  setInterval(async () => {
    const jf = app.locals.jellyfinClient as JellyfinClient | undefined;
    if (!jf) return;

    const now = Date.now();
    const toStop: { itemId: string; playSessionId: string }[] = [];

    for (const [itemId, session] of activeSessions.entries()) {
      const last = lastActivityByItemId.get(itemId) ?? 0;
      if (now - last >= IDLE_THRESHOLD_MS) {
        toStop.push({ itemId, playSessionId: session.playSessionId });
      }
    }

    for (const { itemId, playSessionId } of toStop) {
      try {
        await jf.stopPlaybackSession(playSessionId);
        await jf.deleteTranscodingJob(playSessionId);
        progressStartedSessions.delete(playSessionId);
        activeSessions.delete(itemId);
        lastActivityByItemId.delete(itemId);
        console.log(`[Stream] Idle cleanup: stopped session ${playSessionId} for item ${itemId}`);
      } catch (err) {
        console.error(`[Stream] Idle cleanup failed for ${playSessionId}:`, err);
      }
    }
  }, IDLE_CLEANUP_INTERVAL_MS);

  console.log(`[Stream] Idle transcode cleanup every ${IDLE_CLEANUP_INTERVAL_MS / 1000}s (threshold ${IDLE_THRESHOLD_MS / 1000}s)`);
}
