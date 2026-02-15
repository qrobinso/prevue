import type { ChannelPreset, ChannelPresetCategory } from '../types/index.js';

// Category metadata for UI grouping
export interface PresetCategoryInfo {
  id: ChannelPresetCategory;
  name: string;
  description: string;
  icon: string;
}

export const PRESET_CATEGORIES: PresetCategoryInfo[] = [
  {
    id: 'auto',
    name: 'Auto',
    description: 'Automatically generated based on your library (genres, eras, collections, directors, actors, composers)',
    icon: '✨',
  },
  {
    id: 'time_mood',
    name: 'Time & Mood',
    description: 'Content for different times and moods',
    icon: '🌙',
  },
  {
    id: 'content_type',
    name: 'Content Type',
    description: 'Filter by format and length',
    icon: '🎬',
  },
  {
    id: 'audience',
    name: 'Audience',
    description: 'Age-appropriate content',
    icon: '👨‍👩‍👧‍👦',
  },
  {
    id: 'behavioral',
    name: 'Smart Channels',
    description: 'Based on your watch history',
    icon: '🧠',
  },
  {
    id: 'thematic',
    name: 'Thematic',
    description: 'Curated themes and collections',
    icon: '🏆',
  },
  {
    id: 'format',
    name: 'Format',
    description: 'Special playback formats',
    icon: '📺',
  },
  {
    id: 'cast',
    name: 'Cast & Crew',
    description: 'Channels based on directors and actors',
    icon: '🎬',
  },
];

