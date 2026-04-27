import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import type { MediaProvider } from '../services/MediaProvider.js';
import { resolveTrailer, isYtDlpAvailable } from '../utils/ytdlp.js';

export const trailerRoutes = Router();

/**
 * GET /api/stream/trailer/:channelId
 * Resolve the YouTube trailer for the program currently airing on the given
 * Now Playing channel and stream/redirect to the direct media URL.
 *
 * Also persists the probed duration back to the source MediaItem so the next
 * schedule regeneration can use real durations instead of the 150s default.
 */
trailerRoutes.get('/trailer/:channelId', async (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine, mediaProvider } = req.app.locals;
    const provider = mediaProvider as MediaProvider;
    const channelId = parseInt(req.params.channelId as string, 10);
    if (!Number.isFinite(channelId)) {
      res.status(400).json({ error: 'Invalid channel id' });
      return;
    }

    const channel = queries.getChannelById(db, channelId);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const current = (scheduleEngine as ScheduleEngine).getCurrentProgram(channelId);
    if (!current || current.program.type !== 'trailer') {
      res.status(404).json({ error: 'No trailer currently airing on this channel' });
      return;
    }

    const trailerUrl = current.program.trailer_url;
    if (!trailerUrl) {
      res.status(500).json({ error: 'Trailer program is missing trailer_url' });
      return;
    }

    if (!(await isYtDlpAvailable())) {
      console.error('[Trailer] yt-dlp is not installed; Now Playing channel will not work');
      res.status(503).json({ error: 'yt-dlp is not installed on the server. Install it to enable Now Playing trailers.' });
      return;
    }

    const resolved = await resolveTrailer(trailerUrl);

    // Best-effort: write the probed duration back to the MediaItem so future
    // schedule generations get real durations instead of the 150s default.
    if (resolved.durationMs && resolved.durationMs > 0) {
      const sourceItem = provider.getItem(current.program.media_item_id);
      const server = provider.getActiveServer();
      if (sourceItem && server) {
        const trailers = sourceItem.RemoteTrailers || [];
        let dirty = false;
        for (const t of trailers) {
          if (t.Url === trailerUrl && t.DurationMs !== resolved.durationMs) {
            t.DurationMs = resolved.durationMs;
            dirty = true;
          }
        }
        if (dirty) {
          try {
            queries.upsertLibraryItem(db, sourceItem.Id, server.id, sourceItem);
          } catch (err) {
            // Cache update is best-effort; don't block playback on write failures.
            console.warn(`[Trailer] Failed to persist duration for ${sourceItem.Id}:`, (err as Error).message);
          }
        }
      }
    }

    // Proxy the bytes through our server. A 302 to googlevideo doesn't work
    // because the signed URL is bound to specific request headers (Referer,
    // User-Agent) that the browser won't send — googlevideo silently returns
    // an empty body or 403, which the <video> element renders as a blank screen.
    const upstreamHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: 'https://www.youtube.com/',
      Origin: 'https://www.youtube.com',
    };
    const range = req.headers.range;
    if (range) upstreamHeaders.Range = range;

    const upstream = await fetch(resolved.directUrl, { headers: upstreamHeaders });
    if (!upstream.ok && upstream.status !== 206) {
      console.warn(`[Trailer] upstream returned ${upstream.status} for ${current.program.media_item_id}`);
      res.status(502).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }

    // Mirror the headers the browser cares about for <video> playback + seeking.
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
    for (const name of passthrough) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.headers.get('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    res.status(upstream.status);

    if (!upstream.body) {
      res.end();
      return;
    }
    // Pipe Web ReadableStream → Node response. node-fetch in newer Node returns
    // a Web stream; pipeTo isn't available on Node res, so manual pump.
    const reader = upstream.body.getReader();
    res.on('close', () => { reader.cancel().catch(() => {}); });
    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise<void>(r => res.once('drain', () => r()));
          }
        }
        res.end();
      } catch (err) {
        console.warn('[Trailer] proxy stream interrupted:', (err as Error).message);
        try { res.end(); } catch { /* ignore */ }
      }
    };
    void pump();
  } catch (err) {
    console.error('[Trailer] resolve failed:', err);
    res.status(502).json({ error: 'Failed to resolve trailer URL', detail: (err as Error).message });
  }
});
