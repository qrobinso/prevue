/**
 * Content Rating Systems by Region
 * 
 * This file defines the major content rating systems used around the world.
 * Each system includes ratings for both movies and TV shows, ordered from
 * most restrictive (kids) to least restrictive (adults).
 */

export interface Rating {
  code: string;           // The rating code (e.g., "PG-13", "TV-MA")
  name: string;           // Full name
  description: string;    // Brief description
  minAge?: number;        // Minimum recommended age (if applicable)
  isAdult: boolean;       // True if this is adult-only content
}

export interface RatingCategory {
  id: string;             // 'movie' or 'tv'
  name: string;
  ratings: Rating[];
}

export interface RatingSystem {
  id: string;             // Unique identifier (e.g., "us", "uk")
  name: string;           // Display name (e.g., "United States (MPAA/TV Parental)")
  region: string;         // Region/Country
  categories: RatingCategory[];
}

// ─── United States (MPAA for Movies, TV Parental Guidelines for TV) ───────────
const US_SYSTEM: RatingSystem = {
  id: 'us',
  name: 'United States (MPAA / TV Parental)',
  region: 'United States',
  categories: [
    {
      id: 'movie',
      name: 'Movies (MPAA)',
      ratings: [
        { code: 'G', name: 'General Audiences', description: 'All ages admitted', minAge: 0, isAdult: false },
        { code: 'PG', name: 'Parental Guidance Suggested', description: 'Some material may not be suitable for children', minAge: 0, isAdult: false },
        { code: 'PG-13', name: 'Parents Strongly Cautioned', description: 'Some material may be inappropriate for children under 13', minAge: 13, isAdult: false },
        { code: 'R', name: 'Restricted', description: 'Under 17 requires accompanying parent or adult guardian', minAge: 17, isAdult: false },
        { code: 'NC-17', name: 'Adults Only', description: 'No one 17 and under admitted', minAge: 18, isAdult: true },
        { code: 'NR', name: 'Not Rated', description: 'Not submitted for rating', isAdult: false },
        { code: 'Unrated', name: 'Unrated', description: 'Not rated', isAdult: false },
      ],
    },
    {
      id: 'tv',
      name: 'TV Shows (TV Parental Guidelines)',
      ratings: [
        { code: 'TV-Y', name: 'All Children', description: 'Appropriate for all children', minAge: 0, isAdult: false },
        { code: 'TV-Y7', name: 'Directed to Older Children', description: 'Designed for children age 7 and above', minAge: 7, isAdult: false },
        { code: 'TV-Y7-FV', name: 'Directed to Older Children - Fantasy Violence', description: 'Fantasy violence more intense than TV-Y7', minAge: 7, isAdult: false },
        { code: 'TV-G', name: 'General Audience', description: 'Most parents would find suitable for all ages', minAge: 0, isAdult: false },
        { code: 'TV-PG', name: 'Parental Guidance Suggested', description: 'May contain some material that parents find unsuitable', minAge: 0, isAdult: false },
        { code: 'TV-14', name: 'Parents Strongly Cautioned', description: 'May contain material unsuitable for children under 14', minAge: 14, isAdult: false },
        { code: 'TV-MA', name: 'Mature Audience Only', description: 'Specifically designed for adults', minAge: 17, isAdult: true },
      ],
    },
  ],
};

// ─── United Kingdom (BBFC for Movies, Ofcom for TV) ───────────────────────────
const UK_SYSTEM: RatingSystem = {
  id: 'uk',
  name: 'United Kingdom (BBFC)',
  region: 'United Kingdom',
  categories: [
    {
      id: 'movie',
      name: 'Movies & TV (BBFC)',
      ratings: [
        { code: 'U', name: 'Universal', description: 'Suitable for all', minAge: 0, isAdult: false },
        { code: 'PG', name: 'Parental Guidance', description: 'General viewing, but some scenes may be unsuitable for young children', minAge: 0, isAdult: false },
        { code: '12', name: '12', description: 'Video release suitable for 12 years and over', minAge: 12, isAdult: false },
        { code: '12A', name: '12A', description: 'Cinema release suitable for 12 years and over (or younger with adult)', minAge: 12, isAdult: false },
        { code: '15', name: '15', description: 'Suitable only for 15 years and over', minAge: 15, isAdult: false },
        { code: '18', name: '18', description: 'Suitable only for adults', minAge: 18, isAdult: true },
        { code: 'R18', name: 'Restricted 18', description: 'Adult works for licensed premises only', minAge: 18, isAdult: true },
      ],
    },
  ],
};

