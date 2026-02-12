import { useState, useEffect, useRef, useCallback } from 'react';
import { getSettings, updateSettings, getGenres, getRatings, regenerateChannels } from '../../services/api';

interface GenreInfo {
  genre: string;
  count: number;
  totalDurationMs: number;
}

interface RatingInfo {
  rating: string;
  count: number;
}

// Rating systems data (matching server-side ratingSystems.ts)
interface RatingOption {
  code: string;
  name: string;
  description: string;
  minAge?: number;
  isAdult: boolean;
}

interface RatingCategory {
  id: string;
  name: string;
  ratings: RatingOption[];
}

interface RatingSystem {
  id: string;
  name: string;
  region: string;
  categories: RatingCategory[];
}

const RATING_SYSTEMS: RatingSystem[] = [
  {
    id: 'us',
    name: 'United States (MPAA / TV Parental)',
    region: 'United States',
    categories: [
      {
        id: 'movie',
        name: 'Movies (MPAA)',
        ratings: [
          { code: 'G', name: 'General Audiences', description: 'All ages admitted', minAge: 0, isAdult: false },
          { code: 'PG', name: 'Parental Guidance', description: 'Some material may not be suitable for children', minAge: 0, isAdult: false },
          { code: 'PG-13', name: 'Parents Strongly Cautioned', description: 'Some material may be inappropriate for children under 13', minAge: 13, isAdult: false },
          { code: 'R', name: 'Restricted', description: 'Under 17 requires accompanying parent', minAge: 17, isAdult: false },
          { code: 'NC-17', name: 'Adults Only', description: 'No one 17 and under admitted', minAge: 18, isAdult: true },
        ],
      },
      {
        id: 'tv',
        name: 'TV Shows',
        ratings: [
          { code: 'TV-Y', name: 'All Children', description: 'Appropriate for all children', minAge: 0, isAdult: false },
          { code: 'TV-Y7', name: 'Directed to Older Children', description: 'Designed for children age 7+', minAge: 7, isAdult: false },
          { code: 'TV-G', name: 'General Audience', description: 'Suitable for all ages', minAge: 0, isAdult: false },
          { code: 'TV-PG', name: 'Parental Guidance', description: 'May contain some unsuitable material', minAge: 0, isAdult: false },
          { code: 'TV-14', name: 'Parents Strongly Cautioned', description: 'Unsuitable for children under 14', minAge: 14, isAdult: false },
          { code: 'TV-MA', name: 'Mature Audience Only', description: 'Specifically designed for adults', minAge: 17, isAdult: true },
        ],
      },
    ],
  },
  {
    id: 'uk',
    name: 'United Kingdom (BBFC)',
    region: 'United Kingdom',
    categories: [
      {
        id: 'movie',
        name: 'Movies & TV (BBFC)',
        ratings: [
          { code: 'U', name: 'Universal', description: 'Suitable for all', minAge: 0, isAdult: false },
          { code: 'PG', name: 'Parental Guidance', description: 'General viewing, some scenes unsuitable for young children', minAge: 0, isAdult: false },
          { code: '12', name: '12', description: 'Suitable for 12 years and over', minAge: 12, isAdult: false },
          { code: '12A', name: '12A', description: 'Cinema release suitable for 12+ (or younger with adult)', minAge: 12, isAdult: false },
          { code: '15', name: '15', description: 'Suitable only for 15 years and over', minAge: 15, isAdult: false },
          { code: '18', name: '18', description: 'Suitable only for adults', minAge: 18, isAdult: true },
        ],
      },
    ],
  },
  {
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
  },
  {
    id: 'au',
    name: 'Australia (ACB)',
    region: 'Australia',
    categories: [
      {
        id: 'movie',
        name: 'Movies & TV',
        ratings: [
          { code: 'G', name: 'General', description: 'Suitable for all ages', minAge: 0, isAdult: false },
          { code: 'PG', name: 'Parental Guidance', description: 'Parental guidance recommended for under 15', minAge: 0, isAdult: false },
          { code: 'M', name: 'Mature', description: 'Recommended for mature audiences 15+', minAge: 15, isAdult: false },
          { code: 'MA 15+', name: 'Mature Accompanied', description: 'Restricted to 15 and over', minAge: 15, isAdult: false },
          { code: 'R 18+', name: 'Restricted', description: 'Restricted to 18 and over', minAge: 18, isAdult: true },
        ],
      },
    ],
  },
  {
    id: 'ca',
    name: 'Canada (CHVRS)',
    region: 'Canada',
    categories: [
      {
        id: 'movie',
        name: 'Movies',
        ratings: [
          { code: 'G', name: 'General', description: 'Suitable for all ages', minAge: 0, isAdult: false },
          { code: 'PG', name: 'Parental Guidance', description: 'Parental guidance advised', minAge: 0, isAdult: false },
          { code: '14A', name: '14 Accompaniment', description: 'Persons under 14 must be accompanied', minAge: 14, isAdult: false },
          { code: '18A', name: '18 Accompaniment', description: 'Persons under 18 must be accompanied', minAge: 18, isAdult: false },
          { code: 'R', name: 'Restricted', description: 'Restricted to 18 and over', minAge: 18, isAdult: true },
        ],
      },
      {
        id: 'tv',
        name: 'TV Shows',
        ratings: [
          { code: 'C', name: 'Children', description: 'Programming for children under 8', minAge: 0, isAdult: false },
          { code: 'C8', name: 'Children 8+', description: 'Programming for children 8 and older', minAge: 8, isAdult: false },
          { code: 'G', name: 'General', description: 'General programming', minAge: 0, isAdult: false },
          { code: 'PG', name: 'Parental Guidance', description: 'Parental guidance', minAge: 0, isAdult: false },
          { code: '14+', name: '14+', description: 'Unsuitable for viewers under 14', minAge: 14, isAdult: false },
          { code: '18+', name: '18+', description: 'Adult programming', minAge: 18, isAdult: true },
        ],
      },
    ],
  },
];

