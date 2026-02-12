export interface Server {
  id: number;
  name: string;
  url: string;
  api_key: string;
  is_active: boolean;
  created_at: string;
}

export interface Channel {
  id: number;
  number: number;
  name: string;
  type: 'auto' | 'custom' | 'preset';
  genre: string | null;
  preset_id: string | null;
  item_ids: string[];
  ai_prompt: string | null;
  sort_order: number;
  created_at: string;
}

export interface ScheduleProgram {
  jellyfin_item_id: string;
  title: string;
  subtitle: string | null;
  start_time: string;
  end_time: string;
  duration_ms: number;
  type: 'program' | 'interstitial';
  content_type: 'movie' | 'episode' | null;
  thumbnail_url: string | null;
  year: number | null;
  rating: string | null;
}

export interface ScheduleBlock {
  id: number;
  channel_id: number;
  block_start: string;
  block_end: string;
  programs: ScheduleProgram[];
  seed: string;
  created_at: string;
}

export interface SubtitleTrack {
  index: number;
  language: string;
  displayTitle: string;
  isDefault: boolean;
  isForced: boolean;
  url: string;
}

export interface PlaybackInfo {
  stream_url: string;
  seek_position_ms: number;
  seek_position_seconds: number;
  program: ScheduleProgram;
  next_program: ScheduleProgram | null;
  channel: Channel;
  subtitles?: SubtitleTrack[];
}

export interface Settings {
  [key: string]: unknown;
}

export type WSEvent =
  | { type: 'schedule:updated'; payload: { channel_id: number; block: ScheduleBlock } }
  | { type: 'channel:added'; payload: Channel }
  | { type: 'channel:removed'; payload: { id: number } }
  | { type: 'channels:regenerated'; payload: { count: number } }
  | { type: 'library:synced'; payload: { item_count: number } }
  | { type: 'generation:progress'; payload: { step: string; message: string; current?: number; total?: number } };
