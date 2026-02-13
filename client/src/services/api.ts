import type { Channel, ScheduleBlock, PlaybackInfo, Settings } from '../types';

const API_BASE = '/api';
const REQUEST_TIMEOUT_MS = 20000; // 20s - default timeout
const LONG_REQUEST_TIMEOUT_MS = 120000; // 120s - for long operations like channel generation

async function request<T>(url: string, options?: RequestInit, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || response.statusText);
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
  dynamicType?: 'genres' | 'eras';
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

export async function getPlaybackInfo(
  channelId: number,
  quality?: QualityParams
): Promise<PlaybackInfo & { is_interstitial: boolean }> {
  const params = new URLSearchParams();
  if (quality?.bitrate) params.set('bitrate', String(quality.bitrate));
  if (quality?.maxWidth) params.set('maxWidth', String(quality.maxWidth));
  if (quality?.audioStreamIndex != null) params.set('audioStreamIndex', String(quality.audioStreamIndex));
  
  const queryString = params.toString();
  return request(`/playback/${channelId}${queryString ? `?${queryString}` : ''}`);
}

export async function stopPlayback(itemId?: string, playSessionId?: string): Promise<{ success: boolean }> {
  return request('/stream/stop', {
    method: 'POST',
    body: JSON.stringify({ itemId, playSessionId }),
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

export async function reauthenticateServer(id: number, password: string): Promise<{ success: boolean; authenticated: boolean }> {
  return request(`/servers/${id}/reauthenticate`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// ─── Health ───────────────────────────────────────────

export async function healthCheck(): Promise<{ status: string }> {
  return request('/health');
}
