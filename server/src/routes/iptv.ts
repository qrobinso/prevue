import { Router } from 'express';
import type { Request, Response } from 'express';
import os from 'os';
import * as queries from '../db/queries.js';
import { isAuthEnabled, getApiKey } from '../middleware/auth.js';
import { rewriteM3u8Urls, activeSessions, lastActivityByItemId, iptvSessionInfo } from './stream.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import type { JellyfinClient } from '../services/JellyfinClient.js';
import type { ChannelParsed } from '../types/index.js';

export const iptvRoutes = Router();

// ─── Helpers ─────────────────────────────────────────

function isIptvEnabled(db: import('better-sqlite3').Database): boolean {
  const val = queries.getSetting(db, 'iptv_enabled');
  return val === true || val === 'true';
}

/** Get the first non-internal IPv4 address (LAN IP). */
function getLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function getBaseUrl(req: Request, db: import('better-sqlite3').Database): string {
  const configured = queries.getSetting(db, 'iptv_base_url') as string | undefined;
  if (configured && typeof configured === 'string' && configured.length > 0) {
    return configured.replace(/\/+$/, '');
  }
  // When accessed from localhost, substitute the server's LAN IP so the
  // URLs are usable by other devices on the network (IPTV players, etc.)
  const host = req.get('host') || 'localhost';
  const hostname = host.split(':')[0];
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    const lanIp = getLanIp();
    if (lanIp) {
      const port = host.includes(':') ? ':' + host.split(':')[1] : '';
      return `${req.protocol}://${lanIp}${port}`;
    }
  }
  return `${req.protocol}://${host}`;
}

function getTokenParam(req: Request): string | undefined {
  const token = req.query.token as string | undefined;
  return token;
}

function appendToken(url: string, token: string | undefined): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

function requireIptvAuth(req: Request, res: Response): boolean {
  if (!isAuthEnabled()) return true;
  const token = getTokenParam(req);
  if (token && token === getApiKey()) return true;
  res.status(401).json({ error: 'Unauthorized. Provide a valid token via ?token= query parameter.' });
  return false;
}

