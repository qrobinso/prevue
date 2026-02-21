import type { Channel, ScheduleBlock, PlaybackInfo, Settings } from '../types';

const API_BASE = '/api';
const REQUEST_TIMEOUT_MS = 20000; // 20s - default timeout
const LONG_REQUEST_TIMEOUT_MS = 120000; // 120s - for long operations like channel generation

// ─── API Key auth ─────────────────────────────────────

let apiKey: string | null = sessionStorage.getItem('prevue_api_key');
let onAuthRequired: (() => void) | null = null;

export function setApiKey(key: string): void {
  apiKey = key;
  sessionStorage.setItem('prevue_api_key', key);
}

export function getStoredApiKey(): string | null {
  return apiKey;
}

export function clearApiKey(): void {
  apiKey = null;
  sessionStorage.removeItem('prevue_api_key');
}

/** Register a callback invoked when the server returns 401. */
export function onUnauthorized(handler: () => void): void {
  onAuthRequired = handler;
}

/** Check whether the server requires API key auth. */
export async function getAuthStatus(): Promise<{ required: boolean }> {
  const res = await fetch(`${API_BASE}/auth/status`);
  return res.json();
}

// ─── Generic request helper ───────────────────────────

/** Map raw server errors to safe user-facing messages. */
function safeErrorMessage(raw: string): string {
  // Let well-known messages through
  const passthrough = [
    'Request timed out',
    'Channel not found',
    'Server not found',
    'Setting not found',
    'No program currently airing',
    'Unauthorized',
  ];
  if (passthrough.some(p => raw.includes(p))) return raw;
  // Generic fallback for unexpected server details
  if (raw.length > 200 || /stack|at\s+\w|SQLITE|ECONNREFUSED/i.test(raw)) {
    return 'Something went wrong. Please try again.';
  }
  return raw;
}

async function request<T>(url: string, options?: RequestInit, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string>),
    };
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    const response = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 401) {
      onAuthRequired?.();
      throw new Error('Unauthorized');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(safeErrorMessage(error.error || response.statusText));
    }

    return response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        throw new Error('Request timed out. The operation may still be processing. Try refreshing.');
      }
      throw err;
    }
    throw err;
  }
}

// ─── Channels ─────────────────────────────────────────

export type ChannelWithProgram = Channel & {
  current_program: import('../types').ScheduleProgram | null;
  next_program: import('../types').ScheduleProgram | null;
  schedule_generated_at: string | null;
  schedule_updated_at: string | null;
};

export async function getChannels(): Promise<ChannelWithProgram[]> {
  return request('/channels');
}

export async function createChannel(name: string, item_ids: string[]): Promise<Channel> {
  return request('/channels', {
    method: 'POST',
    body: JSON.stringify({ name, item_ids }),
  });
}

