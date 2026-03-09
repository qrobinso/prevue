export interface ServerConfig {
  id: number;
  name: string;
  url: string;
  server_type: 'jellyfin' | 'plex';
  username: string;
  access_token: string | null;
  user_id: string | null;
  plex_client_id: string | null;
  is_active: boolean;
  created_at: string;
}

// Channel preset categories
export type ChannelPresetCategory = 
  | 'auto'            // Auto-generated (Genres, Eras based on library content)
  | 'collections'     // Jellyfin collections (BoxSets)
  | 'time_mood'       // Time & mood based (Late Night, Saturday Morning)
  | 'era'             // Era/Decade (90s, 2000s, Classic Cinema)
  | 'content_type'    // Content type (Movies Only, TV Only, Short Block)
  | 'audience'        // Audience rating (Kids, Family, Adults Only)
  | 'behavioral'      // Smart/behavioral (Unwatched, Favorites, Continue Watching)
  | 'thematic'        // Curated themes (Award Winners, Holiday, Director)
  | 'format'          // Format-driven (Anthology, Marathon, Shuffle)
  | 'cast'            // Cast & Crew (Directors, Lead Actors)
  | 'genre'           // Legacy genre category (may be removed)
  | 'custom';         // User-defined

// Channel preset definition
export interface ChannelPreset {
  id: string;
  name: string;
  description: string;
  category: ChannelPresetCategory;
  icon?: string;
  filter: ChannelFilter;
  // For dynamic presets that generate multiple channels based on library content
  isDynamic?: boolean;
  dynamicType?: 'genres' | 'eras' | 'directors' | 'actors' | 'composers' | 'collections' | 'playlists' | 'studios' | 'networks';
}

// Filter criteria for channel content
export interface ChannelFilter {
  // Content types
  includeMovies?: boolean;
  includeEpisodes?: boolean;
  
  // Genre filters
  genres?: string[];
  excludeGenres?: string[];
  
  // Year/Era filters
  minYear?: number;
  maxYear?: number;
  releasedInLastDays?: number;  // For "New Releases"
  
  // Rating filters (parental)
  ratings?: string[];  // e.g., ['G', 'PG', 'PG-13']
  excludeRatings?: string[];
  
  // Duration filters
  minDurationMinutes?: number;
  maxDurationMinutes?: number;
  
  // Studio/Network
  studios?: string[];
  
  // Behavioral (requires watch history)
  unwatchedOnly?: boolean;
  favoritesOnly?: boolean;
  continueWatching?: boolean;
  notWatchedInDays?: number;  // For "Forgotten Gems"
  
  // Series-specific
  seriesIds?: string[];  // For marathon/franchise channels
  
  // Cast & Crew filters
  directors?: string[];  // Filter by director names
  actors?: string[];     // Filter by actor names
  composers?: string[];  // Filter by composer names
  
  // Collection filter
  collectionId?: string;  // Collection/BoxSet ID
  playlistId?: string;    // Playlist ID
  
  // Special modes
  shuffleMode?: boolean;
  marathonMode?: boolean;  // Play series in order
  anthologyMode?: boolean;  // One episode per series
}

export interface Channel {
  id: number;
  number: number;
  name: string;
  type: 'auto' | 'custom' | 'preset';
  genre: string | null;
  preset_id: string | null;  // Reference to ChannelPreset.id
  filter: string | null;     // JSON string of ChannelFilter
  item_ids: string;          // JSON string in DB
  ai_prompt: string | null;
  sort_order: number;
  created_at: string;
}

export interface ChannelParsed extends Omit<Channel, 'item_ids' | 'filter'> {
  item_ids: string[];
  filter: ChannelFilter | null;
}

export interface IconicScene {
  name: string;              // e.g. "I am your father"
  timestamp_minutes: number; // minutes into the film when the scene starts
  end_minutes: number;       // minutes into the film when the scene ends
  why: string;               // 1-2 sentences on why it's iconic
}

export interface ScheduleProgram {
  media_item_id: string;
  title: string;
  subtitle: string | null;
  start_time: string;
  end_time: string;
  duration_ms: number;
  type: 'program' | 'interstitial';
  content_type: 'movie' | 'episode' | null;
  backdrop_url?: string | null;
  guide_url?: string | null;
  thumbnail_url: string | null;
  banner_url: string | null;
  year: number | null;
  rating: string | null;
  resolution: string | null;
  is_hdr: boolean | null;
  genres: string[] | null;
  description: string | null;
  iconic_scenes?: IconicScene[] | null;
}

export interface ScheduleBlock {
  id: number;
  channel_id: number;
  block_start: string;
  block_end: string;
  programs: string;    // JSON string in DB
  seed: string;
  created_at: string;
}

export interface ScheduleBlockParsed extends Omit<ScheduleBlock, 'programs'> {
  programs: ScheduleProgram[];
}

export interface MediaItem {
  Id: string;
  Name: string;
  Type: string;           // 'Movie' | 'Episode' | 'Series'
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;   // Episode number
  ParentIndexNumber?: number; // Season number
  RunTimeTicks?: number;
  Genres?: string[];
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[] | null;
  ParentBackdropImageTags?: string[] | null;
  ParentBackdropItemId?: string | null;
  Overview?: string;
  ProductionYear?: number;
  SeriesId?: string;
  // Additional metadata for filtering
  OfficialRating?: string;      // Parental rating (G, PG, PG-13, R, TV-MA, etc.)
  Studios?: { Name: string }[]; // Studios/Networks
  DateCreated?: string;         // When added to library
  UserData?: {
    PlayedPercentage?: number;
    Played?: boolean;
    IsFavorite?: boolean;
    LastPlayedDate?: string;
  };
  CommunityRating?: number;    // User community rating (0-10 scale)
  AudienceRating?: number;     // Audience rating (0-10 scale; e.g. Plex RT audience score)
  RatingImage?: string;        // Rating source image key (e.g. "rottentomatoes://image.rating.ripe")
  AudienceRatingImage?: string; // Audience rating source image key (e.g. "rottentomatoes://image.rating.upright")
  Tags?: string[];
  People?: { Name: string; Type: string }[];  // Actors, Directors, etc.
  MediaSources?: { MediaStreams?: { Type?: string; Width?: number; Height?: number; BitDepth?: number; ColorPrimaries?: string; ColorTrc?: string; DOVIPresent?: boolean }[] }[];
}

export interface MediaLibrary {
  Items: MediaItem[];
  TotalRecordCount: number;
}

export interface PlaybackInfo {
  stream_url: string;
  seek_position_ms: number;
  program: ScheduleProgram;
  next_program: ScheduleProgram | null;
  channel: ChannelParsed;
}

export interface WSMessage {
  type: string;
  payload: unknown;
}

// Backwards-compat alias — prefer MediaItem in new code
export type JellyfinItem = MediaItem;
