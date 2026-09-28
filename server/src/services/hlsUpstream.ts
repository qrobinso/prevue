/**
 * Upstream fetch helpers for the HLS proxy (Jellyfin/Plex → prevue → player).
 *
 * - Playlists are small text and are fetched buffered, with concurrent requests
 *   for the same URL coalesced (so hls.js retries don't start duplicate ffmpegs).
 * - Media segments are normally streamed straight through (see stream.ts), but a
 *   pre-warm can fetch a segment ahead of the player and park it here so the
 *   player's request is served from memory (or joins the in-flight fetch).
 *
 * Cache keys ignore the client-auth params (`token`, `api_key`) and param order,
 * so a pre-warm and the player's later proxied request map to the same entry.
 */

export interface UpstreamResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  text: string | null;
  buffer: Buffer | null;
}

interface Entry {
  promise: Promise<UpstreamResult>;
  /** Epoch ms after which the entry is dropped; Infinity while in flight. */
  expiresAt: number;
  sessionId: string | null;
}

/** Query params the player adds for prevue's own auth — never forwarded upstream. */
export const CLIENT_AUTH_PARAMS = ['token', 'api_key'] as const;

const MAX_ENTRIES = 24;
/** How long a coalesced (non-prewarm) result is shared after it settles. */
const DEDUP_LINGER_MS = 100;
/** How long a pre-warmed playlist/segment waits for the player to ask for it. */
export const PREWARM_TEXT_TTL_MS = 30_000;
export const PREWARM_BINARY_TTL_MS = 15_000;

const entries = new Map<string, Entry>();

/** Normalized cache key: path + sorted query params, minus client-auth params. */
export function upstreamKey(path: string, params: URLSearchParams): string {
  const kept = [...params.entries()]
    .filter(([k]) => !(CLIENT_AUTH_PARAMS as readonly string[]).includes(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  return `${path}?${new URLSearchParams(kept).toString()}`;
}

/** Remove prevue's client-auth params in place; returns the token that was present (if any). */
export function stripClientAuthParams(params: URLSearchParams): string | undefined {
  const token = params.get('token') ?? params.get('api_key') ?? undefined;
  for (const p of CLIENT_AUTH_PARAMS) params.delete(p);
  return token || undefined;
}

function prune(now: number): void {
  for (const [k, e] of entries) {
    if (now > e.expiresAt) entries.delete(k);
  }
  // Bound memory (pre-warmed 4K segments can be tens of MB): drop oldest settled first.
  if (entries.size > MAX_ENTRIES) {
    for (const [k, e] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (e.expiresAt !== Infinity) entries.delete(k);
    }
  }
}

/** A pending or unexpired entry for `key`, if any (does not start a fetch). */
export function peekUpstream(key: string): Promise<UpstreamResult> | undefined {
  const e = entries.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) {
    entries.delete(key);
    return undefined;
  }
  return e.promise;
}

/**
 * fetch() whose timeout covers only the wait for response headers — a slow
 * transcode can take a while to produce a segment, but once bytes flow the body
 * must not be cut off mid-stream. Retries on header timeouts.
 */
export async function fetchWithHeaderTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  retries: number,
  externalSignal?: AbortSignal,
): Promise<{ response: Response; abort: () => void }> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      return { response, abort: () => controller.abort() };
    } catch (err) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      const isTimeout = timedOut || (err as any)?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT';
      if (isTimeout && attempt < retries && !externalSignal?.aborted) {
        console.warn(`[Stream Proxy] Timeout on attempt ${attempt + 1}, retrying`);
        continue;
      }
      throw err;
    }
  }
}

async function fetchBuffered(
  url: string,
  headers: Record<string, string>,
  kind: 'text' | 'binary',
  timeoutMs: number,
  retries: number,
): Promise<UpstreamResult> {
  const { response } = await fetchWithHeaderTimeout(url, headers, timeoutMs, retries);
  const contentType = response.headers.get('content-type');
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status, contentType, text: null, buffer: null };
  }
  if (kind === 'text') {
    return { ok: true, status: response.status, contentType, text: await response.text(), buffer: null };
  }
  return { ok: true, status: response.status, contentType, text: null, buffer: Buffer.from(await response.arrayBuffer()) };
}

/**
 * Fetch (buffered) through the shared table. An existing pending/unexpired entry
 * for the key is reused; otherwise a new fetch is started and kept for `lingerMs`
 * after it settles. Failures are never kept, so the next request retries fresh.
 */
export function fetchUpstreamShared(
  key: string,
  url: string,
  headers: Record<string, string>,
  opts: {
    kind: 'text' | 'binary'; timeoutMs: number; retries: number; lingerMs?: number; sessionId?: string | null;
    /** Start the upstream fetch only after this settles (the entry is registered immediately). */
    after?: Promise<unknown>;
  },
): Promise<UpstreamResult> {
  const now = Date.now();
  const existing = peekUpstream(key);
  if (existing) {
    // A pre-warm may upgrade a short dedup linger to a longer hold.
    const e = entries.get(key);
    if (e && opts.lingerMs && e.expiresAt !== Infinity) e.expiresAt = Math.max(e.expiresAt, now + opts.lingerMs);
    return existing;
  }
  prune(now);
  const linger = opts.lingerMs ?? DEDUP_LINGER_MS;
  const entry: Entry = { promise: null as unknown as Promise<UpstreamResult>, expiresAt: Infinity, sessionId: opts.sessionId ?? null };
  const start = opts.after
    ? opts.after.then(() => {}, () => {}).then(() => fetchBuffered(url, headers, opts.kind, opts.timeoutMs, opts.retries))
    : fetchBuffered(url, headers, opts.kind, opts.timeoutMs, opts.retries);
  entry.promise = start.then(
    (result) => {
      if (entries.get(key) === entry) {
        if (result.ok) entry.expiresAt = Date.now() + linger;
        else entries.delete(key);
      }
      return result;
    },
    (err) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    },
  );
  entries.set(key, entry);
  return entry.promise;
}

