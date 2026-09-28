import type { Express } from 'express';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { Readable } from 'stream';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import type { MediaProvider, HlsStreamOptions } from '../services/MediaProvider.js';
import * as queries from '../db/queries.js';
import { isRatingWithinCeiling } from '../utils/ratingCeiling.js';
import {
  fetchUpstreamShared, fetchWithHeaderTimeout, peekUpstream, purgeUpstreamSession, upstreamKey,
  stripClientAuthParams, injectStartOffset, segmentsAtOffset, sanitizeRenditions, CLIENT_AUTH_PARAMS,
  PREWARM_TEXT_TTL_MS, PREWARM_BINARY_TTL_MS,
} from '../services/hlsUpstream.js';

export const streamRoutes = Router();

// Track active play sessions so we can stop them when user leaves
// Maps itemId -> { playSessionId, mediaSourceId, clientKey }
// clientKey identifies the requesting device (its IP) so one device's new stream only
// replaces that device's old one — not another TV's.
export const activeSessions = new Map<string, { playSessionId: string; mediaSourceId: string; clientKey?: string }>();
const progressStartedSessions = new Set<string>(); // playSessionId set when PlaybackStart has been reported

/** The device a request came from — used to scope "replace my previous stream". */
export function clientKeyFor(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Sessions whose stream the player actually requested (/api/stream). A pre-warmed
// session that never gets here was abandoned (rapid surfing) and can be stopped.
const consumedSessions = new Set<string>();
export function markSessionConsumed(playSessionId: string): void {
  consumedSessions.add(playSessionId);
}
export function isSessionConsumed(playSessionId: string): boolean {
  return consumedSessions.has(playSessionId);
}

// Live join offset (seconds) per Jellyfin session — injected as #EXT-X-START into its
// media playlist so the player's first segment request is the live one.
const MAX_START_OFFSETS = 64;
const startOffsetBySession = new Map<string, number>();
export function setSessionStartOffset(playSessionId: string, offsetSec: number): void {
  startOffsetBySession.delete(playSessionId);
  startOffsetBySession.set(playSessionId, offsetSec);
  while (startOffsetBySession.size > MAX_START_OFFSETS) {
    startOffsetBySession.delete(startOffsetBySession.keys().next().value as string);
  }
}

/** Forget everything prevue holds for a session (pre-warmed segments, offsets, flags). */
export function releaseSessionState(playSessionId: string): void {
  purgeUpstreamSession(playSessionId);
  startOffsetBySession.delete(playSessionId);
  consumedSessions.delete(playSessionId);
  progressStartedSessions.delete(playSessionId);
}

// Last proxy activity (segment/playlist request) per itemId — used to stop idle transcodes
export const lastActivityByItemId = new Map<string, number>();

// IPTV session timing — used to build a sliding-window "live" playlist.
// Key = playSessionId, value = epoch ms when the IPTV channel was first requested + seekMs.
export const iptvSessionInfo = new Map<string, { startTime: number; seekMs: number }>();

/**
 * Trim a media playlist to a sliding window around the current "live" position,
 * turning a static VOD playlist into something IPTV players treat as live TV.
 *
 * Given `elapsedSeconds` since the session started, we keep only the 3 segments
 * closest to that position and strip VOD markers (#EXT-X-ENDLIST, PLAYLIST-TYPE).
 * The player sees a tiny window it can't scrub beyond, and re-fetches periodically
 * to get the next segments — exactly like a real live HLS stream.
 */
export function applyLiveWindow(playlist: string, elapsedSeconds: number): string {
  const lines = playlist.split('\n');

  // Parse segments and collect headers
  const segments: { extinf: string; url: string }[] = [];
  let targetDuration = 6;
  let mediaSequenceBase = 0;
  let version = 3;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      if (i + 1 < lines.length) {
        segments.push({ extinf: line, url: lines[i + 1].trim() });
        i++;
      }
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.split(':')[1], 10) || 6;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequenceBase = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-VERSION:')) {
      version = parseInt(line.split(':')[1], 10) || 3;
    }
  }

  if (segments.length === 0) return playlist; // not a media playlist

  // Walk segments to find the one at the current live position
  let cumDuration = 0;
  let nowIndex = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const dur = parseFloat(segments[i].extinf.match(/([\d.]+)/)?.[1] || '6');
    cumDuration += dur;
    if (cumDuration >= elapsedSeconds) {
      nowIndex = i;
      break;
    }
  }

  // Window: 3 segments ending at nowIndex (standard live HLS window ≈ 3× target duration)
  const windowSize = 3;
  const startIdx = Math.max(0, nowIndex - windowSize + 1);
  const windowSegs = segments.slice(startIdx, nowIndex + 1);

  // Rebuild as a live playlist (no ENDLIST, no PLAYLIST-TYPE)
  let result = '#EXTM3U\n';
  result += `#EXT-X-VERSION:${version}\n`;
  result += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
  result += `#EXT-X-MEDIA-SEQUENCE:${mediaSequenceBase + startIdx}\n`;

  for (const seg of windowSegs) {
    result += seg.extinf + '\n';
    result += seg.url + '\n';
  }

  return result;
}

const IDLE_CLEANUP_INTERVAL_MS = 2 * 60 * 1000;  // 2 minutes
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;         // stop if no activity for 5 minutes

function isProgressSharingEnabled(rawSetting: unknown): boolean {
  if (typeof rawSetting === 'boolean') return rawSetting;
  if (typeof rawSetting === 'string') {
    const normalized = rawSetting.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  if (typeof rawSetting === 'number') return rawSetting !== 0;
  return false;
}

function extractFirstChildPlaylistPath(masterPlaylist: string): string | null {
  const lines = masterPlaylist.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.includes('.m3u8')) return trimmed;
  }
  return null;
}