// ─── Germany (FSK for Movies, FSF for TV) ─────────────────────────────────────
const DE_SYSTEM: RatingSystem = {
  id: 'de',
  name: 'Germany (FSK)',
  region: 'Germany',
  categories: [
    {
      id: 'movie',
      name: 'Movies & TV (FSK)',
      ratings: [
        { code: 'FSK 0', name: 'FSK 0', description: 'Approved without age restriction', minAge: 0, isAdult: false },
        { code: 'FSK 6', name: 'FSK 6', description: 'Approved for children 6 and older', minAge: 6, isAdult: false },
        { code: 'FSK 12', name: 'FSK 12', description: 'Approved for children 12 and older', minAge: 12, isAdult: false },
        { code: 'FSK 16', name: 'FSK 16', description: 'Approved for teenagers 16 and older', minAge: 16, isAdult: false },
        { code: 'FSK 18', name: 'FSK 18', description: 'Approved for adults only', minAge: 18, isAdult: true },
      ],
    },
  ],
};

// ─── Australia (ACB) ──────────────────────────────────────────────────────────
const AU_SYSTEM: RatingSystem = {
  id: 'au',
  name: 'Australia (ACB)',
  region: 'Australia',
  categories: [
    {
      id: 'movie',
      name: 'Movies (ACB)',
      ratings: [
        { code: 'G', name: 'General', description: 'Suitable for all ages', minAge: 0, isAdult: false },
        { code: 'PG', name: 'Parental Guidance', description: 'Parental guidance recommended for under 15', minAge: 0, isAdult: false },
        { code: 'M', name: 'Mature', description: 'Recommended for mature audiences 15+', minAge: 15, isAdult: false },
        { code: 'MA 15+', name: 'Mature Accompanied', description: 'Restricted to 15 and over', minAge: 15, isAdult: false },
        { code: 'MA15+', name: 'Mature Accompanied', description: 'Restricted to 15 and over', minAge: 15, isAdult: false },
        { code: 'R 18+', name: 'Restricted', description: 'Restricted to 18 and over', minAge: 18, isAdult: true },
        { code: 'R18+', name: 'Restricted', description: 'Restricted to 18 and over', minAge: 18, isAdult: true },
        { code: 'X 18+', name: 'Restricted (X)', description: 'Restricted to 18 and over (adult content)', minAge: 18, isAdult: true },
      ],
    },
    {
      id: 'tv',
      name: 'TV Shows (ACB)',
      ratings: [
        { code: 'P', name: 'Preschool', description: 'Preschool children', minAge: 0, isAdult: false },
        { code: 'C', name: 'Children', description: 'Children (5-11)', minAge: 5, isAdult: false },
        { code: 'G', name: 'General', description: 'General audience', minAge: 0, isAdult: false },
        { code: 'PG', name: 'Parental Guidance', description: 'Parental guidance recommended', minAge: 0, isAdult: false },
        { code: 'M', name: 'Mature', description: 'Mature audience', minAge: 15, isAdult: false },
        { code: 'MA 15+', name: 'Mature Accompanied', description: 'Mature accompanied 15+', minAge: 15, isAdult: false },
        { code: 'AV 15+', name: 'Adult Violence', description: 'Adult violence 15+', minAge: 15, isAdult: false },
      ],
    },
  ],
};

// ─── Canada (Canadian Home Video Rating System) ───────────────────────────────
const CA_SYSTEM: RatingSystem = {
  id: 'ca',
  name: 'Canada (CHVRS)',
  region: 'Canada',
  categories: [
    {
      id: 'movie',
      name: 'Movies (CHVRS)',
      ratings: [
        { code: 'G', name: 'General', description: 'Suitable for all ages', minAge: 0, isAdult: false },
        { code: 'PG', name: 'Parental Guidance', description: 'Parental guidance advised', minAge: 0, isAdult: false },
        { code: '14A', name: '14 Accompaniment', description: 'Persons under 14 must be accompanied by an adult', minAge: 14, isAdult: false },
        { code: '14+', name: '14+', description: 'Suitable for viewers 14 and older', minAge: 14, isAdult: false },
        { code: '18A', name: '18 Accompaniment', description: 'Persons under 18 must be accompanied by an adult', minAge: 18, isAdult: false },
        { code: '18+', name: '18+', description: 'Adults only', minAge: 18, isAdult: true },
        { code: 'R', name: 'Restricted', description: 'Restricted to 18 and over', minAge: 18, isAdult: true },
        { code: 'A', name: 'Adult', description: 'Adult content', minAge: 18, isAdult: true },
      ],
    },
    {
      id: 'tv',
      name: 'TV Shows (CRTC)',
      ratings: [
        { code: 'C', name: 'Children', description: 'Programming for children under 8', minAge: 0, isAdult: false },
        { code: 'C8', name: 'Children 8+', description: 'Programming for children 8 and older', minAge: 8, isAdult: false },
        { code: 'G', name: 'General', description: 'General programming', minAge: 0, isAdult: false },
        { code: 'PG', name: 'Parental Guidance', description: 'Parental guidance', minAge: 0, isAdult: false },
        { code: '14+', name: '14+', description: 'Programming with themes unsuitable for viewers under 14', minAge: 14, isAdult: false },
        { code: '18+', name: '18+', description: 'Adult programming', minAge: 18, isAdult: true },
      ],
    },
  ],
};

