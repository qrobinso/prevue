import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  upstreamKey, stripClientAuthParams, injectStartOffset, segmentsAtOffset,
  fetchUpstreamShared, peekUpstream, purgeUpstreamSession, clearUpstreamCache, sanitizeRenditions,
} from '../../src/services/hlsUpstream.js';

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:3',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-MAP:URI="/api/stream/proxy/Videos/x/hls1/main/-1.mp4?PlaySessionId=s"',
  '#EXTINF:3.000000, nodesc',
  '/api/stream/proxy/Videos/x/hls1/main/0.mp4?PlaySessionId=s',
  '#EXTINF:3.000000, nodesc',
  '/api/stream/proxy/Videos/x/hls1/main/1.mp4?PlaySessionId=s',
  '#EXTINF:3.000000, nodesc',
  '/api/stream/proxy/Videos/x/hls1/main/2.mp4?PlaySessionId=s',
  '#EXT-X-ENDLIST',
].join('\n');

describe('upstreamKey', () => {
  it('ignores client-auth params and param order', () => {
    const a = upstreamKey('/Videos/x/main.m3u8', new URLSearchParams('b=2&a=1&token=secret'));
    const b = upstreamKey('/Videos/x/main.m3u8', new URLSearchParams('a=1&api_key=other&b=2'));
    expect(a).toBe(b);
    expect(a).not.toContain('secret');
  });
});

describe('stripClientAuthParams', () => {
  it('removes token/api_key and returns the token', () => {
    const p = new URLSearchParams('PlaySessionId=s&token=k&api_key=k');
    expect(stripClientAuthParams(p)).toBe('k');
    expect(p.toString()).toBe('PlaySessionId=s');
  });
});

describe('injectStartOffset', () => {
  it('adds EXT-X-START right after #EXTM3U in a media playlist', () => {
    const out = injectStartOffset(MEDIA_PLAYLIST, 4.5);
    expect(out.split('\n')[1]).toBe('#EXT-X-START:TIME-OFFSET=4.500,PRECISE=NO');
  });

  it('leaves master playlists, zero offsets, and existing tags alone', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8\n';
    expect(injectStartOffset(master, 10)).toBe(master);
    expect(injectStartOffset(MEDIA_PLAYLIST, 0)).toBe(MEDIA_PLAYLIST);
    const tagged = injectStartOffset(MEDIA_PLAYLIST, 3);
    expect(injectStartOffset(tagged, 5)).toBe(tagged);
  });
});

describe('segmentsAtOffset', () => {
  it('finds the segment containing the offset, the next one, and the init segment', () => {
    const r = segmentsAtOffset(MEDIA_PLAYLIST, 4);
    expect(r.segment).toContain('/main/1.mp4');
    expect(r.next).toContain('/main/2.mp4');
    expect(r.init).toContain('/main/-1.mp4');
  });

  it('clamps past the end to the last segment', () => {
    const r = segmentsAtOffset(MEDIA_PLAYLIST, 999);
    expect(r.segment).toContain('/main/2.mp4');
    expect(r.next).toBeNull();
  });
});

describe('fetchUpstreamShared', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearUpstreamCache();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('body'));
  });

  afterEach(() => fetchSpy.mockRestore());

  it('coalesces concurrent requests for the same key into one upstream fetch', async () => {
    const opts = { kind: 'text' as const, timeoutMs: 1000, retries: 0 };
    const [a, b] = await Promise.all([
      fetchUpstreamShared('k', 'http://u/1', {}, opts),
      fetchUpstreamShared('k', 'http://u/1', {}, opts),
    ]);
    expect(a.text).toBe('body');
    expect(b.text).toBe('body');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps pre-warmed entries for their linger and purges them by session', async () => {
    await fetchUpstreamShared('seg', 'http://u/seg', {}, { kind: 'binary', timeoutMs: 1000, retries: 0, lingerMs: 10_000, sessionId: 's1' });
    expect(peekUpstream('seg')).toBeDefined();
    purgeUpstreamSession('s1');
    expect(peekUpstream('seg')).toBeUndefined();
  });

  it('does not keep failed responses', async () => {
    fetchSpy.mockImplementation(async () => new Response('nope', { status: 500 }));
    const r = await fetchUpstreamShared('bad', 'http://u/bad', {}, { kind: 'text', timeoutMs: 1000, retries: 0, lingerMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(peekUpstream('bad')).toBeUndefined();
  });

  it('defers a fetch until `after` settles (fMP4 init after the live segment)', async () => {
    const order: string[] = [];
    fetchSpy.mockImplementation(async (url) => { order.push(String(url)); return new Response('x'); });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const init = fetchUpstreamShared('init', 'http://u/init', {}, { kind: 'binary', timeoutMs: 1000, retries: 0, after: gate });
    await fetchUpstreamShared('live', 'http://u/live', {}, { kind: 'binary', timeoutMs: 1000, retries: 0 });
    expect(order).toEqual(['http://u/live']);
    release();
    await init;
    expect(order).toEqual(['http://u/live', 'http://u/init']);
  });
});

describe('sanitizeRenditions', () => {
  // Real Jellyfin master for a film with two Chinese text tracks (AVPlayer: -12642 duplicate name).
  const MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English - Default - MOV_TEXT",DEFAULT=YES,FORCED=NO,AUTOSELECT=YES,URI="/a.m3u8",LANGUAGE="eng"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Chinese - MOV_TEXT",DEFAULT=NO,FORCED=NO,AUTOSELECT=YES,URI="/b.m3u8",LANGUAGE="chi"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Chinese - MOV_TEXT",DEFAULT=YES,FORCED=NO,AUTOSELECT=YES,URI="/c.m3u8",LANGUAGE="chi"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="subs"',
    'main.m3u8',
  ].join('\n');

  it('makes rendition names unique within a group and keeps one DEFAULT', () => {
    const lines = sanitizeRenditions(MASTER).split('\n');
    expect(lines[2]).toContain('NAME="Chinese - MOV_TEXT"');
    expect(lines[3]).toContain('NAME="Chinese - MOV_TEXT (2)"');
    expect(lines[3]).toContain('DEFAULT=NO');
    expect(lines[1]).toContain('DEFAULT=YES');
    expect(lines[5]).toBe('main.m3u8');
  });

  it('treats the same name in different groups as distinct', () => {
    const p = [
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="a",NAME="English",URI="/1.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="b",NAME="English",URI="/2.m3u8"',
    ].join('\n');
    expect(sanitizeRenditions(p)).toBe(p);
  });

  it('leaves playlists without renditions untouched', () => {
    expect(sanitizeRenditions(MEDIA_PLAYLIST)).toBe(MEDIA_PLAYLIST);
  });
});
