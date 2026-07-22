import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import { createTestDb } from '../helpers/setup.js';
import { playbackRoutes } from '../../src/routes/playback.js';

const ITEM_ID = 'a'.repeat(32);
const SEEK_MS = 600_000; // 10 minutes into the program

function createMockProvider(
  providerType: 'jellyfin' | 'plex',
  mediaStreams: object[] = []
) {
  return {
    providerType,
    getPlaybackInfo: vi.fn(async () => ({
      PlaySessionId: 'sess-1',
      MediaSources: [{ Id: 'src-1', MediaStreams: mediaStreams }],
    })),
    getMediaSegments: vi.fn(async () => ({ outroStartMs: null })),
    getBaseUrl: () => 'http://mock:8096',
    getProxyHeaders: () => ({ 'X-Emby-Token': 'mock' }),
    getDeviceId: () => 'device-1',
    deleteTranscodingJob: vi.fn(async () => {}),
  } as any;
}

function createApp(
  providerType: 'jellyfin' | 'plex',
  opts: { mediaStreams?: object[]; itemId?: string; settings?: Record<string, unknown> } = {}
): Express {
  const db = createTestDb();
  const app = express();
  app.use(express.json());
  const itemId = opts.itemId ?? ITEM_ID;
  for (const [key, value] of Object.entries(opts.settings ?? {})) {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
  }

  const scheduleEngine = {
    getCurrentProgram: () => ({
      program: {
        id: 1,
        channel_id: 1,
        media_item_id: itemId,
        type: 'movie',
        title: 'Test Movie',
        start_time: new Date(Date.now() - SEEK_MS).toISOString(),
        end_time: new Date(Date.now() + 3_600_000).toISOString(),
      },
      next: null,
      seekMs: SEEK_MS,
    }),
  };

  app.locals.db = db;
  app.locals.mediaProvider = createMockProvider(providerType, opts.mediaStreams);
  app.locals.scheduleEngine = scheduleEngine;

  // Minimal channel row so getChannelById succeeds
  db.prepare(
    `INSERT INTO channels (id, number, name, type, item_ids, sort_order) VALUES (1, 100, 'Test', 'auto', '[]', 0)`
  ).run();

  app.use('/api/playback', playbackRoutes);
  return app;
}

describe('GET /api/playback/:channelId — Jellyfin server-side start offset', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('#EXTM3U'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('includes startTimeTicks in stream_url when seeking into a program', async () => {
    const app = createApp('jellyfin');
    const res = await request(app).get('/api/playback/1');

    expect(res.status).toBe(200);
    const expectedTicks = Math.floor(SEEK_MS / 1000) * 10_000_000;
    expect(res.body.stream_url).toContain(`startTimeTicks=${expectedTicks}`);
    // Client-side seek must be preserved (Jellyfin does not rebase to 0)
    expect(res.body.seek_position_ms).toBe(SEEK_MS);
  });

  it('pre-warm request to Jellyfin includes StartTimeTicks at the live offset', async () => {
    const app = createApp('jellyfin');
    const res = await request(app).get('/api/playback/1');
    expect(res.status).toBe(200);

    const warmCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes('/master.m3u8')
    );
    expect(warmCall).toBeDefined();
    const warmUrl = new URL(String(warmCall![0]));
    const expectedTicks = Math.floor(SEEK_MS / 1000) * 10_000_000;
    expect(warmUrl.searchParams.get('StartTimeTicks')).toBe(String(expectedTicks));
  });

  it('requests short segments with a minimal ready gate for fast tune-in', async () => {
    const app = createApp('jellyfin');
    const res = await request(app).get('/api/playback/1');
    expect(res.status).toBe(200);

    const warmCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes('/master.m3u8')
    );
    expect(warmCall).toBeDefined();
    const warmUrl = new URL(String(warmCall![0]));
    // One 3s segment ready = playable, instead of two ~6s segments (~12s of encode)
    expect(warmUrl.searchParams.get('MinSegments')).toBe('1');
    expect(warmUrl.searchParams.get('SegmentLength')).toBe('3');
  });

  it('delivers text subtitles as HLS tracks (no burn-in) so stream copy is preserved', async () => {
    const app = createApp('jellyfin', {
      itemId: 'b'.repeat(32),
      mediaStreams: [{ Type: 'Subtitle', Index: 2, Codec: 'subrip', Language: 'eng', DisplayTitle: 'English' }],
      settings: { preferred_subtitle_index: 0 },
    });
    const res = await request(app).get('/api/playback/1');
    expect(res.status).toBe(200);
    expect(res.body.subtitle_index).toBe(0);

    expect(res.body.stream_url).toContain('subtitleStreamIndex=2');
    expect(res.body.stream_url).toContain('subtitleMethod=Hls');

    const warmUrl = new URL(String(
      fetchSpy.mock.calls.find(([url]) => String(url).includes('/master.m3u8'))![0]
    ));
    expect(warmUrl.searchParams.get('SubtitleStreamIndex')).toBe('2');
    expect(warmUrl.searchParams.get('SubtitleMethod')).toBe('Hls');
  });

  it('keeps burn-in (Encode) for image-based subtitle codecs', async () => {
    const app = createApp('jellyfin', {
      itemId: 'c'.repeat(32),
      mediaStreams: [{ Type: 'Subtitle', Index: 3, Codec: 'pgssub', Language: 'eng', DisplayTitle: 'English PGS' }],
      settings: { preferred_subtitle_index: 0 },
    });
    const res = await request(app).get('/api/playback/1');
    expect(res.status).toBe(200);

    expect(res.body.stream_url).toContain('subtitleStreamIndex=3');
    expect(res.body.stream_url).toContain('subtitleMethod=Encode');

    const warmUrl = new URL(String(
      fetchSpy.mock.calls.find(([url]) => String(url).includes('/master.m3u8'))![0]
    ));
    expect(warmUrl.searchParams.get('SubtitleMethod')).toBe('Encode');
  });
});
