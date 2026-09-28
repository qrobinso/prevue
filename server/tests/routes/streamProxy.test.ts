import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createTestDb } from '../helpers/setup.js';
import {
  streamRoutes, activeSessions, jellyfinMasterParams, setSessionStartOffset,
} from '../../src/routes/stream.js';
import { clearUpstreamCache, fetchUpstreamShared, upstreamKey } from '../../src/services/hlsUpstream.js';

const ITEM_ID = 'b'.repeat(32);

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:3',
  '#EXTINF:3.000000, nodesc',
  'hls1/main/0.ts?runtimeTicks=0',
  '#EXTINF:3.000000, nodesc',
  'hls1/main/1.ts?runtimeTicks=30000000',
  '#EXT-X-ENDLIST',
].join('\n');

function createApp(provider: Record<string, unknown> = {}): Express {
  const app = express();
  app.use(express.json());
  app.locals.db = createTestDb();
  app.locals.mediaProvider = {
    providerType: 'jellyfin',
    getItem: () => undefined,
    getBaseUrl: () => 'http://mock:8096',
    getProxyHeaders: () => ({ 'X-Emby-Token': 'mock' }),
    getDeviceId: () => 'device-1',
    stopPlaybackSession: vi.fn(async () => {}),
    deleteTranscodingJob: vi.fn(async () => {}),
    reportPlaybackStart: vi.fn(async () => {}),
    reportPlaybackStopped: vi.fn(async () => {}),
    ...provider,
  };
  app.use('/api', streamRoutes);
  return app;
}

describe('GET /api/stream/proxy/*', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearUpstreamCache();
    activeSessions.clear();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(MEDIA_PLAYLIST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
  });

  afterEach(() => fetchSpy.mockRestore());

  it('strips the client token upstream and propagates it into rewritten URLs', async () => {
    const res = await request(createApp())
      .get(`/api/stream/proxy/Videos/${ITEM_ID}/main.m3u8?PlaySessionId=p1&token=secret`);
    expect(res.status).toBe(200);
    const upstreamUrl = String(fetchSpy.mock.calls[0][0]);
    expect(upstreamUrl).not.toContain('token');
    expect(upstreamUrl).toContain('PlaySessionId=p1');
    const segLines = res.text.split('\n').filter((l) => l.startsWith('/api/stream/proxy/'));
    expect(segLines.length).toBe(2);
    for (const l of segLines) expect(l).toContain('token=secret');
  });

  it('injects EXT-X-START at the session live offset for Jellyfin media playlists', async () => {
    setSessionStartOffset('p2', 4);
    const res = await request(createApp())
      .get(`/api/stream/proxy/Videos/${ITEM_ID}/main.m3u8?PlaySessionId=p2`);
    expect(res.text).toContain('#EXT-X-START:TIME-OFFSET=4.000,PRECISE=NO');
  });

  it('does not inject EXT-X-START for IPTV playlists', async () => {
    setSessionStartOffset('p3', 4);
    const res = await request(createApp())
      .get(`/api/stream/proxy/Videos/${ITEM_ID}/main.m3u8?PlaySessionId=p3&iptv=1`);
    expect(res.text).not.toContain('#EXT-X-START');
  });

  it('serves a pre-warmed segment from memory without a second upstream fetch', async () => {
    fetchSpy.mockImplementation(async () => new Response(Buffer.from('SEGMENT'), { headers: { 'content-type': 'video/mp2t' } }));
    const path = `/Videos/${ITEM_ID}/hls1/main/1.ts`;
    const params = new URLSearchParams('PlaySessionId=p4&DeviceId=device-1');
    await fetchUpstreamShared(upstreamKey(path, params), `http://mock:8096${path}?${params}`, {}, {
      kind: 'binary', timeoutMs: 1000, retries: 0, lingerMs: 10_000, sessionId: 'p4',
    });
    fetchSpy.mockClear();

    // Same resource, different param order + a client token → same cache entry.
    const res = await request(createApp())
      .get(`/api/stream/proxy${path}?DeviceId=device-1&PlaySessionId=p4&token=k`)
      .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('SEGMENT');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('streams a non-warmed segment through', async () => {
    fetchSpy.mockImplementation(async () => new Response(Buffer.from('STREAMED'), {
      headers: { 'content-type': 'video/mp2t', 'content-length': '8' },
    }));
    const res = await request(createApp())
      .get(`/api/stream/proxy/Videos/${ITEM_ID}/hls1/main/5.ts?PlaySessionId=p5&StartTimeTicks=1`)
      .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('STREAMED');
    expect(res.headers['content-length']).toBe('8');
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('StartTimeTicks');
  });
});

describe('POST /api/stream/stop', () => {
  beforeEach(() => activeSessions.clear());

  it('stopping an older session leaves the item\'s newer session tracked', async () => {
    const app = createApp();
    activeSessions.set(ITEM_ID, { playSessionId: 'new', mediaSourceId: 'm' });
    const res = await request(app).post('/api/stream/stop').send({ itemId: ITEM_ID, playSessionId: 'old' });
    expect(res.body.stopped).toBe('old');
    expect(activeSessions.get(ITEM_ID)?.playSessionId).toBe('new');
  });

  it('stopping the current session untracks it', async () => {
    const app = createApp();
    activeSessions.set(ITEM_ID, { playSessionId: 'cur', mediaSourceId: 'm' });
    await request(app).post('/api/stream/stop').send({ itemId: ITEM_ID, playSessionId: 'cur' });
    expect(activeSessions.has(ITEM_ID)).toBe(false);
  });
});

describe('jellyfinMasterParams', () => {
  const ids = { deviceId: 'd', mediaSourceId: 'm', playSessionId: 'p' };

  it('lists H.264 first so unavoidable transcodes use the fast encoder, HEVC still copyable', () => {
    const p = jellyfinMasterParams({ hevc: '1' }, ids);
    expect(p.get('VideoCodec')).toBe('h264,hevc');
    expect(p.get('SegmentContainer')).toBe('mp4');
  });

  it('allows AC3/E-AC3 5.1 copy only for native players', () => {
    expect(jellyfinMasterParams({ native: '1' }, ids).get('AudioCodec')).toBe('aac,ac3,eac3');
    expect(jellyfinMasterParams({ native: '1' }, ids).get('TranscodingMaxAudioChannels')).toBe('6');
    expect(jellyfinMasterParams({}, ids).get('AudioCodec')).toBe('aac');
    expect(jellyfinMasterParams({}, ids).get('TranscodingMaxAudioChannels')).toBe('2');
  });

  it('treats the default bitrate as auto quality (stream copy allowed)', () => {
    expect(jellyfinMasterParams({ bitrate: '120000000' }, ids).get('AllowVideoStreamCopy')).toBe('true');
    expect(jellyfinMasterParams({ bitrate: '8000000' }, ids).get('AllowVideoStreamCopy')).toBeNull();
  });
});