function toXmltvDate(isoString: string): string {
  const d = new Date(isoString);
  const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getChannelLogo(channel: ChannelParsed, baseUrl: string, token: string | undefined): string | null {
  if (channel.item_ids.length === 0) return null;
  const firstItemId = channel.item_ids[0];
  const logoUrl = `${baseUrl}/api/images/${firstItemId}/Primary?maxWidth=200`;
  return appendToken(logoUrl, token);
}

// ─── EPG Cache ───────────────────────────────────────

let epgCache: { xml: string; generatedAt: number; channelCount: number; hours: number; baseUrl: string } | null = null;
const EPG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Routes ──────────────────────────────────────────

// GET /playlist.m3u - M3U playlist with all channels
iptvRoutes.get('/playlist.m3u', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    if (!requireIptvAuth(req, res)) return;
    if (!isIptvEnabled(db)) {
      res.status(403).json({ error: 'IPTV server is disabled. Enable it in Settings > IPTV.' });
      return;
    }

    const channels = queries.getAllChannels(db);
    const baseUrl = getBaseUrl(req, db);
    const token = isAuthEnabled() ? (getTokenParam(req) || getApiKey()) : undefined;
    const epgUrl = appendToken(`${baseUrl}/api/iptv/epg.xml`, token);

    let m3u = `#EXTM3U url-tvg="${epgUrl}"\n`;

    for (const ch of channels) {
      const logo = getChannelLogo(ch, baseUrl, token);
      const group = ch.genre || ch.type || 'General';
      const streamUrl = appendToken(`${baseUrl}/api/iptv/channel/${ch.number}`, token);

      m3u += `#EXTINF:-1 tvg-id="ch-${ch.number}" tvg-name="${ch.name}" tvg-chno="${ch.number}"`;
      if (logo) m3u += ` tvg-logo="${logo}"`;
      m3u += ` group-title="${group}",${ch.name}\n`;
      m3u += `${streamUrl}\n`;
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', 'inline; filename="prevue.m3u"');
    res.send(m3u);
  } catch (err) {
    console.error('[IPTV] Playlist generation error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /epg.xml - XMLTV electronic program guide
iptvRoutes.get('/epg.xml', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    if (!requireIptvAuth(req, res)) return;
    if (!isIptvEnabled(db)) {
      res.status(403).json({ error: 'IPTV server is disabled. Enable it in Settings > IPTV.' });
      return;
    }

    const hours = Math.min(48, Math.max(1, parseInt(req.query.hours as string, 10) || 24));
    const channels = queries.getAllChannels(db);
    const baseUrl = getBaseUrl(req, db);
    const token = isAuthEnabled() ? (getTokenParam(req) || getApiKey()) : undefined;

    // Check cache validity
    if (
      epgCache &&
      Date.now() - epgCache.generatedAt < EPG_CACHE_TTL_MS &&
      epgCache.channelCount === channels.length &&
      epgCache.hours === hours &&
      epgCache.baseUrl === baseUrl
    ) {
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', 'inline; filename="prevue-epg.xml"');
      res.send(epgCache.xml);
      return;
    }

    const now = new Date();
    const rangeEnd = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const blocks = queries.getAllScheduleBlocksInRange(db, now.toISOString(), rangeEnd.toISOString());

    // Group blocks by channel_id
    const blocksByChannel = new Map<number, typeof blocks>();
    for (const block of blocks) {
      const arr = blocksByChannel.get(block.channel_id) || [];
      arr.push(block);
      blocksByChannel.set(block.channel_id, arr);
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
    xml += '<tv source-info-name="Prevue" generator-info-name="Prevue IPTV">\n';

    // Channel definitions
    for (const ch of channels) {
      const logo = getChannelLogo(ch, baseUrl, token);
      xml += `  <channel id="ch-${ch.number}">\n`;
      xml += `    <display-name>${escapeXml(`${ch.number} ${ch.name}`)}</display-name>\n`;
      if (logo) {
        xml += `    <icon src="${escapeXml(logo)}" />\n`;
      }
      xml += '  </channel>\n';
    }

    // Programme entries
    for (const ch of channels) {
      const channelBlocks = blocksByChannel.get(ch.id) || [];
      for (const block of channelBlocks) {
        for (const prog of block.programs) {
          if (prog.type === 'interstitial') continue;

          const progEnd = new Date(prog.end_time);
          const progStart = new Date(prog.start_time);
          // Skip programs entirely outside our window
          if (progEnd <= now || progStart >= rangeEnd) continue;

          xml += `  <programme start="${toXmltvDate(prog.start_time)}" stop="${toXmltvDate(prog.end_time)}" channel="ch-${ch.number}">\n`;
          xml += `    <title lang="en">${escapeXml(prog.title)}</title>\n`;

          if (prog.subtitle) {
            xml += `    <sub-title lang="en">${escapeXml(prog.subtitle)}</sub-title>\n`;
          }
          if (prog.description) {
            xml += `    <desc lang="en">${escapeXml(prog.description)}</desc>\n`;
          }
          if (prog.year) {
            xml += `    <date>${prog.year}</date>\n`;
          }

          const category = ch.genre || (prog.content_type === 'movie' ? 'Movie' : prog.content_type === 'episode' ? 'Series' : null);
          if (category) {
            xml += `    <category lang="en">${escapeXml(category)}</category>\n`;
          }
          if (prog.rating) {
            xml += `    <rating>\n`;
            xml += `      <value>${escapeXml(prog.rating)}</value>\n`;
            xml += '    </rating>\n';
          }

          if (prog.thumbnail_url) {
            const iconUrl = appendToken(`${baseUrl}${prog.thumbnail_url}`, token);
            xml += `    <icon src="${escapeXml(iconUrl)}" />\n`;
          }

          xml += '  </programme>\n';
        }
      }
    }

    xml += '</tv>\n';

    // Update cache
    epgCache = { xml, generatedAt: Date.now(), channelCount: channels.length, hours, baseUrl };

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'inline; filename="prevue-epg.xml"');
    res.send(xml);
  } catch (err) {
    console.error('[IPTV] EPG generation error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /channel/:channelNumber - HLS stream for a channel's current program
iptvRoutes.get('/channel/:channelNumber', async (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine, jellyfinClient } = req.app.locals;
    const se = scheduleEngine as ScheduleEngine;
    const jf = jellyfinClient as JellyfinClient;

    if (!requireIptvAuth(req, res)) return;
    if (!isIptvEnabled(db)) {
      res.status(403).json({ error: 'IPTV server is disabled.' });
      return;
    }

    const channelNumber = parseInt(req.params.channelNumber as string, 10);
    if (isNaN(channelNumber)) {
      res.status(400).json({ error: 'Invalid channel number' });
      return;
    }

    const channel = queries.getChannelByNumber(db, channelNumber);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const current = se.getCurrentProgram(channel.id);
    if (!current || current.program.type === 'interstitial') {
      res.status(503).setHeader('Retry-After', '30').json({ error: 'No program currently airing on this channel' });
      return;
    }

    const { program, seekMs } = current;
    const itemId = program.jellyfin_item_id;

    // Get HLS session info from Jellyfin
    const hlsInfo = await jf.getHlsStreamUrl(itemId);
    const { playSessionId, mediaSourceId } = hlsInfo;

    // Track session + record timing so the proxy can build a live window
    activeSessions.set(itemId, { playSessionId, mediaSourceId });
    lastActivityByItemId.set(itemId, Date.now());
    iptvSessionInfo.set(playSessionId, { startTime: Date.now(), seekMs });

    const baseUrl = jf.getBaseUrl();
    const headers = jf.getProxyHeaders();
    const deviceId = jf.getDeviceId();

    // Build Jellyfin HLS URL — use h264/aac for widest IPTV player compatibility
    const params = new URLSearchParams({
      DeviceId: deviceId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      MaxStreamingBitrate: '20000000',
      VideoBitrate: '20000000',
      TranscodingMaxAudioChannels: '2',
      SegmentContainer: 'ts',
      MinSegments: '2',
      BreakOnNonKeyFrames: 'true',
      AllowVideoStreamCopy: 'true',
      AllowAudioStreamCopy: 'true',
      EnableAutoStreamCopy: 'true',
      MaxWidth: '1920',
      MaxHeight: '1080',
    });

    // Note: we do NOT use StartTimeTicks here — Jellyfin's static HLS ignores it
    // and always transcodes from the beginning. Instead, the sliding-window filter
    // in the proxy uses seekMs to expose only the segments at the live position.

    const jellyfinUrl = `${baseUrl}/Videos/${itemId}/master.m3u8?${params}`;
    console.log(`[IPTV] Channel ${channelNumber} → item=${itemId} session=${playSessionId} seek=${Math.round(seekMs / 1000)}s`);

    const response = await fetch(jellyfinUrl, { headers });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[IPTV] Jellyfin returned ${response.status}: ${errorText.slice(0, 500)}`);
      try {
        await jf.stopPlaybackSession(playSessionId);
        await jf.deleteTranscodingJob(playSessionId);
      } catch { /* best-effort cleanup */ }
      activeSessions.delete(itemId);
      lastActivityByItemId.delete(itemId);
      iptvSessionInfo.delete(playSessionId);
      res.status(502).json({ error: 'Jellyfin stream unavailable' });
      return;
    }

    // Rewrite URLs to route through our proxy
    const body = await response.text();
    const baseDir = `/Videos/${itemId}/`;
    let rewritten = rewriteM3u8Urls(body, baseDir, playSessionId, deviceId);

    // Tag proxy URLs with iptv=1 so the proxy applies live-window filtering.
    // Also append auth token if needed.
    const token = isAuthEnabled() ? (getTokenParam(req) || getApiKey()) : undefined;
    rewritten = rewritten.replace(
      /^(\/api\/stream\/proxy\/.*)/gm,
      (match) => {
        let url = match.includes('?') ? `${match}&iptv=1` : `${match}?iptv=1`;
        if (token) url = appendToken(url, token);
        return url;
      }
    );

    // Strip VOD markers from the master playlist itself
    rewritten = rewritten.replace(/^#EXT-X-ENDLIST\s*$/gm, '');
    rewritten = rewritten.replace(/^#EXT-X-PLAYLIST-TYPE:VOD\s*$/gm, '');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(rewritten);
  } catch (err) {
    console.error('[IPTV] Channel stream error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /status - IPTV status for Settings UI
iptvRoutes.get('/status', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const enabled = isIptvEnabled(db);
    const channels = queries.getAllChannels(db);
    const baseUrl = getBaseUrl(req, db);
    const token = isAuthEnabled() ? getApiKey() : undefined;

    res.json({
      enabled,
      playlistUrl: appendToken(`${baseUrl}/api/iptv/playlist.m3u`, token),
      epgUrl: appendToken(`${baseUrl}/api/iptv/epg.xml`, token),
      channelCount: channels.length,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
