import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import type { JellyfinClient } from '../services/JellyfinClient.js';

export const playbackRoutes = Router();

// GET /api/playback/:channelId - Get streaming info for current program
playbackRoutes.get('/:channelId', (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine } = req.app.locals;
    const channelId = parseInt(req.params.channelId as string, 10);
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
      });
      return;
    }

    // Get quality parameters from query string
    const bitrate = req.query.bitrate ? parseInt(req.query.bitrate as string, 10) : undefined;
    const maxWidth = req.query.maxWidth ? parseInt(req.query.maxWidth as string, 10) : undefined;
    
    // Build stream URL with quality parameters
    const streamParams = new URLSearchParams();
    if (bitrate) streamParams.set('bitrate', String(bitrate));
    if (maxWidth) streamParams.set('maxWidth', String(maxWidth));
    
    const queryString = streamParams.toString();
    const streamUrl = `/api/stream/${program.jellyfin_item_id}${queryString ? `?${queryString}` : ''}`;
    
    // Convert seekMs to seconds for hls.js startPosition
    const seekSeconds = seekMs / 1000;
    
    console.log(`[Playback] Channel ${channelId}: seekMs=${seekMs}, seekSeconds=${seekSeconds.toFixed(1)}, bitrate=${bitrate || 'auto'}, item=${program.jellyfin_item_id}`);

    // Fetch subtitles in parallel (don't block on error)
    const { jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
    let subtitles: Array<{ index: number; language: string; displayTitle: string; isDefault: boolean; isForced: boolean; url: string }> = [];
    
    try {
      const playbackInfo = await jf.getPlaybackInfo(program.jellyfin_item_id);
      const mediaSource = playbackInfo.MediaSources?.[0];
      const mediaSourceId = mediaSource?.Id || program.jellyfin_item_id;
      
      if (mediaSource?.MediaStreams) {
        subtitles = mediaSource.MediaStreams
          .filter(stream => stream.Type === 'Subtitle')
          .map(stream => ({
            index: stream.Index ?? 0,
            language: stream.Language || 'Unknown',
            displayTitle: stream.DisplayTitle || stream.Language || 'Subtitle',
            isDefault: stream.IsDefault ?? false,
            isForced: stream.IsForced ?? false,
            url: `/api/subtitles/${program.jellyfin_item_id}/${mediaSourceId}/${stream.Index ?? 0}/vtt`,
          }));
        
        console.log(`[Playback] Found ${subtitles.length} subtitle tracks for item ${program.jellyfin_item_id}`);
      }
    } catch (err) {
      console.error(`[Playback] Error fetching subtitles:`, err);
      // Continue without subtitles
    }

    res.json({
      stream_url: streamUrl,
      seek_position_ms: seekMs,
      seek_position_seconds: seekSeconds,
      program,
      next_program: next,
      channel,
      is_interstitial: false,
      subtitles,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/playback/subtitles/:itemId - Get available subtitles for an item
playbackRoutes.get('/subtitles/:itemId', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const jf = jellyfinClient as JellyfinClient;
    const itemId = req.params.itemId as string;

    const subtitles = await jf.getSubtitles(itemId);
    
    res.json({
      itemId,
      subtitles,
    });
  } catch (err) {
    console.error('[Playback] Error fetching subtitles:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});