export async function createAIChannel(prompt: string): Promise<{ channel: Channel; ai_description: string }> {
  return request('/channels/ai', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
}

export async function refreshAIChannel(id: number): Promise<{ channel: Channel; ai_description: string }> {
  return request(`/channels/${id}/ai-refresh`, { method: 'PUT' });
}

export async function updateChannel(id: number, data: Partial<Channel>): Promise<Channel> {
  return request(`/channels/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteChannel(id: number): Promise<void> {
  return request(`/channels/${id}`, { method: 'DELETE' });
}

export async function getAIStatus(): Promise<{ available: boolean }> {
  return request('/channels/ai/status');
}

export interface AIConfig {
  hasKey: boolean;
  hasUserKey: boolean;
  hasEnvKey: boolean;
  model: string;
  defaultModel: string;
  available: boolean;
}

export async function getAIConfig(): Promise<AIConfig> {
  return request('/channels/ai/config');
}

export async function updateAIConfig(config: { apiKey?: string; model?: string }): Promise<AIConfig> {
  return request('/channels/ai/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function getAISuggestions(): Promise<{ suggestions: string[] }> {
  return request('/channels/ai/suggestions');
}

export async function regenerateChannels(): Promise<{ channels_created: number }> {
  return request('/channels/regenerate', { method: 'POST' });
}

export async function getGenres(): Promise<{ genre: string; count: number; totalDurationMs: number }[]> {
  return request('/channels/genres');
}

export interface RatingsResponse {
  ratings: { rating: string; count: number }[];
  unratedCount: number;
}

export async function getRatings(): Promise<RatingsResponse> {
  return request('/channels/ratings');
}

export async function searchLibrary(query: string): Promise<unknown[]> {
  return request(`/channels/search?q=${encodeURIComponent(query)}`);
}

// ─── Channel Presets ────────────────────────────────────

export interface ChannelPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  isDynamic?: boolean;
  dynamicType?: 'genres' | 'eras' | 'directors' | 'actors' | 'composers' | 'collections' | 'playlists' | 'studios';
}

export interface PresetCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export interface ChannelPresetData {
  categories: PresetCategory[];
  presets: ChannelPreset[];
}

export async function getChannelPresets(): Promise<ChannelPresetData> {
  return request('/channels/presets');
}

export interface PresetPreview {
  count: number;
  totalDurationMs: number;
  isDynamic?: boolean;
  dynamicChannels?: { name: string; count: number }[];
}

export async function previewPreset(presetId: string): Promise<PresetPreview> {
  return request(`/channels/presets/${presetId}/preview`);
}

export async function createPresetChannel(presetId: string): Promise<Channel> {
  return request(`/channels/presets/${presetId}`, { method: 'POST' });
}

export async function generateChannels(presetIds: string[]): Promise<{ channels_created: number; channels: Channel[] }> {
  // Use longer timeout for channel generation (syncs library + fetches collections)
  return request('/channels/generate', {
    method: 'POST',
    body: JSON.stringify({ preset_ids: presetIds }),
  }, LONG_REQUEST_TIMEOUT_MS);
}

export async function getSelectedPresets(): Promise<string[]> {
  return request('/channels/selected-presets');
}

// ─── Schedule ─────────────────────────────────────────

export async function getSchedule(): Promise<Record<number, { channel: Channel; blocks: ScheduleBlock[] }>> {
  return request('/schedule');
}

export async function getChannelSchedule(channelId: number): Promise<ScheduleBlock[]> {
  return request(`/schedule/${channelId}`);
}

export async function getCurrentProgram(channelId: number): Promise<{
  program: import('../types').ScheduleProgram;
  next: import('../types').ScheduleProgram | null;
  seekMs: number;
}> {
  return request(`/schedule/${channelId}/now`);
}

export interface ProgramDetails {
  overview: string | null;
  genres?: string[];
}

export async function getProgramDetails(itemId: string): Promise<ProgramDetails> {
  return request(`/schedule/item/${encodeURIComponent(itemId)}`);
}

// ─── Playback ─────────────────────────────────────────

export interface QualityParams {
  bitrate?: number;
  maxWidth?: number;
  audioStreamIndex?: number;
}

/**
 * Detect whether the browser supports HEVC (H.265) for HLS playback.
 *
 * Two detection paths:
 *  1. MSE path (HLS.js browsers): MediaSource.isTypeSupported for desktop Chrome/Edge.
 *  2. Native HLS path (iOS/macOS Safari): Safari handles HLS natively without MSE,
 *     so MediaSource is unavailable. Use video.canPlayType() as a fallback — it
 *     correctly reports HEVC support on iOS 11+ and macOS Safari.
 */
let _hevcSupported: boolean | null = null;
function supportsHevc(): boolean {
  if (_hevcSupported !== null) return _hevcSupported;
  try {
    // Path 1: MSE-based check (HLS.js path — desktop browsers).
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
      const msePassed =
        MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.B0"') ||
        MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L150.B0"');
      if (msePassed) {
        _hevcSupported = true;
        return _hevcSupported;
      }
    }
    // Path 2: Native HLS check (iOS Safari, macOS Safari). Works without MSE.
    const video = document.createElement('video');
    const canPlay =
      video.canPlayType('video/mp4; codecs="hvc1"') ||
      video.canPlayType('video/mp4; codecs="hvc1.1.6.L150.B0"');
    _hevcSupported = canPlay === 'probably' || canPlay === 'maybe';
  } catch {
    _hevcSupported = false;
  }
  return _hevcSupported;
}

export async function getPlaybackInfo(
  channelId: number,
  quality?: QualityParams
): Promise<PlaybackInfo & { is_interstitial: boolean }> {
  const params = new URLSearchParams();
  if (quality?.bitrate) params.set('bitrate', String(quality.bitrate));
  if (quality?.maxWidth) params.set('maxWidth', String(quality.maxWidth));
  if (quality?.audioStreamIndex != null) params.set('audioStreamIndex', String(quality.audioStreamIndex));
  if (supportsHevc()) params.set('hevc', '1');
  
  const queryString = params.toString();
  return request(`/playback/${channelId}${queryString ? `?${queryString}` : ''}`);
}

export async function stopPlayback(itemId?: string, playSessionId?: string, positionMs?: number): Promise<{ success: boolean }> {
  return request('/stream/stop', {
    method: 'POST',
    body: JSON.stringify({ itemId, playSessionId, positionMs }),
  });
}

export async function reportPlaybackProgress(itemId: string, positionMs: number): Promise<{ success: boolean; reported: boolean }> {
  return request('/stream/progress', {
    method: 'POST',
    body: JSON.stringify({ itemId, positionMs }),
  });
}

// ─── Settings ─────────────────────────────────────────

export async function getSettings(): Promise<Record<string, unknown>> {
  return request('/settings');
}

export async function updateSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request('/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

export async function factoryReset(): Promise<{ success: boolean }> {
  return request('/settings/factory-reset', { method: 'POST' });
}

// ─── Servers ──────────────────────────────────────────

export interface ServerInfo {
  id: number;
  name: string;
  url: string;
  username: string;
  is_active: boolean;
  is_authenticated: boolean;
  created_at?: string;
}

export interface DiscoveredServer {
  id: string;
  name: string;
  address: string;
}

export async function discoverServers(): Promise<DiscoveredServer[]> {
  return request('/servers/discover');
}

export async function getServers(): Promise<ServerInfo[]> {
  return request('/servers');
}

export async function addServer(name: string, url: string, username: string, password: string): Promise<ServerInfo> {
  return request('/servers', {
    method: 'POST',
    body: JSON.stringify({ name, url, username, password }),
  });
}

export async function updateServer(
  id: number,
  data: Partial<{ name: string; url: string; username: string; password: string }>
): Promise<ServerInfo> {
  return request(`/servers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteServer(id: number): Promise<void> {
  return request(`/servers/${id}`, { method: 'DELETE' });
}

export async function testServer(id: number): Promise<{ connected: boolean; authenticated: boolean }> {
  return request(`/servers/${id}/test`, { method: 'POST' });
}

export async function activateServer(id: number): Promise<void> {
  return request(`/servers/${id}/activate`, { method: 'POST' });
}

export async function resyncServer(id: number): Promise<{ success: boolean; item_count: number }> {
  return request(`/servers/${id}/resync`, { method: 'POST' }, LONG_REQUEST_TIMEOUT_MS);
}

export async function reauthenticateServer(id: number, password: string): Promise<{ success: boolean; authenticated: boolean }> {
  return request(`/servers/${id}/reauthenticate`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// ─── Metrics ──────────────────────────────────────────

export async function metricsStart(data: {
  client_id: string;
  channel_id?: number;
  channel_name?: string;
  item_id?: string;
  title?: string;
  series_name?: string;
  content_type?: string;
}): Promise<{ success: boolean; session_id?: number; enabled?: boolean }> {
  return request('/metrics/start', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function metricsStop(clientId: string): Promise<{ success: boolean }> {
  return request('/metrics/stop', {
    method: 'POST',
    body: JSON.stringify({ client_id: clientId }),
  });
}

export async function metricsChannelSwitch(data: {
  client_id: string;
  from_channel_id?: number;
  from_channel_name?: string;
  to_channel_id?: number;
  to_channel_name?: string;
}): Promise<{ success: boolean }> {
  return request('/metrics/channel-switch', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export interface MetricsDashboard {
  enabled: boolean;
  summary?: {
    total_watch_seconds: number;
    total_sessions: number;
    active_clients: number;
  };
  topChannels?: { channel_id: number; channel_name: string; total_seconds: number; session_count: number }[];
  topShows?: { item_id: string; title: string; content_type: string | null; total_seconds: number; session_count: number }[];
  topSeries?: { series_name: string; total_seconds: number; session_count: number; episode_count: number }[];
  topClients?: { client_id: string; user_agent: string | null; total_seconds: number; session_count: number; last_seen: string | null }[];
  hourlyActivity?: { hour: number; total_seconds: number; session_count: number }[];
  recentSessions?: {
    id: number;
    client_id: string;
    channel_name: string | null;
    title: string | null;
    content_type: string | null;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number;
  }[];
}

export async function getMetricsDashboard(range: string = '7d'): Promise<MetricsDashboard> {
  return request(`/metrics/dashboard?range=${encodeURIComponent(range)}`);
}

export async function clearMetricsData(): Promise<{ success: boolean }> {
  return request('/metrics/data', { method: 'DELETE' });
}

// ─── IPTV ─────────────────────────────────────────

export interface IPTVStatus {
  enabled: boolean;
  playlistUrl: string;
  epgUrl: string;
  channelCount: number;
}

export async function getIPTVStatus(): Promise<IPTVStatus> {
  return request('/iptv/status');
}

// ─── Health ───────────────────────────────────────────

export async function healthCheck(): Promise<{ status: string }> {
  return request('/health');
}