/** Drop every cached entry belonging to a stopped session (frees pre-warmed segments). */
export function purgeUpstreamSession(sessionId: string): void {
  for (const [k, e] of entries) {
    if (e.sessionId === sessionId) entries.delete(k);
  }
}

/** Test helper. */
export function clearUpstreamCache(): void {
  entries.clear();
}

// ─── Playlist helpers ────────────────────────────────────

/**
 * Insert `#EXT-X-START:TIME-OFFSET=<sec>,PRECISE=NO` into a media playlist so the
 * player's FIRST segment request is the live one. Without it AVPlayer/hls.js
 * start buffering at segment 0 and only then seek — on Jellyfin that starts
 * ffmpeg at 0 and then kills/restarts it at the seek target (two cold starts).
 * PRECISE=NO starts at the containing segment's boundary (fast); the client's
 * own seek refines within tolerance. No-op for master playlists, playlists that
 * already carry the tag, or a non-positive offset.
 */
export function injectStartOffset(playlist: string, offsetSec: number): string {
  if (!(offsetSec > 0)) return playlist;
  if (!playlist.includes('#EXTINF') || playlist.includes('#EXT-X-START')) return playlist;
  const tag = `#EXT-X-START:TIME-OFFSET=${offsetSec.toFixed(3)},PRECISE=NO`;
  const idx = playlist.indexOf('#EXTM3U');
  if (idx < 0) return playlist;
  const lineEnd = playlist.indexOf('\n', idx);
  if (lineEnd < 0) return `${playlist}\n${tag}\n`;
  return `${playlist.slice(0, lineEnd + 1)}${tag}\n${playlist.slice(lineEnd + 1)}`;
}

/**
 * From a (rewritten) media playlist, the URI of the segment containing `offsetSec`,
 * the one after it, and the fMP4 init segment (`#EXT-X-MAP`) if present.
 */
export function segmentsAtOffset(playlist: string, offsetSec: number): { init: string | null; segment: string | null; next: string | null } {
  const lines = playlist.split('\n').map((l) => l.trim());
  let init: string | null = null;
  const segs: { uri: string; start: number; end: number }[] = [];
  let cum = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MAP:')) {
      init = line.match(/URI="([^"]+)"/)?.[1] ?? init;
    } else if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.slice('#EXTINF:'.length)) || 0;
      // Next non-tag, non-empty line is the segment URI.
      let j = i + 1;
      while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++;
      if (j < lines.length) {
        segs.push({ uri: lines[j], start: cum, end: cum + dur });
        i = j;
      }
      cum += dur;
    }
  }
  if (segs.length === 0) return { init, segment: null, next: null };
  let idx = segs.findIndex((s) => offsetSec >= s.start && offsetSec < s.end);
  if (idx < 0) idx = offsetSec <= 0 ? 0 : segs.length - 1;
  return { init, segment: segs[idx].uri, next: segs[idx + 1]?.uri ?? null };
}

/**
 * Make `#EXT-X-MEDIA` renditions valid for AVPlayer: NAME must be unique within a
 * GROUP-ID, and at most one member may be DEFAULT=YES. Jellyfin names subtitle
 * renditions "<Language> - <Codec>", so two tracks in one language (e.g. Simplified +
 * Traditional Chinese, or a full + SDH English) collide — AVPlayer then rejects the
 * whole master playlist (CoreMedia -12642 "duplicate name"), while hls.js tolerates it.
 * Duplicates get a " (2)", " (3)"… suffix; extra DEFAULT=YES flags become NO.
 */
export function sanitizeRenditions(playlist: string): string {
  if (!playlist.includes('#EXT-X-MEDIA:')) return playlist;
  const namesByGroup = new Map<string, Set<string>>();
  const groupsWithDefault = new Set<string>();
  return playlist.split('\n').map((line) => {
    if (!line.startsWith('#EXT-X-MEDIA:')) return line;
    const type = line.match(/TYPE=([A-Z-]+)/)?.[1] ?? '';
    const group = `${type}|${line.match(/GROUP-ID="([^"]*)"/)?.[1] ?? ''}`;
    let out = line;
    const name = line.match(/NAME="([^"]*)"/)?.[1];
    if (name != null) {
      const used = namesByGroup.get(group) ?? new Set<string>();
      namesByGroup.set(group, used);
      let unique = name;
      for (let n = 2; used.has(unique); n++) unique = `${name} (${n})`;
      used.add(unique);
      if (unique !== name) out = out.replace(`NAME="${name}"`, `NAME="${unique}"`);
    }
    if (/DEFAULT=YES/.test(out)) {
      if (groupsWithDefault.has(group)) out = out.replace('DEFAULT=YES', 'DEFAULT=NO');
      else groupsWithDefault.add(group);
    }
    return out;
  }).join('\n');
}
