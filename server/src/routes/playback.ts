import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import type { MediaProvider } from '../services/MediaProvider.js';
import { randomUUID } from 'crypto';
import {
  activeSessions, trackSession, lastActivityByItemId, clientKeyFor, isSessionConsumed, releaseSessionState,
  jellyfinMasterParams, warmJellyfinStart, plexStreamOptions, startPlexSession, registerPlexPrestart,
} from './stream.js';
import { isRatingWithinCeiling } from '../utils/ratingCeiling.js';
import { isAuthEnabled, getApiKey } from '../middleware/auth.js';

export const playbackRoutes = Router();

// Image-based subtitle codecs can only be burned into the video (full re-encode).
// Text codecs are delivered as HLS text tracks instead, preserving video stream copy
// and the fast ~1-2s tune-in. Mirrors isImageSubtitle in the client.
const IMAGE_SUBTITLE_CODECS = new Set(['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'hdmvsub', 'vobsub']);
export function subtitleMethodFor(codec: string | null): 'Hls' | 'Encode' {
  return codec && IMAGE_SUBTITLE_CODECS.has(codec.toLowerCase()) ? 'Encode' : 'Hls';
}

// Track each device's last pre-warmed session so we can stop it when that device starts
// another one before claiming it. Prevents orphaned FFmpeg transcodes during rapid switching.
const lastPrewarmedByClient = new Map<string, { playSessionId: string; itemId: string }>();

// ── Tracks/session cache (TTL 60s) — prevents redundant media-server calls on rapid channel switches ──
const TRACKS_CACHE_TTL_MS = 60_000;
const tracksCache = new Map<string, { data: TracksAndSession; expiresAt: number }>();

// ── Media segments (intro/outro) cache — static per item, so keep it for hours ──
const SEGMENTS_CACHE_TTL_MS = 6 * 60 * 60_000;
/** Don't hold a tune hostage to a slow MediaSegments call; a miss just means no credits marker. */
const SEGMENTS_WAIT_MS = 300;
const segmentsCache = new Map<string, { outroStartMs: number | null; expiresAt: number }>();

async function getOutroStartMs(provider: MediaProvider, itemId: string): Promise<number | null> {
  const now = Date.now();
  const hit = segmentsCache.get(itemId);
  if (hit && now < hit.expiresAt) return hit.outroStartMs;
  const fetchPromise = provider.getMediaSegments(itemId).then((r) => {
    if (segmentsCache.size > 2000) segmentsCache.clear();
    segmentsCache.set(itemId, { outroStartMs: r.outroStartMs, expiresAt: Date.now() + SEGMENTS_CACHE_TTL_MS });
    return r.outroStartMs;
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SEGMENTS_WAIT_MS).unref?.());
  return Promise.race([fetchPromise, timeout]).catch(() => null);
}

type TracksAndSession = {
  audio_tracks: { index: number; language: string; name: string }[];
  subtitle_tracks: { index: number; language: string; name: string; codec: string | null; forced: boolean; key: string | null }[];
  playSessionId: string;
  mediaSourceId: string;
};

/** A fresh play session id (32 hex). Jellyfin and Plex both accept any id. */
function newSessionId(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * Jellyfin: tracks + media source straight from prevue's library cache. The library sync
 * already pulls MediaSources (with MediaStreams), so this skips the PlaybackInfo POST —
 * Jellyfin's slowest playback call — on every tune. null → not cached; use PlaybackInfo.
 */
function tracksFromLibrary(provider: MediaProvider, itemId: string): TracksAndSession | null {
  if (provider.providerType !== 'jellyfin') return null;
  const item = provider.getItem(itemId) as { MediaSources?: PlaybackInfoSource[] } | undefined;
  const source = item?.MediaSources?.[0];
  if (!source?.Id || !Array.isArray(source.MediaStreams) || source.MediaStreams.length === 0) return null;
  return {
    ...tracksFromStreams(source.MediaStreams),
    playSessionId: newSessionId(),
    mediaSourceId: source.Id,
  };
}

type PlaybackInfoSource = NonNullable<Awaited<ReturnType<MediaProvider['getPlaybackInfo']>>['MediaSources']>[number];

function tracksFromStreams(streams: NonNullable<PlaybackInfoSource['MediaStreams']>): Pick<TracksAndSession, 'audio_tracks' | 'subtitle_tracks'> {

  const audio_tracks = streams
    .filter((s) => (s.Type || '').toLowerCase() === 'audio')
    .map((s) => ({
      index: s.Index ?? -1,
      language: (s.Language ?? 'und').toLowerCase(),
      name: s.DisplayTitle ?? s.Title ?? `Track ${(s.Index ?? 0) + 1}`,
    }))
    .filter((t) => t.index >= 0);

  const subtitle_tracks = streams
    .filter((s) => (s.Type || '').toLowerCase() === 'subtitle')
    .map((s) => ({
      index: s.Index ?? -1,
      language: (s.Language ?? 'und').toLowerCase(),
      name: s.DisplayTitle ?? s.Title ?? `Subtitle ${(s.Index ?? 0) + 1}`,
      codec: s.Codec ?? null,
      forced: s.IsForced ?? false,
      key: s.Key ?? null,
    }))
    .filter((t) => t.index >= 0);

  return { audio_tracks, subtitle_tracks };
}

// Extract audio/subtitle tracks and session info from the media server in a single API call.
// Returns PlaySessionId and MediaSourceId so the stream endpoint can skip a redundant call.
async function getTracksAndSession(mediaProvider: MediaProvider, itemId: string): Promise<TracksAndSession> {
  const playbackInfo = await mediaProvider.getPlaybackInfo(itemId);
  const mediaSource = playbackInfo.MediaSources?.[0];
  const playSessionId = (playbackInfo as Record<string, unknown>).PlaySessionId as string || '';
  const mediaSourceId = mediaSource?.Id as string || itemId;
  return { ...tracksFromStreams(mediaSource?.MediaStreams ?? []), playSessionId, mediaSourceId };
}

/**
 * When prevue's API key is on, carry it on the stream URL as `token` (the proxy propagates
 * it into every child playlist / segment URL and strips it before forwarding upstream).
 * Lets AVPlayer and hls.js play keyed servers natively — they can't add headers to segment
 * requests. Only ever returned to a caller that already authenticated with the key.
 */
function withClientToken(url: string): string {
  const key = isAuthEnabled() ? getApiKey() : undefined;
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(key)}`;
}

// GET /api/playback/:channelId - Get streaming info for current program
playbackRoutes.get('/:channelId', async (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine, mediaProvider } = req.app.locals;
    const provider = mediaProvider as MediaProvider;
    const channelId = parseInt(req.params.channelId as string, 10);
    if (Number.isNaN(channelId) || channelId < 1) { res.status(400).json({ error: 'Invalid channel id' }); return; }
    const se = scheduleEngine as ScheduleEngine;

    const channel = queries.getChannelById(db, channelId);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const current = se.getCurrentProgram(channelId);
    if (!current) {
      res.status(404).json({ error: 'No program currently airing' });
      return;
    }

    const { program, next, seekMs } = current;

    // Enforce the caller's rating ceiling. A direct/deep-link request to this
    // channel must not surface a stream URL for content above the profile's
    // ceiling — the guide already hides it, but this is the actual gate.
    const ceiling = req.activeProfile?.max_rating ?? null;
    if (!isRatingWithinCeiling(program.rating, ceiling)) {
      res.status(404).json({ error: 'No program currently airing' });
      return;
    }

    if (program.type === 'interstitial') {
      res.json({
        stream_url: null,
        seek_position_ms: seekMs,
        program,
        next_program: next,
        channel,
        is_interstitial: true,
        audio_tracks: [],
        subtitle_tracks: [] as { index: number; language: string; name: string; codec: string | null; forced: boolean; key: string | null }[],
        subtitle_index: null,
        outro_start_ms: null,
      });
      return;
    }

    // Now Playing channel: serve the trailer through a dedicated yt-dlp-backed route.
    // Skip the Jellyfin/Plex playback-info path entirely.
    if (program.type === 'trailer') {
      const trailerSeekMs = Math.max(0, seekMs);
      res.json({
        stream_url: withClientToken(`/api/stream/trailer/${channelId}`),
        seek_position_ms: trailerSeekMs,
        seek_position_seconds: trailerSeekMs / 1000,
        program,
        next_program: next,
        channel,
        is_interstitial: false,
        is_trailer: true,
        audio_tracks: [],
        audio_stream_index: null,
        subtitle_tracks: [] as { index: number; language: string; name: string; codec: string | null; forced: boolean; key: string | null }[],
        subtitle_index: null,
        outro_start_ms: null,
      });
      return;
    }

    // Get quality and audio track from query
    const bitrate = req.query.bitrate ? parseInt(req.query.bitrate as string, 10) : undefined;
    const maxWidth = req.query.maxWidth ? parseInt(req.query.maxWidth as string, 10) : undefined;
    let audioStreamIndex: number | undefined =
      req.query.audioStreamIndex != null
        ? parseInt(req.query.audioStreamIndex as string, 10)
        : undefined;

    // Audio/subtitle tracks + Jellyfin session from a single PlaybackInfo call.
    // PlaySessionId and MediaSourceId are forwarded to the stream URL so it can
    // skip a redundant getPlaybackInfo round-trip to Jellyfin.
    // Tracks and media segments are independent — fetch in parallel to save ~50-100ms.
    let audio_tracks: { index: number; language: string; name: string }[] = [];
    let subtitle_tracks: { index: number; language: string; name: string; codec: string | null; forced: boolean; key: string | null }[] = [];
    let playSessionId = '';
    let mediaSourceId = '';
    let outro_start_ms: number | null = null;
    {
      const cacheKey = program.media_item_id;
      const cached = tracksCache.get(cacheKey);
      const fromLibrary = tracksFromLibrary(provider, program.media_item_id);
      const isCacheHit = fromLibrary != null || (cached != null && Date.now() < cached.expiresAt);

      const [tracksResult, segmentsResult] = await Promise.allSettled([
        fromLibrary ?? (isCacheHit ? cached!.data : getTracksAndSession(provider, program.media_item_id)),
        getOutroStartMs(provider, program.media_item_id),
      ]);

      if (tracksResult.status === 'fulfilled') {
        const result = tracksResult.value;
        if (!isCacheHit) {
          tracksCache.set(cacheKey, { data: result, expiresAt: Date.now() + TRACKS_CACHE_TTL_MS });
          // Evict expired entries on every miss to prevent unbounded growth
          const now = Date.now();
          for (const [k, v] of tracksCache) {
            if (now > v.expiresAt) tracksCache.delete(k);
          }
        }
        ({ audio_tracks, subtitle_tracks, playSessionId, mediaSourceId } = result);
        // Every tune gets its own session — a cached id would make two tunes of the same
        // item share (and stop) one Jellyfin transcode.
        if (fromLibrary == null) playSessionId = newSessionId();
      } else {
        console.warn('[Playback] Could not fetch tracks:', (tracksResult.reason as Error)?.message);
      }

      if (segmentsResult.status === 'fulfilled') {
        outro_start_ms = segmentsResult.value;
      }
    }

    // If client did not request a specific track, apply preferred audio language from DB
    if (audioStreamIndex == null || Number.isNaN(audioStreamIndex)) {
      const preferred = queries.getSetting(db, 'preferred_audio_language');
      const preferredLang =
        typeof preferred === 'string' && preferred.length > 0 ? preferred.toLowerCase() : null;
      if (preferredLang && audio_tracks.length > 0) {
        const match = audio_tracks.find((t) => t.language.toLowerCase() === preferredLang);
        if (match) {
          audioStreamIndex = match.index;
        }
      }
    }

    // Preferred subtitle index from DB (default on/off and track)
    const preferredSub = queries.getSetting(db, 'preferred_subtitle_index');
    const preferredSubIndex =
      typeof preferredSub === 'number' && Number.isInteger(preferredSub) ? preferredSub : null;
    const subtitle_index =
      preferredSubIndex === null
        ? null
        : subtitle_tracks.length > 0 && preferredSubIndex >= 0 && preferredSubIndex < subtitle_tracks.length
          ? preferredSubIndex
          : null;

    // Build stream URL with quality, optional audio track, and pre-fetched session IDs
    const streamParams = new URLSearchParams();
    if (playSessionId) streamParams.set('playSessionId', playSessionId);
    if (mediaSourceId) streamParams.set('mediaSourceId', mediaSourceId);
    if (bitrate) streamParams.set('bitrate', String(bitrate));
    if (maxWidth) streamParams.set('maxWidth', String(maxWidth));
    if (audioStreamIndex != null && !Number.isNaN(audioStreamIndex)) {
      streamParams.set('audioStreamIndex', String(audioStreamIndex));
    }
    if (subtitle_index != null && subtitle_tracks[subtitle_index]) {
      streamParams.set('subtitleStreamIndex', String(subtitle_tracks[subtitle_index].index));
      streamParams.set('subtitleMethod', subtitleMethodFor(subtitle_tracks[subtitle_index].codec));
    }
    if (req.query.hevc === '1') {
      streamParams.set('hevc', '1');
    }
    // Native Apple player (tvOS client): enables AC3/E-AC3 5.1 copy and, on Plex, full-bitrate
    // direct streams. Browsers never send it.
    if (req.query.native === '1') {
      streamParams.set('native', '1');
    }
    // Start the transcode at the live position server-side so the first segments the
    // client needs already exist. Plex: `offset` primes its transcoder at the join point
    // (fixes the -15628 cold-seek decode race). Jellyfin: the master's StartTimeTicks alone
    // doesn't move ffmpeg (it starts at whichever segment is requested first) — it drives
    // the #EXT-X-START the proxy injects and the live-segment pre-warm below. Ticks are 100ns.
    // The client-side seek is preserved in both cases — neither server rebases the
    // stream to 0 (see seek_position_ms comment below).
    const startTicks = seekMs > 0 ? Math.floor(seekMs / 1000) * 10_000_000 : 0;
    if (startTicks > 0) {
      streamParams.set('startTimeTicks', String(startTicks));
    }
    const queryString = streamParams.toString();
    const streamUrl = withClientToken(`/api/stream/${program.media_item_id}${queryString ? `?${queryString}` : ''}`);

    // Pre-warm: get the media server producing the live segment while the client is still
    // processing this response (its /api/stream + playlist requests follow within a few
    // hundred ms and join / are served from what this fetched).
    const clientKey = clientKeyFor(req);
    const streamQuery = Object.fromEntries(streamParams);
    if (playSessionId && mediaSourceId) {
      // Stop this device's previous pre-warmed session if it never got as far as /api/stream
      // (rapid switching). Other devices' sessions are not ours to stop.
      const prev = lastPrewarmedByClient.get(clientKey);
      if (prev && prev.playSessionId !== playSessionId && !isSessionConsumed(prev.playSessionId)) {
        console.log(`[Playback] Stopping previous pre-warm session=${prev.playSessionId} item=${prev.itemId}`);
        void provider.stopPlaybackSession(prev.playSessionId).catch(() => {});
        void provider.deleteTranscodingJob(prev.playSessionId).catch(() => {});
        if (activeSessions.get(prev.itemId)?.playSessionId === prev.playSessionId) {
          activeSessions.delete(prev.itemId);
          lastActivityByItemId.delete(prev.itemId);
        }
        releaseSessionState(prev.playSessionId);
      }
      lastPrewarmedByClient.set(clientKey, { playSessionId, itemId: program.media_item_id });

      if (provider.providerType === 'plex') {
        // Plex: start the transcode session now; /api/stream adopts it by playSessionId.
        registerPlexPrestart(playSessionId, startPlexSession(
          provider, program.media_item_id, clientKey,
          { ...plexStreamOptions(streamQuery), sessionId: playSessionId },
          startTicks || undefined,
        ));
      } else {
        // Register this session for idle cleanup tracking
        trackSession(program.media_item_id, playSessionId, mediaSourceId, clientKey);
        // Same params builder as /api/stream, so both hit one Jellyfin transcode + cache entry.
        const masterParams = jellyfinMasterParams(streamQuery, {
          deviceId: provider.getDeviceId(), mediaSourceId, playSessionId,
        });
        void warmJellyfinStart(provider, program.media_item_id, masterParams, startTicks / 10_000_000).catch(() => {});
      }
    }

    const seekSeconds = seekMs / 1000;
    console.log(`[Playback] Channel ${channelId}: seekMs=${seekMs}, item=${program.media_item_id}, audio_tracks=${audio_tracks.length}, audioStreamIndex=${audioStreamIndex ?? 'default'}, subtitle_index=${subtitle_index ?? 'off'}`);

    res.json({
      stream_url: streamUrl,
      // Keep the real seek position even when Plex applies the server-side offset.
      // Plex's `offset` does NOT rebase the stream to 0 — it emits a playlist with
      // `#EXT-X-START:TIME-OFFSET=<offset>` and positions the transcoded content at the
      // offset, leaving the pre-offset segments empty. The client must therefore seek to
      // the offset to land on real media; the server offset's job is to prime Plex's
      // transcoder there so that seek resolves immediately (no -15628 cold-seek race).
      seek_position_ms: seekMs,
      seek_position_seconds: seekSeconds,
      program,
      next_program: next,
      channel,
      is_interstitial: false,
      audio_tracks,
      audio_stream_index: audioStreamIndex ?? null,
      subtitle_tracks,
      subtitle_index,
      outro_start_ms,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
