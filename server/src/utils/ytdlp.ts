import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Resolve a YouTube (or other yt-dlp-supported) trailer URL into a direct
 * media URL the player can stream, plus the duration for schedule accuracy.
 *
 * Caches resolved URLs per source URL until just before their signed-URL
 * expiry, so repeat plays inside that window skip the yt-dlp invocation.
 */

interface ResolvedTrailer {
  directUrl: string;
  durationMs: number | null;
  expiresAt: number; // epoch ms
}

const cache = new Map<string, ResolvedTrailer>();

const RESOLVE_TIMEOUT_MS = 15_000;
const MAX_CACHE_TTL_MS = 5 * 60 * 60 * 1000; // 5h: googlevideo URLs typically last ~6h

/**
 * Resolve the path to the yt-dlp executable. Tries (in order):
 *   1) `YT_DLP_PATH` env var
 *   2) bare `yt-dlp` (PATH lookup)
 *   3) common Windows install locations (winget, scoop, chocolatey)
 *   4) common POSIX install locations (/usr/local/bin, /usr/bin)
 *
 * The first existing absolute path is returned; if none match, returns
 * `'yt-dlp'` and the spawn will fail with ENOENT (caller catches).
 */
let resolvedExecutable: string | null = null;
function resolveExecutable(): string {
  if (resolvedExecutable) return resolvedExecutable;
  const override = process.env.YT_DLP_PATH;
  if (override && fs.existsSync(override)) {
    resolvedExecutable = override;
    return override;
  }
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    if (local) {
      candidates.push(path.join(local, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'));
      candidates.push(path.join(local, 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'));
    }
    if (userProfile) {
      candidates.push(path.join(userProfile, 'scoop', 'shims', 'yt-dlp.exe'));
      candidates.push(path.join(userProfile, 'scoop', 'apps', 'yt-dlp', 'current', 'yt-dlp.exe'));
    }
    candidates.push('C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe');
  } else {
    candidates.push('/usr/local/bin/yt-dlp');
    candidates.push('/usr/bin/yt-dlp');
    candidates.push('/opt/homebrew/bin/yt-dlp');
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        console.log(`[yt-dlp] Using executable at ${candidate}`);
        resolvedExecutable = candidate;
        return candidate;
      }
    } catch { /* ignore */ }
  }
  resolvedExecutable = 'yt-dlp';
  return 'yt-dlp';
}

function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveExecutable(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error('yt-dlp timed out'));
    }, RESOLVE_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Parse a googlevideo "expire" parameter (epoch seconds) out of a direct URL.
 * Returns 0 if absent.
 */
function parseExpiresAt(directUrl: string): number {
  try {
    const url = new URL(directUrl);
    const expire = url.searchParams.get('expire');
    if (!expire) return 0;
    const seconds = parseInt(expire, 10);
    if (!Number.isFinite(seconds)) return 0;
    return seconds * 1000;
  } catch {
    return 0;
  }
}

export async function resolveTrailer(sourceUrl: string): Promise<ResolvedTrailer> {
  const cached = cache.get(sourceUrl);
  if (cached && cached.expiresAt - 30_000 > Date.now()) {
    return cached;
  }

  // We need a SINGLE URL the browser can play directly via <video src>.
  // That means a "progressive" format with BOTH audio and video in one file —
  // YouTube's modern adaptive streams are DASH (separate audio/video tracks),
  // so we filter explicitly to combined formats. Quality is capped at whatever
  // YouTube still serves progressively (typically 720p mp4 / itag 22 or 360p / itag 18).
  const formatSelector = 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best';
  const { stdout, stderr, code } = await runYtDlp([
    '--no-warnings',
    '--no-playlist',
    '-f', formatSelector,
    '--print', 'urls',
    '--print', 'duration',
    '--print', 'format',
    sourceUrl,
  ]);

  if (code !== 0) {
    throw new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 500) || 'no stderr'}`);
  }

  const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    throw new Error('yt-dlp produced no output');
  }

  // First non-empty line is the direct URL; subsequent lines are duration / format
  // in the order requested. A trailing format line with "video only" or "audio only"
  // is a strong signal the browser will play silently / nothing.
  const directUrl = lines[0];
  let durationMs: number | null = null;
  let formatDescription: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const seconds = parseFloat(lines[i]);
    if (durationMs === null && Number.isFinite(seconds) && seconds > 0) {
      durationMs = Math.round(seconds * 1000);
    } else if (formatDescription === null) {
      formatDescription = lines[i];
    }
  }
  console.log(`[yt-dlp] Resolved trailer: format="${formatDescription ?? '?'}", duration=${durationMs ?? '?'}ms, host=${(() => { try { return new URL(directUrl).host; } catch { return '?'; } })()}`);
  if (formatDescription && /(video only|audio only)/i.test(formatDescription)) {
    console.warn('[yt-dlp] Selected format is not progressive — browser may play silently or not at all. Format:', formatDescription);
  }

  const parsedExpires = parseExpiresAt(directUrl);
  const cap = Date.now() + MAX_CACHE_TTL_MS;
  const expiresAt = parsedExpires > 0 ? Math.min(parsedExpires, cap) : cap;

  const resolved: ResolvedTrailer = { directUrl, durationMs, expiresAt };
  cache.set(sourceUrl, resolved);

  // Lazy LRU: drop expired entries when the cache grows large.
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
  }

  return resolved;
}

// Only cache successful detection. If yt-dlp wasn't found, re-check on next
// request so the user can install it without restarting the server.
let ytDlpAvailable: boolean | null = null;
export async function isYtDlpAvailable(): Promise<boolean> {
  if (ytDlpAvailable === true) return true;
  // Reset the cached executable path so resolveExecutable rescans
  // (the user may have just installed yt-dlp).
  resolvedExecutable = null;
  try {
    const { code } = await runYtDlp(['--version']);
    if (code === 0) {
      ytDlpAvailable = true;
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}
