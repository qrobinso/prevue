import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';

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

    res.json({
      stream_url: streamUrl,
      seek_position_ms: seekMs,
      seek_position_seconds: seekSeconds,
      program,
      next_program: next,
      channel,
      is_interstitial: false,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
