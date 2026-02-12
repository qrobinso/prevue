import { Router } from 'express';
import type { Request, Response } from 'express';
import type { JellyfinClient } from '../services/JellyfinClient.js';

export const streamRoutes = Router();

// Track active play sessions so we can stop them when user leaves
// Maps itemId -> playSessionId
const activeSessions = new Map<string, string>();

// Request deduplication: coalesce concurrent requests for the same URL
// This prevents multiple FFmpeg processes from starting when hls.js retries
const pendingRequests = new Map<string, Promise<{ ok: boolean; status: number; headers: Headers; buffer: ArrayBuffer | null; text: string | null }>>();

// POST /api/stream/stop - Stop playback and release server resources
// Client should call this when user leaves video or closes page
streamRoutes.post('/stream/stop', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
    const { itemId, playSessionId } = req.body;
    
    // Use provided playSessionId or look up from active sessions
    const sessionId = playSessionId || activeSessions.get(itemId);
    
    if (sessionId) {
      // Stop the playback session and delete transcoding job
      await jf.stopPlaybackSession(sessionId);
      await jf.deleteTranscodingJob(sessionId);
      activeSessions.delete(itemId);
      
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

// GET /api/stream/sessions - List active sessions (debugging)
streamRoutes.get('/stream/sessions', (_req: Request, res: Response) => {
  const sessions = Array.from(activeSessions.entries()).map(([itemId, playSessionId]) => ({
    itemId,
    playSessionId,
  }));
  res.json({ count: sessions.length, sessions });
});

// DELETE /api/stream/sessions - Stop all active sessions
streamRoutes.delete('/stream/sessions', async (req: Request, res: Response) => {
  const { jellyfinClient } = req.app.locals;
  const jf = jellyfinClient as JellyfinClient;
  
  const count = activeSessions.size;
  const stopped: string[] = [];
  
  for (const [itemId, playSessionId] of activeSessions.entries()) {
    try {
      await jf.stopPlaybackSession(playSessionId);
      await jf.deleteTranscodingJob(playSessionId);
      stopped.push(playSessionId);
    } catch (err) {
      console.error(`[Stream] Failed to stop session ${playSessionId}:`, err);
    }
  }
  
  activeSessions.clear();
  console.log(`[Stream] Stopped ${stopped.length}/${count} sessions`);
  res.json({ cleared: count, stopped });
});

// Helper to track a new session
export function trackSession(itemId: string, playSessionId: string): void {
  activeSessions.set(itemId, playSessionId);
}

// Helper: rewrite M3U8 URLs to route through our proxy
function rewriteM3u8Urls(body: string, baseDir: string, playSessionId: string, deviceId: string): string {
  return body.replace(
    /^(?!#)(.*\.m3u8.*|.*\.ts.*)$/gm,
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
    const isSegment = jellyfinPath.endsWith('.ts');
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
      console.log(`[Stream Proxy] Deduping request: ${jellyfinPath.substring(0, 50)}...`);
      responseData = await existingRequest;
    } else {
      // Create new request and track it
      const requestPromise = (async () => {
        console.log(`[Stream Proxy] ${isSegment ? 'Segment' : 'Playlist'}: ${jellyfinUrl.substring(0, 150)}...`);
        const response = await fetch(jellyfinUrl, { headers: authHeaders });
        
        let buffer: ArrayBuffer | null = null;
        let text: string | null = null;
        
        if (response.ok) {
          if (isPlaylist) {
            text = await response.text();
            // Log the child playlist content to debug segment timing
            if (jellyfinPath.includes('main.m3u8')) {
              console.log(`[Stream Proxy] main.m3u8 content:\n${text?.substring(0, 1000) || 'empty'}`);
            }
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
      
      // On 500 errors, clear the session cache for this item
      if (responseData.status === 500) {
        const match = jellyfinPath.match(/\/Videos\/([^/]+)\//);
        if (match) {
          const itemId = match[1];
          if (activeSessions.has(itemId)) {
            console.log(`[Stream Proxy] Clearing cached session for ${itemId} due to 500 error`);
            activeSessions.delete(itemId);
          }
        }
      }
      
      res.status(responseData.status).end();
      return;
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
streamRoutes.get('/stream/:itemId', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
    const itemId = req.params.itemId as string;
    
    // Get quality parameters from query string
    const bitrate = req.query.bitrate ? parseInt(req.query.bitrate as string, 10) : 120000000;
    const maxWidth = req.query.maxWidth ? parseInt(req.query.maxWidth as string, 10) : undefined;

    const baseUrl = jf.getBaseUrl();
    const headers = jf.getProxyHeaders();
    const deviceId = jf.getDeviceId();

    // Get playback info without startTicks - let Jellyfin transcode from beginning
    const hlsInfo = await jf.getHlsStreamUrl(itemId);
    const playSessionId = hlsInfo.playSessionId;
    
    // Track this session so we can stop it when user leaves
    activeSessions.set(itemId, playSessionId);
    
    console.log(`[Stream Master] Created session: ${playSessionId} for item: ${itemId}, bitrate: ${bitrate}, maxWidth: ${maxWidth || 'auto'}`);

    // Build Jellyfin HLS URL with session info and quality settings
    const params = new URLSearchParams({
      DeviceId: deviceId,
      MediaSourceId: itemId,
      PlaySessionId: playSessionId,
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      MaxStreamingBitrate: String(bitrate),
      TranscodingMaxAudioChannels: '2',
      SegmentContainer: 'ts',
      MinSegments: '2',
      BreakOnNonKeyFrames: 'true',
    });
    
    // Add max width/height if specified (for resolution limiting)
    if (maxWidth) {
      params.set('MaxWidth', String(maxWidth));
    }

    const jellyfinUrl = `${baseUrl}/Videos/${itemId}/master.m3u8?${params}`;
    console.log(`[Stream Master] Fetching: ${jellyfinUrl}`);

    const response = await fetch(jellyfinUrl, { headers });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[Stream Master] Jellyfin returned ${response.status}: ${errorText.slice(0, 500)}`);
      // Clear session cache on error
      activeSessions.delete(itemId);
      res.status(response.status).json({ error: 'Jellyfin stream unavailable' });
      return;
    }

    // Forward content type
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    // Rewrite internal URLs to route through our proxy with session info
    const body = await response.text();
    console.log(`[Stream Master] M3U8 content:\n${body.substring(0, 500)}`);
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