// POST /api/stream/stop - Stop playback and release server resources
// Client should call this when user leaves video or closes page
streamRoutes.post('/stream/stop', async (req: Request, res: Response) => {
  try {
    const { mediaProvider } = req.app.locals;
    const provider = mediaProvider as MediaProvider;
    const { itemId, playSessionId, positionMs, force } = req.body;

    // Use provided playSessionId or look up from active sessions. A stop naming a specific
    // session only touches the item's tracked entry when it IS that session — the item may
    // already be playing again under a newer session (codec fallback, preview → re-tune).
    const tracked = activeSessions.get(itemId);
    const sessionId = playSessionId || tracked?.playSessionId;
    const session = tracked && tracked.playSessionId === sessionId ? tracked : undefined;

    // Guard: when stop is called by itemId only (no specific playSessionId),
    // protect sessions that were just created or are actively streaming.
    // This prevents a race where the guide's PreviewPanel cleanup kills the
    // Player's newly-created stream session for the same item.
    // force=true bypasses this guard for intentional user actions (quality/subtitle/audio changes).
    if (!force && sessionId && !playSessionId && session) {
      const lastActivity = lastActivityByItemId.get(itemId);
      if (lastActivity && (Date.now() - lastActivity) < 3000) {
        console.log(`[Stream] Ignoring stop for item=${itemId} — session is actively streaming (created ${Date.now() - lastActivity}ms ago)`);
        res.json({ success: true, stopped: null, reason: 'session_active' });
        return;
      }
    }
    
    if (sessionId) {
      // Report playback stopped to Jellyfin if progress sharing is enabled and we have position data
      let reportedStop = false;
      if (positionMs != null && session) {
        const numericPositionMs = typeof positionMs === 'number' ? positionMs : Number(positionMs);
        const hasMeaningfulProgress = Number.isFinite(numericPositionMs) && numericPositionMs >= 1000;
        const { db } = req.app.locals;
        const enabled = isProgressSharingEnabled(queries.getSetting(db, 'share_playback_progress'));
        if (enabled && hasMeaningfulProgress) {
          // Jellyfin requires PlaybackStart before PlaybackStopped to persist position.
          // If the user watched less than 5 minutes, the progress endpoint never fired,
          // so we send PlaybackStart here first.
          if (!progressStartedSessions.has(sessionId)) {
            console.log(`[Stream Progress] Sending PlaybackStart (on stop) item=${itemId} session=${sessionId} positionMs=${numericPositionMs}`);
            await provider.reportPlaybackStart(itemId, sessionId, session.mediaSourceId, numericPositionMs).catch(() => {});
            progressStartedSessions.add(sessionId);
          }
          console.log(`[Stream Progress] Sending PlaybackStopped item=${itemId} session=${sessionId} positionMs=${numericPositionMs}`);
          await provider.reportPlaybackStopped(itemId, sessionId, session.mediaSourceId, numericPositionMs).catch(() => {});
          reportedStop = true;
        } else if (enabled && !hasMeaningfulProgress) {
          console.log(`[Stream Progress] Skipping stop progress report (position too small) item=${itemId} session=${sessionId} positionMs=${numericPositionMs}`);
        }
      }
      // Only send a bare session stop if reportPlaybackStopped didn't already hit
      // the same /Sessions/Playing/Stopped endpoint (avoids overwriting position data).
      if (!reportedStop) {
        await provider.stopPlaybackSession(sessionId);
      }
      await provider.deleteTranscodingJob(sessionId);
      releaseSessionState(sessionId);
      if (session) {
        activeSessions.delete(itemId);
        lastActivityByItemId.delete(itemId);
      }
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
    const { mediaProvider, db } = req.app.locals;
    const provider = mediaProvider as MediaProvider;

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
      await provider.reportPlaybackStart(itemId, session.playSessionId, session.mediaSourceId, positionMs);
      progressStartedSessions.add(session.playSessionId);
    }

    console.log(`[Stream Progress] Reporting playback progress item=${itemId} session=${session.playSessionId} positionMs=${positionMs}`);
    await provider.reportPlaybackProgress(
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

// POST /api/stream/completed - Item finished playing; tell the media server it's watched.
// Fires when the <video> element raises 'ended' (or when we cross the credits boundary
// for an item we know the user finished). Always runs regardless of share_playback_progress —
// without it, Plex viewCount never increments and the "Unwatched only" filter rots.
streamRoutes.post('/stream/completed', async (req: Request, res: Response) => {
  try {
    const { mediaProvider } = req.app.locals;
    const provider = mediaProvider as MediaProvider;
    const { itemId } = req.body ?? {};
    if (!itemId || typeof itemId !== 'string') {
      res.status(400).json({ error: 'itemId is required' });
      return;
    }
    await provider.markPlayed(itemId);
    res.json({ success: true });
  } catch (err) {
    console.error('[Stream] Error marking item completed:', err);
    res.json({ success: false, error: (err as Error).message });
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
  const { mediaProvider } = req.app.locals;
  const provider = mediaProvider as MediaProvider;
  
  const count = activeSessions.size;
  const stopped: string[] = [];
  
  for (const [itemId, session] of activeSessions.entries()) {
    try {
      await provider.stopPlaybackSession(session.playSessionId);
      await provider.deleteTranscodingJob(session.playSessionId);
      releaseSessionState(session.playSessionId);
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
export function trackSession(itemId: string, playSessionId: string, mediaSourceId?: string, clientKey?: string): void {
  activeSessions.set(itemId, { playSessionId, mediaSourceId: mediaSourceId || itemId, clientKey });
  progressStartedSessions.delete(playSessionId);
}

// Helper to look up session info for an item
export function getSessionInfo(itemId: string): { playSessionId: string; mediaSourceId: string } | undefined {
  return activeSessions.get(itemId);
}

// Helper: rewrite M3U8 URLs to route through our proxy
// `token` (prevue's API key, when the player authenticated via the URL) is carried onto every
// rewritten URL so a player that can't set headers — AVPlayer, hls.js — can fetch child
// playlists and segments natively. The proxy strips it before forwarding upstream.
export function rewriteM3u8Urls(body: string, baseDir: string, playSessionId: string, deviceId: string, token?: string): string {
  const rewriteResourceUrl = (resourceUrl: string): string => {
    // If already absolute URL, extract just the path+query portion
    let path: string;
    let query: string;

    if (resourceUrl.startsWith('http')) {
      try {
        const url = new URL(resourceUrl);
        path = url.pathname;
        query = url.search;
      } catch {
        return resourceUrl;
      }
    } else {
      // Split into path and query
      const qIdx = resourceUrl.indexOf('?');
      const relativePath = qIdx >= 0 ? resourceUrl.substring(0, qIdx) : resourceUrl;
      query = qIdx >= 0 ? resourceUrl.substring(qIdx) : '';
      path = relativePath.startsWith('/') ? relativePath : `${baseDir}${relativePath}`;
    }

    // Ensure PlaySessionId and DeviceId are in the query string
    const params = new URLSearchParams(query);
    if (!params.has('PlaySessionId')) {
      params.set('PlaySessionId', playSessionId);
    }
    if (!params.has('DeviceId')) {
      params.set('DeviceId', deviceId);
    }
    if (token) {
      params.set('token', token);
    }

    // IMPORTANT: Strip StartTimeTicks from segment URLs at rewrite time.
    // Jellyfin only allows StartTimeTicks on the master playlist, not segments.
    const isSegment = path.endsWith('.ts') || path.endsWith('.mp4');
    if (isSegment) {
      params.delete('StartTimeTicks');
    }

    return `/api/stream/proxy${path}?${params.toString()}`;
  };

  // Rewrite direct resource lines (variant playlists, media playlists, segments, vtt files).
  // Also include mp4 for fMP4 segment streams.
  const rewrittenDirectLines = body.replace(
    /^(?!#)(.*\.(m3u8|ts|vtt|mp4).*)$/gm,
    (match) => rewriteResourceUrl(match)
  );

  // Rewrite URI="..." attributes inside tag lines (e.g. #EXT-X-MEDIA subtitle URIs).
  // Without this, subtitle playlists referenced in tags bypass our proxy and fail to load.
  return rewrittenDirectLines.replace(
    /URI="([^"]+\.(?:m3u8|vtt|mp4|ts)[^"]*)"/g,
    (_whole, uri: string) => `URI="${rewriteResourceUrl(uri)}"`
  );
}

// Allowed proxy path patterns — Jellyfin and Plex video/subtitle paths
const ALLOWED_PROXY_PATTERNS = [
  /^\/Videos\//,                    // Jellyfin HLS segments & playlists
  /^\/video\//i,                    // Jellyfin video paths (case-insensitive)
  /^\/video\/:\//i,                 // Plex transcode paths
  /^\/library\/parts\//i,           // Plex direct stream parts
  /^\/library\/streams\//i,         // Plex external subtitle files (sidecar .srt/.ass/etc.)
  /^\/photo\/:\//i,                 // Plex image transcode
];

/** Resolve a proxied path + raw query into the upstream URL and its cache key. */
export function resolveUpstream(path: string, rawQuery: string, baseUrl: string): {
  url: string; key: string; token: string | undefined; params: URLSearchParams; isSegment: boolean; isPlaylist: boolean;
} {
  const isSegment = path.endsWith('.ts') || path.endsWith('.mp4');
  const isPlaylist = path.includes('.m3u8');
  const params = new URLSearchParams(rawQuery);
  const hadClientAuth = CLIENT_AUTH_PARAMS.some((p) => params.has(p));
  const token = stripClientAuthParams(params);
  // IMPORTANT: Strip StartTimeTicks from segment requests - Jellyfin doesn't allow it
  // StartTimeTicks is only valid on the master playlist request
  const hadStartTicks = isSegment && params.has('StartTimeTicks');
  if (isSegment) params.delete('StartTimeTicks');
  // Only re-serialize when something was removed, so upstream sees the original encoding.
  const query = hadClientAuth || hadStartTicks ? params.toString() : rawQuery;
  const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
  return { url, key: upstreamKey(path, params), token, params, isSegment, isPlaylist };
}

/** Same as resolveUpstream, from a URL as written into a rewritten playlist (/api/stream/proxy/...). */
function resolveProxied(proxied: string, baseUrl: string) {
  const rel = proxied.trim().replace(/^\/api\/stream\/proxy/, '');
  const q = rel.indexOf('?');
  const path = q >= 0 ? rel.substring(0, q) : rel;
  return { path, ...resolveUpstream(path, q >= 0 ? rel.substring(q + 1) : '', baseUrl) };
}

/** Session id carried by a proxied request (query param, or Plex's path segment). */
function sessionIdOf(upstreamPath: string, params: URLSearchParams): string | null {
  return params.get('PlaySessionId') || params.get('session')
    || upstreamPath.match(/\/session\/([0-9a-f-]+)\//i)?.[1] || null;
}

/** Track activity so idle cleanup doesn't stop active streams. */
function touchActivity(upstreamPath: string, sessionId: string | null): void {
  const jellyfinItemMatch = upstreamPath.match(/\/Videos\/([^/]+)\//);
  if (jellyfinItemMatch) {
    // Jellyfin: item ID is in the URL path
    lastActivityByItemId.set(jellyfinItemMatch[1], Date.now());
    return;
  }
  // Plex: session from query params OR from the URL path. Plex segment URLs
  // (e.g. /video/:/transcode/universal/session/{uuid}/base/0) are extension-less.
  if (!sessionId) return;
  for (const [proxyItemId, s] of activeSessions.entries()) {
    if (s.playSessionId === sessionId) {
      lastActivityByItemId.set(proxyItemId, Date.now());
      break;
    }
  }
}

/** Upstream said no. On 500, stop the transcode job so its cache can be freed. */
async function handleUpstreamFailure(provider: MediaProvider, status: number, upstreamPath: string, sessionId: string | null): Promise<void> {
  if (status !== 500) {
    console.error(`[Stream Proxy] Server returned ${status}`);
    return;
  }
  // Skip if the session was already cleaned up (race with in-flight segment requests).
  const match = upstreamPath.match(/\/Videos\/([^/]+)\//);
  const itemId = match?.[1]
    || (sessionId ? [...activeSessions.entries()].find(([, s]) => s.playSessionId === sessionId)?.[0] : undefined);
  if (itemId && activeSessions.has(itemId) && sessionId) {
    console.log(`[Stream Proxy] Stopping transcode for ${itemId} due to 500 error`);
    try {
      await provider.stopPlaybackSession(sessionId);
      await provider.deleteTranscodingJob(sessionId);
    } catch (err) {
      console.error(`[Stream Proxy] Failed to stop session ${sessionId}:`, err);
    }
    activeSessions.delete(itemId);
    lastActivityByItemId.delete(itemId);
    releaseSessionState(sessionId);
  } else {
    // Session already stopped — expected race condition with in-flight segments
    console.warn(`[Stream Proxy] Server returned 500 for already-stopped session (${itemId ?? 'unknown'})`);
  }
}

// GET /api/stream/proxy/* - Proxy HLS sub-requests (child playlists & segments)
// All HLS requests go through this proxy so we can add auth headers.
// Must be registered before /stream/:itemId to avoid :itemId matching "proxy".
//
// Playlists are fetched buffered (they get rewritten) and coalesced per URL. Segments are
// streamed straight through as they arrive — buffering a whole (possibly tens-of-MB) segment
// before sending its first byte added the full upstream transfer time to every segment —
// unless a pre-warm already fetched it, in which case it's served from memory.
streamRoutes.get('/stream/proxy/*', async (req: Request, res: Response) => {
  try {
    const { mediaProvider } = req.app.locals;
    const provider = mediaProvider as MediaProvider;
    const baseUrl = provider.getBaseUrl();
    const authHeaders = provider.getProxyHeaders();
    const deviceId = provider.getDeviceId();

    const upstreamPath = '/' + req.params[0];

    // Security: only allow known media server paths through the proxy
    if (!ALLOWED_PROXY_PATTERNS.some(re => re.test(upstreamPath))) {
      res.status(403).json({ error: 'Proxy path not allowed' });
      return;
    }

    // Reconstruct query string from the raw URL
    const rawUrl = req.originalUrl;
    const qIndex = rawUrl.indexOf('?');
    const up = resolveUpstream(upstreamPath, qIndex >= 0 ? rawUrl.substring(qIndex + 1) : '', baseUrl);
    const sessionId = sessionIdOf(upstreamPath, up.params);

    if (up.isPlaylist) {
      console.log(`[Stream Proxy] Playlist: ${upstreamPath.substring(0, 80)}`);
      const result = await fetchUpstreamShared(up.key, up.url, authHeaders, {
        kind: 'text', timeoutMs: 30_000, retries: 1, sessionId,
      });
      if (!result.ok) {
        await handleUpstreamFailure(provider, result.status, upstreamPath, sessionId);
        res.status(result.status).end();
        return;
      }
      touchActivity(upstreamPath, sessionId);
      if (result.contentType) res.setHeader('Content-Type', result.contentType);

      const playSessionId = up.params.get('PlaySessionId') || '';
      const baseDir = upstreamPath.substring(0, upstreamPath.lastIndexOf('/') + 1);
      let playlist = sanitizeRenditions(rewriteM3u8Urls(result.text ?? '', baseDir, playSessionId, deviceId, up.token));

      // IPTV live-stream treatment: present the playlist as a sliding-window
      // live stream so players can't scrub and start at the current position.
      if (req.query.iptv === '1') {
        const session = iptvSessionInfo.get(playSessionId);
        if (session) {
          // seekMs = where in the movie the schedule says "now" is.
          // elapsed = time since the IPTV player tuned in.
          // Together they give the absolute file position for the live edge.
          const positionSec = (session.seekMs / 1000) + (Date.now() - session.startTime) / 1000;
          playlist = applyLiveWindow(playlist, positionSec);
        }
        // Propagate iptv=1 to any sub-playlist URLs
        playlist = playlist.replace(
          /^(\/api\/stream\/proxy\/.*\.m3u8[^\n]*)/gm,
          (match) => match.includes('iptv=1') ? match : (match.includes('?') ? `${match}&iptv=1` : `${match}?iptv=1`)
        );
      } else if (/^\/Videos\//.test(upstreamPath)) {
        // Jellyfin: start the player at the live offset (Plex emits its own EXT-X-START).
        const offset = startOffsetBySession.get(playSessionId);
        if (offset) playlist = injectStartOffset(playlist, offset);
      }

      res.send(playlist);
      return;
    }

    // Binary (segments, init segments, subtitles). Pre-warmed? Serve from memory.
    const warmed = peekUpstream(up.key);
    if (warmed) {
      const result = await warmed.catch(() => null);
      if (result?.ok && result.buffer) {
        touchActivity(upstreamPath, sessionId);
        if (result.contentType) res.setHeader('Content-Type', result.contentType);
        res.send(result.buffer);
        return;
      }
      // Pre-warm failed — fall through to a fresh upstream fetch.
    }

    console.log(`[Stream Proxy] ${up.isSegment ? 'Segment' : 'Resource'}: ${upstreamPath.substring(0, 80)}`);
    // Stop pulling from the media server if the player goes away (seek, channel change).
    const clientGone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });
    // Segments may take a while if the server is transcoding; the timeout covers only the
    // wait for headers (retried on timeout), never the body transfer.
    const { response } = await fetchWithHeaderTimeout(
      up.url, authHeaders, up.isSegment ? 60_000 : 30_000, up.isSegment ? 2 : 1, clientGone.signal,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      await handleUpstreamFailure(provider, response.status, upstreamPath, sessionId);
      res.status(response.status).end();
      return;
    }
    touchActivity(upstreamPath, sessionId);

    // Forward relevant headers
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = response.headers.get('content-length');
    // fetch() transparently decodes compressed bodies, so a compressed length would be wrong.
    if (contentLength && !response.headers.get('content-encoding')) res.setHeader('Content-Length', contentLength);

    if (!response.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(response.body as unknown as WebReadableStream);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    if ((err as Error)?.name === 'AbortError') return; // player went away
    console.error(`[Stream Proxy] Error:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});

type QueryLike = Record<string, unknown>;

function intParam(q: QueryLike, name: string): number | undefined {
  const raw = q[name];
  if (raw == null || raw === '') return undefined;
  const n = parseInt(String(raw), 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Default "auto" bitrate — a request carrying exactly this is not an explicit quality choice. */
const AUTO_BITRATE = 120000000;

// ─── Plex: stream handler ─────────────────────────────
// Plex uses its own universal transcode endpoint. The URL is built entirely by
// PlexClient.getHlsStreamUrl() — we just fetch it, rewrite the child URLs
// through our proxy, and return the playlist. On 400 (stale session), we retry
// with backoff, finally with a fresh session.
//
// /api/playback pre-starts the session (startPlexSession) while the player is still
// processing its JSON; /api/stream then adopts that result via the playSessionId in
// the stream URL instead of starting from scratch.

/** Plex stream options from /api/stream query params (shared with the /api/playback pre-start). */
export function plexStreamOptions(q: QueryLike): HlsStreamOptions {
  const bitrate = intParam(q, 'bitrate');
  const maxWidth = intParam(q, 'maxWidth');
  const subtitleStreamIndex = intParam(q, 'subtitleStreamIndex');
  const audioStreamIndex = intParam(q, 'audioStreamIndex');
  return {
    ...(bitrate != null && { bitrate }),
    ...(maxWidth != null && { maxWidth }),
    ...(subtitleStreamIndex != null && { subtitleStreamIndex }),
    ...(audioStreamIndex != null && { audioStreamIndex }),
    ...(q.native === '1' && { native: true }),
  };
}

export interface PlexStartResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  /** Raw (un-rewritten) master playlist. */
  body: string;
  masterUrl: string;
  playSessionId: string;
}

/**
 * Start a Plex transcode session and fetch its master playlist. Replaces this device's
 * previous session first (a device plays one stream; the old one's transcode would
 * otherwise conflict). Other devices' sessions are left alone unless Plex keeps refusing,
 * in which case the final retry frees them too.
 */
export async function startPlexSession(
  provider: MediaProvider,
  itemId: string,
  clientKey: string,
  opts: HlsStreamOptions,
  startPositionTicks: number | undefined,
): Promise<PlexStartResult> {
  const headers = provider.getProxyHeaders();

  const stopSessions = async (filter: (s: { clientKey?: string }) => boolean) => {
    const stops: Promise<void>[] = [];
    for (const [activeItemId, session] of activeSessions) {
      if (!filter(session)) continue;
      console.log(`[Stream Plex] Stopping session ${session.playSessionId} (item=${activeItemId}) before new stream for item=${itemId}`);
      stops.push(provider.stopPlaybackSession(session.playSessionId).catch(() => {}));
      activeSessions.delete(activeItemId);
      lastActivityByItemId.delete(activeItemId);
      releaseSessionState(session.playSessionId);
    }
    await Promise.all(stops);
    return stops.length;
  };
  // No fixed settle delay after stopping: the 400-retry backoff below covers a slow release.
  await stopSessions((s) => s.clientKey === clientKey);

  let hlsInfo = await provider.getHlsStreamUrl(itemId, startPositionTicks, opts);
  let { playSessionId, mediaSourceId } = hlsInfo;
  let masterUrl = hlsInfo.url;

  activeSessions.set(itemId, { playSessionId, mediaSourceId, clientKey });
  lastActivityByItemId.set(itemId, Date.now());
  console.log(`[Stream Plex] Session ${playSessionId} item=${itemId} bitrate=${opts.bitrate ?? 'default'} maxWidth=${opts.maxWidth ?? 'auto'} subtitles=${opts.subtitleStreamIndex ?? 'off'} audio=${opts.audioStreamIndex ?? 'default'} native=${!!opts.native}`);
  console.log(`[Stream Plex] Fetching master playlist for item=${itemId}`);

  let response = await fetch(masterUrl, { headers });

  // Plex may return 400 if a transcode session hasn't fully released.
  // Retries 1-2: reuse the same session URL (the PUT already persisted stream selections,
  // so repeating them can conflict with Plex's cleanup). Only stop + re-request.
  // Final retry: free every session and generate a completely fresh, validated one.
  const retryDelays = [400, 1500, 3000];
  for (let retry = 0; !response.ok && response.status === 400 && retry < retryDelays.length; retry++) {
    const delay = retryDelays[retry];
    console.log(`[Stream Plex] Plex returned 400, stopping session ${playSessionId} and retrying (${retry + 1}/${retryDelays.length}) after ${delay}ms...`);
    await provider.stopPlaybackSession(playSessionId).catch(() => {});
    const isFinal = retry === retryDelays.length - 1;
    if (isFinal) {
      await stopSessions((s) => s.clientKey !== clientKey);
    }
    await new Promise(r => setTimeout(r, delay));
    if (isFinal) {
      releaseSessionState(playSessionId);
      hlsInfo = await provider.getHlsStreamUrl(itemId, startPositionTicks, { ...opts, sessionId: undefined, validate: true });
      playSessionId = hlsInfo.playSessionId;
      mediaSourceId = hlsInfo.mediaSourceId;
      masterUrl = hlsInfo.url;
      activeSessions.set(itemId, { playSessionId, mediaSourceId, clientKey });
      lastActivityByItemId.set(itemId, Date.now());
    }
    response = await fetch(masterUrl, { headers });
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    console.error(`[Stream Plex] Plex returned ${response.status}: ${errorText.slice(0, 500)}`);
    await provider.stopPlaybackSession(playSessionId).catch(() => {});
    if (activeSessions.get(itemId)?.playSessionId === playSessionId) {
      activeSessions.delete(itemId);
      lastActivityByItemId.delete(itemId);
    }
    releaseSessionState(playSessionId);
    return { ok: false, status: response.status, contentType: null, body: '', masterUrl, playSessionId };
  }

  return {
    ok: true,
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
    masterUrl,
    playSessionId,
  };
}

// Pre-started Plex sessions awaiting their /api/stream request, keyed by playSessionId.
// Single-use; an entry the player never claims is dropped (its session idles out).
const PLEX_PRESTART_TTL_MS = 60_000;
const plexPrestarts = new Map<string, { promise: Promise<PlexStartResult>; expiresAt: number }>();

export function registerPlexPrestart(playSessionId: string, promise: Promise<PlexStartResult>): void {
  const now = Date.now();
  for (const [k, v] of plexPrestarts) if (now > v.expiresAt) plexPrestarts.delete(k);
  promise.catch(() => {});
  plexPrestarts.set(playSessionId, { promise, expiresAt: now + PLEX_PRESTART_TTL_MS });
}

function takePlexPrestart(playSessionId: string): Promise<PlexStartResult> | undefined {
  const entry = plexPrestarts.get(playSessionId);
  plexPrestarts.delete(playSessionId);
  if (!entry || Date.now() > entry.expiresAt) return undefined;
  return entry.promise;
}

async function handlePlexStream(provider: MediaProvider, itemId: string, req: Request, res: Response): Promise<void> {
  const token = typeof req.query.token === 'string' ? req.query.token : undefined;
  const prestartedId = typeof req.query.playSessionId === 'string' ? req.query.playSessionId : undefined;

  let result: PlexStartResult | null = null;
  const prestart = prestartedId ? takePlexPrestart(prestartedId) : undefined;
  if (prestart) {
    result = await prestart.catch(() => null);
    if (result && !result.ok) result = null; // pre-start failed (and cleaned up) — start fresh
    if (result) console.log(`[Stream Plex] Using pre-started session ${result.playSessionId} for item=${itemId}`);
  }
  if (!result) {
    // Live offset (100ns ticks) set by /api/playback so Plex transcodes forward from the
    // join point instead of starting at 0 and letting the client seek into a cold session.
    result = await startPlexSession(provider, itemId, clientKeyFor(req), plexStreamOptions(req.query), intParam(req.query, 'startTimeTicks'));
  }

  if (!result.ok) {
    res.status(result.status).json({ error: 'Plex stream unavailable' });
    return;
  }
  markSessionConsumed(result.playSessionId);

  if (result.contentType) res.setHeader('Content-Type', result.contentType);
  // Derive baseDir from master URL path so relative child URLs resolve correctly.
  const masterPath = new URL(result.masterUrl).pathname;
  const baseDir = masterPath.substring(0, masterPath.lastIndexOf('/') + 1);
  res.send(sanitizeRenditions(rewriteM3u8Urls(result.body, baseDir, result.playSessionId, provider.getDeviceId(), token)));
}

// ─── Jellyfin: stream handler ─────────────────────────
// StartTimeTicks is passed on the master playlist request (only — it is stripped from
// child playlist/segment URLs by rewriteM3u8Urls and the proxy). Jellyfin does not rebase
// the stream; it starts ffmpeg at whichever segment the player requests FIRST. So the
// proxy injects #EXT-X-START at the live offset into the media playlist (the player's
// first request is then the live segment, not segment 0 followed by a seek that kills
// and restarts ffmpeg), and warmJellyfinStart requests that segment ahead of the player.
//
// If Jellyfin logs "FFmpeg exited with code 234" during VAAPI transcoding, that is a
// Jellyfin/FFmpeg/VAAPI issue (e.g. try disabling "Low power encoding" in Jellyfin
// transcoding settings). The client recovers by requesting a new stream session on 500s.

/**
 * Jellyfin master.m3u8 params from /api/stream query params. Shared with the
 * /api/playback pre-warm so both hit the same Jellyfin transcode (and cache entry).
 */
export function jellyfinMasterParams(
  q: QueryLike,
  ids: { deviceId: string; mediaSourceId: string; playSessionId: string },
): URLSearchParams {
  const requestedBitrate = intParam(q, 'bitrate');
  const maxWidth = intParam(q, 'maxWidth');
  const hasExplicitQuality = (requestedBitrate != null && requestedBitrate !== AUTO_BITRATE) || maxWidth != null;
  const bitrate = requestedBitrate ?? AUTO_BITRATE;
  const audioStreamIndex = intParam(q, 'audioStreamIndex');
  const subtitleStreamIndex = intParam(q, 'subtitleStreamIndex');
  const startTimeTicks = intParam(q, 'startTimeTicks');
  const clientSupportsHevc = q.hevc === '1';
  const native = q.native === '1';

  // Match Jellyfin Web behavior on capable clients: direct-stream HEVC (including HDR)
  // when the client can decode it. H.264 is listed FIRST: Jellyfin stream-copies any listed
  // codec but encodes to the first one, so when a transcode is unavoidable (quality cap,
  // burned-in subtitles, unsupported source codec) it uses the far faster H.264 encoder.
  // HEVC copy needs fMP4 segments.
  const videoCodec = clientSupportsHevc ? 'h264,hevc' : 'h264';
  const segmentContainer = clientSupportsHevc ? 'mp4' : 'ts';
  const params = new URLSearchParams({
    DeviceId: ids.deviceId,
    MediaSourceId: ids.mediaSourceId,
    PlaySessionId: ids.playSessionId,
    VideoCodec: videoCodec,
    // Native Apple players take AC3/E-AC3 and 5.1: copy surround audio instead of encoding
    // it to stereo AAC. Browsers get AAC stereo (MSE support for AC3 is spotty).
    AudioCodec: native ? 'aac,ac3,eac3' : 'aac',
    MaxStreamingBitrate: String(bitrate),
    // VideoBitrate explicitly sets the encoding bitrate (Jellyfin bug: resolution is calculated
    // from bitrate, so setting a high VideoBitrate ensures high resolution output).
    VideoBitrate: String(bitrate),
    TranscodingMaxAudioChannels: native ? '6' : '2',
    SegmentContainer: segmentContainer,
    // One short segment ready = playable.
    MinSegments: '1',
    SegmentLength: '3',
    BreakOnNonKeyFrames: 'true',
  });
  // Master playlist only — stripped from child/segment URLs (Jellyfin rejects it there).
  if (startTimeTicks != null && startTimeTicks > 0) {
    params.set('StartTimeTicks', String(startTimeTicks));
  }
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
  if (audioStreamIndex != null) {
    params.set('AudioStreamIndex', String(audioStreamIndex));
  }
  if (subtitleStreamIndex != null) {
    params.set('SubtitleStreamIndex', String(subtitleStreamIndex));
    // Text subtitles are delivered as HLS text tracks (subtitleMethod=Hls from
    // /api/playback) so video stream copy is preserved — burn-in (Encode) forces a
    // full re-encode and is reserved for image codecs (PGS/VobSub/...). Direct calls
    // without the param keep the safe burn-in default.
    params.set('SubtitleMethod', q.subtitleMethod === 'Hls' ? 'Hls' : 'Encode');
  }
  return params;
}

/** Fetch a Jellyfin master playlist through the shared upstream table (pre-warm aware). */
export function fetchJellyfinMaster(
  provider: MediaProvider,
  itemId: string,
  params: URLSearchParams,
  lingerMs?: number,
) {
  const path = `/Videos/${itemId}/master.m3u8`;
  return fetchUpstreamShared(upstreamKey(path, params), `${provider.getBaseUrl()}${path}?${params}`, provider.getProxyHeaders(), {
    kind: 'text', timeoutMs: 30_000, retries: 1, lingerMs, sessionId: params.get('PlaySessionId'),
  });
}

/**
 * Get a Jellyfin transcode producing the live segment before the player asks for it:
 * master → first child playlist → the segment containing `offsetSec` (then the next one).
 * Everything lands in the upstream table, so the player's own requests (which follow
 * within a few hundred ms) are served from memory or join the in-flight fetch.
 *
 * Order matters for fMP4: a request for the init segment (-1.mp4) makes Jellyfin start
 * ffmpeg at 0, so the init is fetched only after the live segment — by then ffmpeg (started
 * at the live segment) has written the init file and Jellyfin just serves it. The player's
 * init request joins that deferred fetch instead of racing ahead of it.
 */
export async function warmJellyfinStart(
  provider: MediaProvider,
  itemId: string,
  masterParams: URLSearchParams,
  offsetSec: number,
): Promise<void> {
  const baseUrl = provider.getBaseUrl();
  const headers = provider.getProxyHeaders();
  const deviceId = provider.getDeviceId();
  const playSessionId = masterParams.get('PlaySessionId') || '';

  const master = await fetchJellyfinMaster(provider, itemId, masterParams, PREWARM_TEXT_TTL_MS);
  if (!master.ok || !master.text) return;
  const child = extractFirstChildPlaylistPath(master.text);
  if (!child) return;

  const baseDir = `/Videos/${itemId}/`;
  const childUp = resolveProxied(rewriteM3u8Urls(child, baseDir, playSessionId, deviceId), baseUrl);
  const childRes = await fetchUpstreamShared(childUp.key, childUp.url, headers, {
    kind: 'text', timeoutMs: 30_000, retries: 1, lingerMs: PREWARM_TEXT_TTL_MS, sessionId: playSessionId,
  });
  if (!childRes.ok || !childRes.text) return;

  const childBaseDir = childUp.path.substring(0, childUp.path.lastIndexOf('/') + 1);
  const { init, segment, next } = segmentsAtOffset(
    rewriteM3u8Urls(childRes.text, childBaseDir, playSessionId, deviceId), offsetSec,
  );
  if (!segment) return;

  const warm = (proxied: string, after?: Promise<unknown>) => {
    const u = resolveProxied(proxied, baseUrl);
    return fetchUpstreamShared(u.key, u.url, headers, {
      kind: 'binary', timeoutMs: 60_000, retries: 1, lingerMs: PREWARM_BINARY_TTL_MS, sessionId: playSessionId, after,
    });
  };
  const live = warm(segment);
  if (init) void warm(init, live).catch(() => {});
  await live.catch(() => null);
  if (next) void warm(next).catch(() => {});
}

async function handleJellyfinStream(provider: MediaProvider, itemId: string, req: Request, res: Response): Promise<void> {
  const deviceId = provider.getDeviceId();
  const token = typeof req.query.token === 'string' ? req.query.token : undefined;
  const clientKey = clientKeyFor(req);

  // Reuse session from /api/playback when available (avoids a redundant Jellyfin
  // getPlaybackInfo round-trip). Fall back to getHlsStreamUrl for direct requests.
  const prefetchedPlaySessionId = req.query.playSessionId as string | undefined;
  const prefetchedMediaSourceId = req.query.mediaSourceId as string | undefined;

  let playSessionId: string;
  let mediaSourceId: string;
  let isHdrSource = false; // HDR detection only used for logging
  if (prefetchedPlaySessionId && prefetchedMediaSourceId) {
    playSessionId = prefetchedPlaySessionId;
    mediaSourceId = prefetchedMediaSourceId;
  } else {
    const hlsInfo = await provider.getHlsStreamUrl(itemId);
    playSessionId = hlsInfo.playSessionId;
    mediaSourceId = hlsInfo.mediaSourceId;
    isHdrSource = hlsInfo.isHdrSource;
  }

  const startTimeTicks = intParam(req.query, 'startTimeTicks');
  const offsetSec = startTimeTicks && startTimeTicks > 0 ? startTimeTicks / 10_000_000 : 0;
  let params = jellyfinMasterParams(req.query, { deviceId, mediaSourceId, playSessionId });

  const begin = () => {
    activeSessions.set(itemId, { playSessionId, mediaSourceId, clientKey });
    lastActivityByItemId.set(itemId, Date.now());
    markSessionConsumed(playSessionId);
    if (offsetSec > 0) setSessionStartOffset(playSessionId, offsetSec);
  };
  begin();
  console.log(`[Stream Master] Session ${playSessionId} item=${itemId} videoCodec=${params.get('VideoCodec')} audioCodec=${params.get('AudioCodec')} bitrate=${params.get('MaxStreamingBitrate')} maxWidth=${params.get('MaxWidth') || 'auto'} hdr=${isHdrSource} audioStreamIndex=${params.get('AudioStreamIndex') ?? 'default'} subtitleStreamIndex=${params.get('SubtitleStreamIndex') ?? 'off'}`);
  console.log(`[Stream Master] Fetching master playlist for item=${itemId}`);

  // Usually already fetched (or in flight) by the /api/playback pre-warm.
  let response = await fetchJellyfinMaster(provider, itemId, params);

  if (!response.ok && prefetchedMediaSourceId) {
    // The prefetched ids come from prevue's library cache, which can go stale (file replaced
    // → new MediaSourceId). Retry once with a fresh PlaybackInfo from Jellyfin.
    console.warn(`[Stream Master] Jellyfin returned ${response.status} for cached session ids; retrying with fresh PlaybackInfo`);
    releaseSessionState(playSessionId);
    try {
      const hlsInfo = await provider.getHlsStreamUrl(itemId);
      playSessionId = hlsInfo.playSessionId;
      mediaSourceId = hlsInfo.mediaSourceId;
      params = jellyfinMasterParams(req.query, { deviceId, mediaSourceId, playSessionId });
      begin();
      response = await fetchJellyfinMaster(provider, itemId, params);
    } catch (err) {
      console.error('[Stream Master] Fresh PlaybackInfo failed:', err);
    }
  }

  if (!response.ok) {
    console.error(`[Stream Master] Jellyfin returned ${response.status}`);
    try {
      await provider.stopPlaybackSession(playSessionId);
      await provider.deleteTranscodingJob(playSessionId);
    } catch (_err) { /* best-effort */ }
    activeSessions.delete(itemId);
    lastActivityByItemId.delete(itemId);
    releaseSessionState(playSessionId);
    res.status(response.status).json({ error: 'Jellyfin stream unavailable' });
    return;
  }

  // Forward content type
  if (response.contentType) res.setHeader('Content-Type', response.contentType);

  // Rewrite internal URLs to route through our proxy with session info
  const body = response.text ?? '';
  const rewrittenMaster = sanitizeRenditions(rewriteM3u8Urls(body, `/Videos/${itemId}/`, playSessionId, deviceId, token));

  // Make sure the live segment is being produced (a no-op if /api/playback already warmed it).
  void warmJellyfinStart(provider, itemId, params, offsetSec).catch(() => {});

  res.send(rewrittenMaster);
}

// Validates that an item ID matches expected format (Jellyfin UUID or Plex numeric ID)
const VALID_ITEM_ID = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$|^\d+$/i;
const ALLOWED_IMAGE_TYPES = new Set(['Primary', 'Backdrop', 'Thumb', 'Art', 'Banner', 'Logo', 'Guide']);

// GET /api/stream/:itemId - Initiate HLS stream and return master playlist
streamRoutes.get('/stream/:itemId', async (req: Request, res: Response) => {
  try {
    const { mediaProvider } = req.app.locals;
    const provider = mediaProvider as MediaProvider;
    const itemId = req.params.itemId as string;

    if (!VALID_ITEM_ID.test(itemId)) {
      res.status(400).json({ error: 'Invalid item ID format' });
      return;
    }

    // Enforce the caller's rating ceiling here too — a direct/deep-link request to
    // /api/stream must not bypass what the guide already hides. The library cache
    // (provider.getItem) is a synchronous lookup, so this adds no extra round-trip.
    // Fails closed: if the item isn't in the cache and a ceiling is set, we can't
    // confirm it's safe, so it's blocked (same fail-closed rule as isRatingWithinCeiling).
    const ceiling = req.activeProfile?.max_rating ?? null;
    if (ceiling !== null) {
      const item = provider.getItem(itemId);
      const rating = item?.OfficialRating ?? null;
      if (!isRatingWithinCeiling(rating, ceiling)) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }
    }

    if (provider.providerType === 'plex') {
      await handlePlexStream(provider, itemId, req, res);
    } else {
      await handleJellyfinStream(provider, itemId, req, res);
    }
  } catch (err) {
    console.error(`[Stream Master] Error:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/images/:itemId/:imageType - Proxy media server images (Jellyfin & Plex)
streamRoutes.get('/images/:itemId/:imageType', async (req: Request, res: Response) => {
  try {
    const { mediaProvider } = req.app.locals;
    const provider = mediaProvider as MediaProvider;
    const itemId = req.params.itemId as string;
    const imageType = req.params.imageType as string;

    if (!VALID_ITEM_ID.test(itemId)) {
      res.status(400).json({ error: 'Invalid item ID format' });
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.has(imageType)) {
      res.status(400).json({ error: 'Invalid image type' });
      return;
    }

    const maxWidth = parseInt(req.query.maxWidth as string || '400', 10);

    // Use provider's getImageUrl which handles both Jellyfin and Plex URL formats
    const imageUrl = provider.getImageUrl(itemId, imageType, maxWidth);
    if (!imageUrl) {
      res.status(404).end();
      return;
    }
    const headers = provider.getProxyHeaders();

    const response = await fetch(imageUrl, { headers });
    if (!response.ok) {
      if (provider.providerType === 'plex') {
        console.warn(`[Images] Plex image failed: ${response.status} for item=${itemId} type=${imageType} url=${imageUrl.substring(0, 120)}`);
      }
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
    const provider = app.locals.mediaProvider as MediaProvider | undefined;
    if (!provider) return;

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
        await provider.stopPlaybackSession(playSessionId);
        await provider.deleteTranscodingJob(playSessionId);
        releaseSessionState(playSessionId);
        activeSessions.delete(itemId);
        lastActivityByItemId.delete(itemId);
        console.log(`[Stream] Idle cleanup: stopped session ${playSessionId} for item ${itemId}`);
      } catch (err) {
        console.error(`[Stream] Idle cleanup failed for ${playSessionId}:`, err);
      }
    }

    // Clean up orphaned IPTV session info entries whose playSessionId
    // no longer corresponds to any active session
    const activePlaySessionIds = new Set(
      Array.from(activeSessions.values()).map(s => s.playSessionId)
    );
    for (const psId of iptvSessionInfo.keys()) {
      if (!activePlaySessionIds.has(psId)) {
        iptvSessionInfo.delete(psId);
      }
    }

    // Clean up orphaned progressStartedSessions
    for (const psId of progressStartedSessions) {
      if (!activePlaySessionIds.has(psId)) {
        progressStartedSessions.delete(psId);
      }
    }
  }, IDLE_CLEANUP_INTERVAL_MS);

  console.log(`[Stream] Idle transcode cleanup every ${IDLE_CLEANUP_INTERVAL_MS / 1000}s (threshold ${IDLE_THRESHOLD_MS / 1000}s)`);
}