export default function FilterSettings() {
  const [genres, setGenres] = useState<GenreInfo[]>([]);
  const [ratings, setRatings] = useState<RatingInfo[]>([]);
  const [genreFilter, setGenreFilter] = useState<{ mode: string; genres: string[] }>({ mode: 'allow', genres: [] });
  const [contentTypes, setContentTypes] = useState<{ movies: boolean; tv_shows: boolean }>({ movies: true, tv_shows: true });
  const [ratingFilter, setRatingFilter] = useState<{ mode: string; ratings: string[]; ratingSystem: string }>({ 
    mode: 'allow', // Always 'allow' mode (block selected)
    ratings: [], 
    ratingSystem: 'us' 
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  // Track if filters have changed since initial load
  const hasChangedRef = useRef(false);
  const initialLoadRef = useRef(true);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-save function with debounce
  const autoSave = useCallback(async (
    newGenreFilter: typeof genreFilter,
    newContentTypes: typeof contentTypes,
    newRatingFilter: typeof ratingFilter
  ) => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce the save by 500ms
    saveTimeoutRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await updateSettings({
          genre_filter: newGenreFilter,
          content_types: newContentTypes,
          rating_filter: newRatingFilter,
        });
        hasChangedRef.current = true;
      } catch {
        // Handle error silently
      } finally {
        setSaving(false);
      }
    }, 500);
  }, []);

  // Load initial data
  useEffect(() => {
    async function load() {
      try {
        const [settingsData, genresData, ratingsData] = await Promise.all([
          getSettings(),
          getGenres(),
          getRatings(),
        ]);

        if (settingsData.genre_filter) {
          const filter = settingsData.genre_filter as { mode: string; genres: string[] };
          setGenreFilter({ ...filter, mode: 'allow' });
        }
        if (settingsData.content_types) {
          setContentTypes(settingsData.content_types as { movies: boolean; tv_shows: boolean });
        }
        if (settingsData.rating_filter) {
          const filter = settingsData.rating_filter as { mode: string; ratings: string[]; ratingSystem: string };
          setRatingFilter({ ...filter, mode: 'allow' });
        }
        setGenres(genresData);
        setRatings(ratingsData);
      } catch {
        // Data may not be available if no server is connected
      } finally {
        setLoading(false);
        // Mark initial load as complete after a short delay
        setTimeout(() => {
          initialLoadRef.current = false;
        }, 100);
      }
    }
    load();
  }, []);

  // Regenerate channels when component unmounts if there were changes
  useEffect(() => {
    return () => {
      // Clear any pending save timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      
      // If filters changed, regenerate channels
      if (hasChangedRef.current) {
        regenerateChannels().catch(() => {
          // Handle error silently
        });
      }
    };
  }, []);

  const toggleGenre = (genre: string) => {
    setGenreFilter(prev => {
      const newGenres = prev.genres.includes(genre)
        ? prev.genres.filter(g => g !== genre)
        : [...prev.genres, genre];
      const newFilter = { ...prev, genres: newGenres };
      
      // Auto-save after change
      if (!initialLoadRef.current) {
        autoSave(newFilter, contentTypes, ratingFilter);
      }
      
      return newFilter;
    });
  };

  const toggleRating = (rating: string) => {
    setRatingFilter(prev => {
      const newRatings = prev.ratings.includes(rating)
        ? prev.ratings.filter(r => r !== rating)
        : [...prev.ratings, rating];
      const newFilter = { ...prev, ratings: newRatings };
      
      // Auto-save after change
      if (!initialLoadRef.current) {
        autoSave(genreFilter, contentTypes, newFilter);
      }
      
      return newFilter;
    });
  };

  const handleContentTypeChange = (type: 'movies' | 'tv_shows', checked: boolean) => {
    setContentTypes(prev => {
      const newTypes = { ...prev, [type]: checked };
      
      // Auto-save after change
      if (!initialLoadRef.current) {
        autoSave(genreFilter, newTypes, ratingFilter);
      }
      
      return newTypes;
    });
  };

  const handleRatingSystemChange = (systemId: string) => {
    setRatingFilter(prev => {
      const newFilter = {
        ...prev,
        ratingSystem: systemId,
        ratings: [], // Clear selections when changing systems
      };
      
      // Auto-save after change
      if (!initialLoadRef.current) {
        autoSave(genreFilter, contentTypes, newFilter);
      }
      
      return newFilter;
    });
  };

  const getCurrentRatingSystem = () => {
    return RATING_SYSTEMS.find(s => s.id === ratingFilter.ratingSystem) || RATING_SYSTEMS[0];
  };

  const getRatingCount = (code: string): number => {
    const found = ratings.find(r => r.rating === code);
    return found?.count || 0;
  };

  // Calculate total blocked items
  const getBlockedItemCount = (): number => {
    let blocked = 0;
    
    // Count blocked ratings
    for (const rating of ratingFilter.ratings) {
      blocked += getRatingCount(rating);
    }
    
    // Count blocked genres
    for (const genre of genreFilter.genres) {
      const genreInfo = genres.find(g => g.genre === genre);
      if (genreInfo) {
        blocked += genreInfo.count;
      }
    }
    
    return blocked;
  };

  const formatDuration = (ms: number) => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  };

  if (loading) return <div className="settings-loading">Loading...</div>;

  const blockedCount = getBlockedItemCount();

  return (
    <div className="settings-section">
      <h3>Content Filters</h3>

      <div className="settings-blocked-count-row">
        {blockedCount > 0 && (
          <div className="settings-blocked-count">
            <span className="settings-blocked-icon">🚫</span>
            <span className="settings-blocked-text">{blockedCount.toLocaleString()} items blocked</span>
          </div>
        )}
        {saving && (
          <span className="settings-autosave-indicator">Saving...</span>
        )}
      </div>

      <div className="settings-subsection">
        <h4>Content Types</h4>
        <div className="settings-checkboxes">
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={contentTypes.movies}
              onChange={e => handleContentTypeChange('movies', e.target.checked)}
            />
            <span>Movies</span>
          </label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={contentTypes.tv_shows}
              onChange={e => handleContentTypeChange('tv_shows', e.target.checked)}
            />
            <span>TV Shows</span>
          </label>
        </div>
      </div>

      <div className="settings-subsection">
        <h4>Content Rating Filter</h4>
        <p className="settings-description">
          Select ratings to block from your channels.
        </p>
        
        <div className="settings-field">
          <label>Rating System</label>
          <select
            value={ratingFilter.ratingSystem}
            onChange={e => handleRatingSystemChange(e.target.value)}
          >
            {RATING_SYSTEMS.map(system => (
              <option key={system.id} value={system.id}>
                {system.name}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-rating-grid">
          {getCurrentRatingSystem().categories.map(category => (
            <div key={category.id} className="settings-rating-category">
              <h5>{category.name}</h5>
              <div className="settings-rating-items">
                {category.ratings.map(rating => {
                  const count = getRatingCount(rating.code);
                  const isBlocked = ratingFilter.ratings.includes(rating.code);
                  return (
                    <label
                      key={rating.code}
                      className={`settings-rating-item ${isBlocked ? 'settings-rating-blocked' : ''}`}
                      title={rating.description}
                    >
                      <input
                        type="checkbox"
                        checked={isBlocked}
                        onChange={() => toggleRating(rating.code)}
                      />
                      <div className="settings-rating-info">
                        <span className="settings-rating-code">{rating.code}</span>
                        <span className="settings-rating-name">{rating.name}</span>
                        {rating.minAge !== undefined && rating.minAge > 0 && (
                          <span className="settings-rating-age">{rating.minAge}+</span>
                        )}
                        {count > 0 && (
                          <span className="settings-rating-count">{count} items</span>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-subsection">
        <h4>Genre Filter</h4>
        <p className="settings-description">
          Select genres to block from your channels.
        </p>

        {genres.length === 0 ? (
          <div className="settings-empty">Connect a server to see available genres.</div>
        ) : (
          <div className="settings-genre-grid">
            {genres.map(g => {
              const isBlocked = genreFilter.genres.includes(g.genre);
              return (
                <label
                  key={g.genre}
                  className={`settings-genre-item ${isBlocked ? 'settings-genre-blocked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={isBlocked}
                    onChange={() => toggleGenre(g.genre)}
                  />
                  <div className="settings-genre-info">
                    <span className="settings-genre-name">{g.genre}</span>
                    <span className="settings-genre-stats">{g.count} items &middot; {formatDuration(g.totalDurationMs)}</span>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