// Predefined channel presets
export const CHANNEL_PRESETS: ChannelPreset[] = [
  // ─── Auto Generated ────────────────────────────────────────
  {
    id: 'auto-genres',
    name: 'Genre Channels',
    description: 'Creates channels for each genre in your library',
    category: 'auto',
    icon: '🎭',
    isDynamic: true,
    dynamicType: 'genres',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
    },
  },
  {
    id: 'auto-eras',
    name: 'Era Channels',
    description: 'Creates decade channels based on your content (80s, 90s, etc.)',
    category: 'auto',
    icon: '📅',
    isDynamic: true,
    dynamicType: 'eras',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
    },
  },

  // ─── Collections ───────────────────────────────────────
  {
    id: 'auto-collections',
    name: 'Collection Channels',
    description: 'Creates a channel for each Jellyfin collection (BoxSet)',
    category: 'auto',
    icon: '📚',
    isDynamic: true,
    dynamicType: 'collections',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
    },
  },
  {
    id: 'auto-playlists',
    name: 'Playlist Channels',
    description: 'Creates a channel for each Jellyfin playlist',
    category: 'auto',
    icon: '📝',
    isDynamic: true,
    dynamicType: 'playlists',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
    },
  },

  // ─── Time & Mood Based ───────────────────────────────────
  {
    id: 'late-night',
    name: 'Late Night',
    description: 'Adult comedies, thrillers, and horror for after 10 PM vibes',
    category: 'time_mood',
    icon: '🌙',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      genres: ['Comedy', 'Thriller', 'Horror', 'Crime', 'Mystery'],
      excludeRatings: ['G', 'TV-Y', 'TV-Y7'],
    },
  },
  {
    id: 'saturday-morning',
    name: 'Saturday Morning',
    description: 'Cartoons, anime, and kids content',
    category: 'time_mood',
    icon: '🥣',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      genres: ['Animation', 'Family', 'Kids'],
      ratings: ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'],
    },
  },
  {
    id: 'background-tv',
    name: 'Background TV',
    description: 'Rewatchable sitcoms and low-stakes content',
    category: 'time_mood',
    icon: '☕',
    filter: {
      includeEpisodes: true,
      genres: ['Comedy', 'Reality', 'Talk Show', 'Game Show'],
      maxDurationMinutes: 45,
    },
  },
  {
    id: 'date-night',
    name: 'Date Night',
    description: 'Rom-coms, dramas, and critically acclaimed films',
    category: 'time_mood',
    icon: '💕',
    filter: {
      includeMovies: true,
      genres: ['Romance', 'Drama', 'Comedy'],
      excludeGenres: ['Horror', 'War'],
    },
  },

  // ─── Content Type ────────────────────────────────────────
  {
    id: 'movies-only',
    name: 'Movies Only',
    description: 'Only feature films',
    category: 'content_type',
    icon: '🎬',
    filter: {
      includeMovies: true,
      includeEpisodes: false,
    },
  },
  {
    id: 'tv-only',
    name: 'TV Only',
    description: 'Only TV episodes',
    category: 'content_type',
    icon: '📺',
    filter: {
      includeMovies: false,
      includeEpisodes: true,
    },
  },
  {
    id: 'shorts',
    name: 'Shorts',
    description: 'Content under 30 minutes',
    category: 'content_type',
    icon: '⏱️',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      maxDurationMinutes: 30,
    },
  },
  {
    id: 'long-form',
    name: 'Long Form',
    description: 'Movies over 2 hours',
    category: 'content_type',
    icon: '🎭',
    filter: {
      includeMovies: true,
      minDurationMinutes: 120,
    },
  },

  // ─── Audience ────────────────────────────────────────────
  {
    id: 'kids-channel',
    name: 'Kids Channel',
    description: 'G and PG rated content only',
    category: 'audience',
    icon: '🧒',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      ratings: ['G', 'TV-Y', 'TV-Y7', 'TV-G'],
    },
  },
  {
    id: 'family-channel',
    name: 'Family Channel',
    description: 'PG/PG-13 content for all ages',
    category: 'audience',
    icon: '👨‍👩‍👧‍👦',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      ratings: ['G', 'PG', 'PG-13', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14'],
      excludeRatings: ['R', 'NC-17', 'TV-MA'],
    },
  },
  {
    id: 'adults-only',
    name: 'Adults Only',
    description: 'R/MA rated content',
    category: 'audience',
    icon: '🔞',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      ratings: ['R', 'NC-17', 'TV-MA'],
    },
  },

  // ─── Behavioral / Smart ──────────────────────────────────
  {
    id: 'unwatched',
    name: 'Unwatched',
    description: 'Content you haven\'t seen yet',
    category: 'behavioral',
    icon: '👀',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      unwatchedOnly: true,
    },
  },
  {
    id: 'favorites',
    name: 'Favorites',
    description: 'Your favorited content',
    category: 'behavioral',
    icon: '⭐',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      favoritesOnly: true,
    },
  },
  {
    id: 'forgotten-gems',
    name: 'Forgotten Gems',
    description: 'Content not watched in 12+ months',
    category: 'behavioral',
    icon: '💎',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      notWatchedInDays: 365,
    },
  },
  {
    id: 'continue-watching',
    name: 'Continue Watching',
    description: 'Shows you\'re in the middle of',
    category: 'behavioral',
    icon: '▶️',
    filter: {
      includeEpisodes: true,
      continueWatching: true,
    },
  },

  // ─── Thematic / Curated ──────────────────────────────────
  {
    id: 'award-winners',
    name: 'Award Winners',
    description: 'Oscar and Emmy winning content',
    category: 'thematic',
    icon: '🏆',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      // Note: This would need external data or tags in Jellyfin
    },
  },
  {
    id: 'holiday-halloween',
    name: 'Halloween',
    description: 'Spooky seasonal content',
    category: 'thematic',
    icon: '🎃',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      genres: ['Horror', 'Thriller', 'Mystery'],
    },
  },
  {
    id: 'holiday-christmas',
    name: 'Christmas',
    description: 'Holiday seasonal content',
    category: 'thematic',
    icon: '🎄',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      genres: ['Family', 'Comedy', 'Romance'],
      // Note: Ideally would filter by tags/keywords
    },
  },
  {
    id: 'documentary',
    name: 'Documentary',
    description: 'Documentaries and docuseries',
    category: 'thematic',
    icon: '📚',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      genres: ['Documentary'],
    },
  },
  {
    id: 'anime',
    name: 'Anime Block',
    description: 'Japanese animation',
    category: 'thematic',
    icon: '🇯🇵',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      genres: ['Anime', 'Animation'],
      // Would benefit from anime-specific genre detection
    },
  },
  {
    id: 'stand-up',
    name: 'Stand-Up Comedy',
    description: 'Stand-up comedy specials',
    category: 'thematic',
    icon: '🎤',
    filter: {
      includeMovies: true,
      genres: ['Comedy', 'Stand-Up'],
    },
  },

  // ─── Format-Driven ───────────────────────────────────────
  {
    id: 'anthology',
    name: 'Anthology',
    description: 'One episode from different shows each slot',
    category: 'format',
    icon: '🎲',
    filter: {
      includeEpisodes: true,
      anthologyMode: true,
    },
  },
  {
    id: 'the-shuffle',
    name: 'The Shuffle',
    description: 'Truly random across entire library',
    category: 'format',
    icon: '🔀',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      shuffleMode: true,
    },
  },
  {
    id: 'action-marathon',
    name: 'Action Marathon',
    description: 'Non-stop action movies',
    category: 'format',
    icon: '💥',
    filter: {
      includeMovies: true,
      genres: ['Action'],
      marathonMode: true,
    },
  },
  {
    id: 'sci-fi-marathon',
    name: 'Sci-Fi Marathon',
    description: 'Science fiction back-to-back',
    category: 'format',
    icon: '🚀',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
      genres: ['Science Fiction', 'Sci-Fi'],
      marathonMode: true,
    },
  },

  // ─── Cast & Crew ──────────────────────────────────────────
  {
    id: 'auto-directors',
    name: 'Director Channels',
    description: 'Creates channels for prolific directors in your library',
    category: 'auto',
    icon: '🎬',
    isDynamic: true,
    dynamicType: 'directors',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
    },
  },
  {
    id: 'auto-actors',
    name: 'Lead Actor Channels',
    description: 'Creates channels for popular actors in your library',
    category: 'auto',
    icon: '⭐',
    isDynamic: true,
    dynamicType: 'actors',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
    },
  },
  {
    id: 'auto-composers',
    name: 'Composer Channels',
    description: 'Creates channels for prolific composers in your library',
    category: 'auto',
    icon: '🎵',
    isDynamic: true,
    dynamicType: 'composers',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
    },
  },
  {
    id: 'auto-studios',
    name: 'Studio Channels',
    description: 'Creates channels for top movie studios in your library',
    category: 'auto',
    icon: '🏢',
    isDynamic: true,
    dynamicType: 'studios',
    filter: {
      includeMovies: true,
      includeEpisodes: true,
    },
  },
];

// Helper to get presets by category
export function getPresetsByCategory(category: ChannelPresetCategory): ChannelPreset[] {
  return CHANNEL_PRESETS.filter(p => p.category === category);
}

// Helper to get a preset by ID
export function getPresetById(id: string): ChannelPreset | undefined {
  return CHANNEL_PRESETS.find(p => p.id === id);
}