// ─── All Rating Systems ───────────────────────────────────────────────────────
export const RATING_SYSTEMS: RatingSystem[] = [
  US_SYSTEM,
  UK_SYSTEM,
  DE_SYSTEM,
  AU_SYSTEM,
  CA_SYSTEM,
];

/**
 * Get a rating system by ID
 */
export function getRatingSystemById(id: string): RatingSystem | undefined {
  return RATING_SYSTEMS.find(s => s.id === id);
}

/**
 * Get all rating codes for a given system (flattened across all categories)
 */
export function getAllRatingsForSystem(systemId: string): Rating[] {
  const system = getRatingSystemById(systemId);
  if (!system) return [];
  
  const ratings: Rating[] = [];
  for (const category of system.categories) {
    ratings.push(...category.ratings);
  }
  
  // Remove duplicates (some ratings like 'G', 'PG' appear in both movie and TV)
  const seen = new Set<string>();
  return ratings.filter(r => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });
}

/**
 * Get rating info by code from a specific system
 */
export function getRatingInfo(systemId: string, code: string): Rating | undefined {
  const system = getRatingSystemById(systemId);
  if (!system) return undefined;
  
  for (const category of system.categories) {
    const rating = category.ratings.find(r => r.code === code);
    if (rating) return rating;
  }
  
  return undefined;
}

/**
 * Check if a rating code is considered adult content in a system
 */
export function isAdultRating(systemId: string, code: string): boolean {
  const rating = getRatingInfo(systemId, code);
  return rating?.isAdult ?? false;
}

/**
 * Get the minimum age for a rating in a system
 */
export function getMinimumAge(systemId: string, code: string): number {
  const rating = getRatingInfo(systemId, code);
  return rating?.minAge ?? 0;
}

/**
 * Map common rating variations to standard codes
 * This helps match ratings that Jellyfin might report in different formats
 */
export const RATING_ALIASES: Record<string, string[]> = {
  // US Movie
  'G': ['G', 'Rated G'],
  'PG': ['PG', 'Rated PG'],
  'PG-13': ['PG-13', 'PG13', 'Rated PG-13'],
  'R': ['R', 'Rated R'],
  'NC-17': ['NC-17', 'NC17', 'Rated NC-17'],
  'NR': ['NR', 'Not Rated', 'Unrated'],
  // US TV
  'TV-Y': ['TV-Y', 'TVY'],
  'TV-Y7': ['TV-Y7', 'TVY7'],
  'TV-Y7-FV': ['TV-Y7-FV', 'TVY7FV'],
  'TV-G': ['TV-G', 'TVG'],
  'TV-PG': ['TV-PG', 'TVPG'],
  'TV-14': ['TV-14', 'TV14'],
  'TV-MA': ['TV-MA', 'TVMA'],
  // UK
  'U': ['U', 'Rated U'],
  '12': ['12', 'Rated 12'],
  '12A': ['12A', 'Rated 12A'],
  '15': ['15', 'Rated 15'],
  '18': ['18', 'Rated 18'],
  // Germany
  'FSK 0': ['FSK 0', 'FSK-0', 'FSK0', 'de/0'],
  'FSK 6': ['FSK 6', 'FSK-6', 'FSK6', 'de/6'],
  'FSK 12': ['FSK 12', 'FSK-12', 'FSK12', 'de/12'],
  'FSK 16': ['FSK 16', 'FSK-16', 'FSK16', 'de/16'],
  'FSK 18': ['FSK 18', 'FSK-18', 'FSK18', 'de/18'],
  // Australia
  'MA 15+': ['MA 15+', 'MA15+', 'MA-15+'],
  'R 18+': ['R 18+', 'R18+', 'R-18+'],
  'X 18+': ['X 18+', 'X18+', 'X-18+'],
};

/**
 * Normalize a rating code to its standard form
 */
export function normalizeRating(code: string): string {
  const upper = code.toUpperCase().trim();
  
  for (const [standard, aliases] of Object.entries(RATING_ALIASES)) {
    if (aliases.some(a => a.toUpperCase() === upper)) {
      return standard;
    }
  }
  
  return code; // Return as-is if no match
}
