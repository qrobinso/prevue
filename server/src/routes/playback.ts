import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import type { MediaProvider } from '../services/MediaProvider.js';
import { activeSessions, trackSession, lastActivityByItemId } from './stream.js';

export const playbackRoutes = Router();

// Track the last pre-warmed session so we can stop it when a new one starts.
// This prevents orphaned FFmpeg transcodes during rapid channel switching.
let lastPrewarmedSession: { playSessionId: string; itemId: string } | null = null;

// ── Tracks/session cache (TTL 60s) — prevents redundant Jellyfin calls on rapid channel switches ──
const TRACKS_CACHE_TTL_MS = 60_000;
const tracksCache = new Map<string, { data: Awaited<ReturnType<typeof getTracksAndSession>>; expiresAt: number }>();

// Extract audio/subtitle tracks and session info from Jellyfin in a single API call.
// Returns PlaySessionId and MediaSourceId so the stream endpoint can skip a redundant call.
async function getTracksAndSession(
  mediaProvider: MediaProvider,
  itemId: string
): Promise<{
  audio_tracks: { index: number; language: string; name: string }[];
  subtitle_tracks: { index: number; language: string; name: string; codec: string | null; forced: boolean; key: string | null }[];
  playSessionId: string;
  mediaSourceId: string;
}> {
  const playbackInfo = await mediaProvider.getPlaybackInfo(itemId);
  const mediaSource = playbackInfo.MediaSources?.[0];
  const streams = mediaSource?.MediaStreams ?? [];

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

  const playSessionId = (playbackInfo as Record<string, unknown>).PlaySessionId as string || '';
  const mediaSourceId = mediaSource?.Id as string || itemId;

  return { audio_tracks, subtitle_tracks, playSessionId, mediaSourceId };
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
      const isCacheHit = cached != null && Date.now() < cached.expiresAt;

      const [tracksResult, segmentsResult] = await Promise.allSettled([
        isCacheHit ? cached!.data : getTracksAndSession(provider, program.media_item_id),
        provider.getMediaSegments(program.media_item_id),
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
      } else {
        console.warn('[Playback] Could not fetch tracks:', (tracksResult.reason as Error)?.message);
      }

      if (segmentsResult.status === 'fulfilled') {
        outro_start_ms = segmentsResult.value.outroStartMs;
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
    }
    if (req.query.hevc === '1') {
      streamParams.set('hevc', '1');
    }
    const queryString = streamParams.toString();
    const streamUrl = `/api/stream/${program.media_item_id}${queryString ? `?${queryString}` : ''}`;

    // Pre-warm: fire-and-forget fetch of master.m3u8 to start transcoding
    // in the background while the client processes this response.
    // Skip pre-warm for Plex — the stream route will call getHlsStreamUrl which
    // creates the Plex transcode session on demand. Pre-warming with a Jellyfin URL
    // would hit a non-existent path and create a conflicting session.
    const isPlex = provider.providerType === 'plex';
    if (playSessionId && mediaSourceId && !isPlex) {
      // Stop the previous pre-warmed session if it wasn't consumed by /api/stream.
      // This prevents orphaned FFmpeg transcodes during rapid channel switching.
      if (lastPrewarmedSession && lastPrewarmedSession.itemId !== program.media_item_id) {
        const prev = lastPrewarmedSession;
        // Only stop if /api/stream never picked it up (still in activeSessions means stream is active)
        const activeSession = activeSessions.get(prev.itemId);
        const wasConsumed = activeSession && activeSession.playSessionId === prev.playSessionId;
        if (!wasConsumed) {
          console.log(`[Playback] Stopping previous pre-warm session=${prev.playSessionId} item=${prev.itemId}`);
          void provider.deleteTranscodingJob(prev.playSessionId).catch(() => {});
          activeSessions.delete(prev.itemId);
          lastActivityByItemId.delete(prev.itemId);
        }
      }

      // Register this session for idle cleanup tracking
      trackSession(program.media_item_id, playSessionId, mediaSourceId);
      lastPrewarmedSession = { playSessionId, itemId: program.media_item_id };

      const baseUrl = provider.getBaseUrl();
      const headers = provider.getProxyHeaders();
      const deviceId = provider.getDeviceId();
      const hevc = req.query.hevc === '1';
      // Pre-warm params MUST match what stream.ts handleJellyfinStream builds,
      // otherwise Jellyfin starts a different transcode session and the pre-warm is wasted.
      const hasExplicitQuality = !!(bitrate && bitrate !== 120000000) || !!maxWidth;
      const warmParams = new URLSearchParams({
        DeviceId: deviceId,
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        VideoCodec: hevc ? 'hevc,h264' : 'h264',
        AudioCodec: 'aac',
        MaxStreamingBitrate: String(bitrate || 120000000),
        VideoBitrate: String(bitrate || 120000000),
        TranscodingMaxAudioChannels: '2',
        SegmentContainer: hevc ? 'mp4' : 'ts',
        MinSegments: '2',
        BreakOnNonKeyFrames: 'true',
      });
      // Match stream.ts:714-724 — only allow stream copy when auto quality
      if (!hasExplicitQuality) {
        warmParams.set('AllowVideoStreamCopy', 'true');
        warmParams.set('AllowAudioStreamCopy', 'true');
        warmParams.set('EnableAutoStreamCopy', 'true');
        warmParams.set('MaxWidth', '3840');
        warmParams.set('MaxHeight', '2160');
      } else if (maxWidth) {
        warmParams.set('MaxWidth', String(maxWidth));
      }
      if (audioStreamIndex != null && !Number.isNaN(audioStreamIndex)) {
        warmParams.set('AudioStreamIndex', String(audioStreamIndex));
      }
      // Match stream.ts:728-732 — include subtitle params so Jellyfin
      // pre-warms the correct transcode (with or without burn-in).
      if (subtitle_index != null && subtitle_tracks[subtitle_index]) {
        warmParams.set('SubtitleStreamIndex', String(subtitle_tracks[subtitle_index].index));
        warmParams.set('SubtitleMethod', 'Encode');
      }
      const warmUrl = `${baseUrl}/Videos/${program.media_item_id}/master.m3u8?${warmParams}`;
      void fetch(warmUrl, { headers }).catch(() => {});
    }

    const seekSeconds = seekMs / 1000;
    console.log(`[Playback] Channel ${channelId}: seekMs=${seekMs}, item=${program.media_item_id}, audio_tracks=${audio_tracks.length}, audioStreamIndex=${audioStreamIndex ?? 'default'}, subtitle_index=${subtitle_index ?? 'off'}`);

    res.json({
      stream_url: streamUrl,
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
