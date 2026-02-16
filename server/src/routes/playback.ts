import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import type { JellyfinClient } from '../services/JellyfinClient.js';

export const playbackRoutes = Router();

// Extract audio/subtitle tracks and session info from Jellyfin in a single API call.
// Returns PlaySessionId and MediaSourceId so the stream endpoint can skip a redundant call.
async function getTracksAndSession(
  jellyfinClient: JellyfinClient,
  itemId: string
): Promise<{
  audio_tracks: { index: number; language: string; name: string }[];
  subtitle_tracks: { index: number; language: string; name: string }[];
  playSessionId: string;
  mediaSourceId: string;
}> {
  const playbackInfo = await jellyfinClient.getPlaybackInfo(itemId);
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
    }))
    .filter((t) => t.index >= 0);

  const playSessionId = (playbackInfo as Record<string, unknown>).PlaySessionId as string || '';
  const mediaSourceId = mediaSource?.Id as string || itemId;

  return { audio_tracks, subtitle_tracks, playSessionId, mediaSourceId };
}

// GET /api/playback/:channelId - Get streaming info for current program
playbackRoutes.get('/:channelId', async (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine, jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
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
        subtitle_tracks: [],
        subtitle_index: null,
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
    let audio_tracks: { index: number; language: string; name: string }[] = [];
    let subtitle_tracks: { index: number; language: string; name: string }[] = [];
    let playSessionId = '';
    let mediaSourceId = '';
    try {
      ({ audio_tracks, subtitle_tracks, playSessionId, mediaSourceId } = await getTracksAndSession(jf, program.jellyfin_item_id));
    } catch (e) {
      console.warn('[Playback] Could not fetch tracks:', (e as Error).message);
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
    const streamUrl = `/api/stream/${program.jellyfin_item_id}${queryString ? `?${queryString}` : ''}`;

    const seekSeconds = seekMs / 1000;
    console.log(`[Playback] Channel ${channelId}: seekMs=${seekMs}, item=${program.jellyfin_item_id}, audio_tracks=${audio_tracks.length}, audioStreamIndex=${audioStreamIndex ?? 'default'}, subtitle_index=${subtitle_index ?? 'off'}`);

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
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
