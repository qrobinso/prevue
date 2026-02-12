import type Database from 'better-sqlite3';
import type { ChannelParsed, ChannelFilter, JellyfinItem } from '../types/index.js';
import { JellyfinClient } from './JellyfinClient.js';
import { ScheduleEngine } from './ScheduleEngine.js';
import { CHANNEL_PRESETS, PRESET_CATEGORIES, getPresetById } from '../data/channelPresets.js';
import * as queries from '../db/queries.js';

const MIN_CHANNEL_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours minimum content
const MIN_CAST_CHANNEL_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours minimum for cast/crew channels (directors, actors, etc.)
const DEFAULT_MAX_CHANNELS = 100;

export class ChannelManager {
  private db: Database.Database;
  private jellyfin: JellyfinClient;
  private scheduleEngine: ScheduleEngine;

  constructor(db: Database.Database, jellyfin: JellyfinClient, scheduleEngine: ScheduleEngine) {
    this.db = db;
    this.jellyfin = jellyfin;
    this.scheduleEngine = scheduleEngine;
  }

  /**
   * Get all channel presets and categories for UI
   */
  getChannelPresets() {
    return {
      categories: PRESET_CATEGORIES,
      presets: CHANNEL_PRESETS,
    };
  }

  /**
   * Progress callback type for channel generation
   */
  private onProgress?: (progress: { step: string; message: string; current?: number; total?: number }) => void;

  /**
   * Generate channels based on selected presets
   */
  async generateChannelsFromPresets(
    presetIds: string[], 
    onProgress?: (progress: { step: string; message: string; current?: number; total?: number }) => void
  ): Promise<ChannelParsed[]> {
    this.onProgress = onProgress;
    const maxCount = DEFAULT_MAX_CHANNELS;
    
    // Remove existing auto and preset channels
    this.reportProgress('preparing', 'Removing existing channels...');
    queries.deleteAutoAndPresetChannels(this.db);

    const created: ChannelParsed[] = [];
    const libraryItems = this.jellyfin.getLibraryItems();
    const totalPresets = presetIds.length;

    // Get global filter settings
    const settings = this.getFilterSettings();

    for (let i = 0; i < presetIds.length; i++) {
      if (created.length >= maxCount) break;

      const presetId = presetIds[i];
      const preset = getPresetById(presetId);
      if (!preset) continue;

      this.reportProgress('generating', `Processing: ${preset.name}...`, i + 1, totalPresets);

      // Handle dynamic presets (genres, eras, collections, etc.)
      if (preset.isDynamic) {
        const dynamicChannels = await this.generateDynamicChannels(preset, libraryItems, maxCount - created.length);
        created.push(...dynamicChannels);
        continue;
      }

      // Filter items based on preset filter
      let filteredItems = this.filterItemsByChannelFilter(libraryItems, preset.filter);

      // Apply global content filters (content types, blocked ratings, blocked genres)
      filteredItems = filteredItems.filter(item => {
        // Content type filter
        if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
        if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
        // Rating filter
        if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
        // Genre filter
        const itemGenres = item.Genres || [];
        for (const genre of itemGenres) {
          if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
        }
        return true;
      });

      // Check minimum duration
      const totalDuration = filteredItems.reduce(
        (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
        0
      );

      if (totalDuration < MIN_CHANNEL_DURATION_MS) {
        console.log(`[ChannelManager] Skipping ${preset.name}: insufficient content (${Math.round(totalDuration / 3600000)}h)`);
        continue;
      }

      const channel = queries.createChannel(this.db, {
        name: preset.name,
        type: 'preset',
        preset_id: preset.id,
        filter: preset.filter,
        item_ids: filteredItems.map(i => i.Id),
      });

      created.push(channel);
      console.log(`[ChannelManager] Created preset channel: ${preset.name} (${filteredItems.length} items)`);
    }

    console.log(`[ChannelManager] Generated ${created.length} preset channels`);
    this.onProgress = undefined;
    return created;
  }

  /**
   * Report progress to the callback if set
   */
  private reportProgress(step: string, message: string, current?: number, total?: number) {
    if (this.onProgress) {
      this.onProgress({ step, message, current, total });
    }
  }

  /**
   * Generate multiple channels from a dynamic preset (genres, eras, collections, etc.)
   */
  private async generateDynamicChannels(preset: typeof CHANNEL_PRESETS[0], libraryItems: JellyfinItem[], maxCount: number): Promise<ChannelParsed[]> {
    const created: ChannelParsed[] = [];

    if (preset.dynamicType === 'genres') {
      // Generate genre-based channels
      const genres = this.jellyfin.getGenres();
      const sortedGenres = Array.from(genres.entries()).sort((a, b) => b[1].length - a[1].length);
      const settings = this.getFilterSettings();

      for (const [genre, items] of sortedGenres) {
        if (created.length >= maxCount) break;

        // Apply genre filter from settings - skip creating channel for blocked genres
        if (!this.isGenreAllowed(genre, settings.genreFilter)) continue;

        // Apply content type, rating, and genre filters
        const filteredItems = items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          // Also filter items that have any blocked genre (even if they're in an allowed genre channel)
          const itemGenres = item.Genres || [];
          for (const g of itemGenres) {
            if (!this.isGenreAllowed(g, settings.genreFilter)) return false;
          }
          return true;
        });

        // Check minimum duration
        const totalDuration = filteredItems.reduce(
          (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
          0
        );

        if (totalDuration < MIN_CHANNEL_DURATION_MS) continue;

        const channel = queries.createChannel(this.db, {
          name: genre,
          type: 'preset',
          preset_id: `${preset.id}:${genre.toLowerCase().replace(/\s+/g, '-')}`,
          filter: { ...preset.filter, genres: [genre] },
          genre,
          item_ids: filteredItems.map(i => i.Id),
        });

        created.push(channel);
        console.log(`[ChannelManager] Created genre channel: ${genre} (${filteredItems.length} items)`);
      }
    } else if (preset.dynamicType === 'eras') {
      // Generate era-based channels based on content in library
      const decades = this.getDecadesFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      for (const decade of decades) {
        if (created.length >= maxCount) break;

        const filter: ChannelFilter = {
          ...preset.filter,
          minYear: decade.startYear,
          maxYear: decade.endYear,
        };

        let filteredItems = this.filterItemsByChannelFilter(libraryItems, filter);

        // Apply global content filters
        filteredItems = filteredItems.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          // Genre filter
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        // Check minimum duration
        const totalDuration = filteredItems.reduce(
          (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
          0
        );

        if (totalDuration < MIN_CHANNEL_DURATION_MS) continue;

        const channel = queries.createChannel(this.db, {
          name: decade.name,
          type: 'preset',
          preset_id: `${preset.id}:${decade.id}`,
          filter,
          item_ids: filteredItems.map(i => i.Id),
        });

        created.push(channel);
        console.log(`[ChannelManager] Created era channel: ${decade.name} (${filteredItems.length} items)`);
      }
    } else if (preset.dynamicType === 'directors') {
      // Generate director-based channels
      const directors = this.getDirectorsFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      console.log(`[ChannelManager] Found ${directors.length} eligible directors`);

      for (const director of directors) {
        if (created.length >= maxCount) break;

        // Apply content type, rating, and genre filters
        const filteredItems = director.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        // Check minimum duration (use lower threshold for cast/crew channels)
        const totalDuration = filteredItems.reduce(
          (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
          0
        );

        if (totalDuration < MIN_CAST_CHANNEL_DURATION_MS) {
          console.log(`[ChannelManager] Skipping director ${director.name}: insufficient duration (${Math.round(totalDuration / 3600000)}h < 2h required)`);
          continue;
        }

        const channel = queries.createChannel(this.db, {
          name: `${director.name}`,
          type: 'preset',
          preset_id: `${preset.id}:${director.name.toLowerCase().replace(/\s+/g, '-')}`,
          filter: { ...preset.filter, directors: [director.name] },
          item_ids: filteredItems.map(i => i.Id),
        });

        created.push(channel);
        console.log(`[ChannelManager] Created director channel: ${director.name} (${filteredItems.length} items, ${Math.round(totalDuration / 3600000)}h)`);
      }
    } else if (preset.dynamicType === 'actors') {
      // Generate actor-based channels
      const actors = this.getActorsFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      for (const actor of actors) {
        if (created.length >= maxCount) break;

        // Apply content type, rating, and genre filters
        const filteredItems = actor.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        // Check minimum duration (use lower threshold for cast/crew channels)
        const totalDuration = filteredItems.reduce(
          (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
          0
        );

        if (totalDuration < MIN_CAST_CHANNEL_DURATION_MS) continue;

        const channel = queries.createChannel(this.db, {
          name: `${actor.name}`,
          type: 'preset',
          preset_id: `${preset.id}:${actor.name.toLowerCase().replace(/\s+/g, '-')}`,
          filter: { ...preset.filter, actors: [actor.name] },
          item_ids: filteredItems.map(i => i.Id),
        });

        created.push(channel);
        console.log(`[ChannelManager] Created actor channel: ${actor.name} (${filteredItems.length} items)`);
      }
    } else if (preset.dynamicType === 'composers') {
      // Generate composer-based channels
      const composers = this.getComposersFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      for (const composer of composers) {
        if (created.length >= maxCount) break;

        // Apply content type, rating, and genre filters
        const filteredItems = composer.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        // Check minimum duration (use lower threshold for cast/crew channels)
        const totalDuration = filteredItems.reduce(
          (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
          0
        );

        if (totalDuration < MIN_CAST_CHANNEL_DURATION_MS) continue;

        const channel = queries.createChannel(this.db, {
          name: `${composer.name}`,
          type: 'preset',
          preset_id: `${preset.id}:${composer.name.toLowerCase().replace(/\s+/g, '-')}`,
          filter: { ...preset.filter, composers: [composer.name] },
          item_ids: filteredItems.map(i => i.Id),
        });

        created.push(channel);
        console.log(`[ChannelManager] Created composer channel: ${composer.name} (${filteredItems.length} items)`);
      }
    } else if (preset.dynamicType === 'collections') {
      // Generate collection-based channels
      this.reportProgress('generating', 'Fetching collections from Jellyfin...');
      const collections = await this.jellyfin.getCollections();
      const settings = this.getFilterSettings();

      console.log(`[ChannelManager] Processing ${collections.length} collections for channel generation`);
      this.reportProgress('generating', `Found ${collections.length} collections, processing...`);

      for (const collection of collections) {
        if (created.length >= maxCount) break;

        // Use items directly from the collection (already fetched with full metadata)
        const collectionItems = collection.items;

        // Apply content type, rating, and genre filters
        const filteredItems = collectionItems.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        // Check minimum duration
        const totalDuration = filteredItems.reduce(
          (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
          0
        );

        console.log(`[ChannelManager] Collection "${collection.name}": ${filteredItems.length} items, ${Math.round(totalDuration / 3600000)}h duration`);

        if (totalDuration < MIN_CHANNEL_DURATION_MS) {
          console.log(`[ChannelManager] Skipping collection "${collection.name}": insufficient duration (need 4h)`);
          continue;
        }

        const channel = queries.createChannel(this.db, {
          name: collection.name,
          type: 'preset',
          preset_id: `${preset.id}:${collection.id}`,
          filter: { ...preset.filter, collectionId: collection.id },
          item_ids: filteredItems.map(i => i.Id),
        });

        created.push(channel);
        console.log(`[ChannelManager] Created collection channel: ${collection.name} (${filteredItems.length} items)`);
      }
    } else if (preset.dynamicType === 'studios') {
      // Generate studio-based channels
      const studios = this.getStudiosFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      console.log(`[ChannelManager] Found ${studios.length} eligible studios`);

      for (const studio of studios) {
        if (created.length >= maxCount) break;

        // Apply content type, rating, and genre filters
        const filteredItems = studio.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        // Check minimum duration
        const totalDuration = filteredItems.reduce(
          (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
          0
        );

        if (totalDuration < MIN_CHANNEL_DURATION_MS) {
          console.log(`[ChannelManager] Skipping studio ${studio.name}: insufficient duration (${Math.round(totalDuration / 3600000)}h < 4h required)`);
          continue;
        }

        const channel = queries.createChannel(this.db, {
          name: studio.name,
          type: 'preset',
          preset_id: `${preset.id}:${studio.name.toLowerCase().replace(/\s+/g, '-')}`,
          filter: { ...preset.filter, studios: [studio.name] },
          item_ids: filteredItems.map(i => i.Id),
        });

        created.push(channel);
        console.log(`[ChannelManager] Created studio channel: ${studio.name} (${filteredItems.length} items, ${Math.round(totalDuration / 3600000)}h)`);
      }
    }

    return created;
  }

  /**
   * Analyze library to find which decades have content
   */
  private getDecadesFromLibrary(items: JellyfinItem[]): { id: string; name: string; startYear: number; endYear: number; count: number }[] {
    const decadeCounts = new Map<number, number>();

    for (const item of items) {
      const year = item.ProductionYear;
      if (!year) continue;
      
      const decadeStart = Math.floor(year / 10) * 10;
      decadeCounts.set(decadeStart, (decadeCounts.get(decadeStart) || 0) + 1);
    }

    const decades: { id: string; name: string; startYear: number; endYear: number; count: number }[] = [];
    
    // Define era names and icons
    const eraInfo: Record<number, { name: string; icon: string }> = {
      1950: { name: '50s Channel', icon: '📻' },
      1960: { name: '60s Channel', icon: '☮️' },
      1970: { name: '70s Channel', icon: '🪩' },
      1980: { name: '80s Channel', icon: '🕹️' },
      1990: { name: '90s Channel', icon: '📼' },
      2000: { name: '2000s Channel', icon: '📀' },
      2010: { name: '2010s Channel', icon: '📱' },
      2020: { name: '2020s Channel', icon: '🎬' },
    };

    for (const [decadeStart, count] of decadeCounts) {
      // Only include decades with meaningful content (at least 10 items)
      if (count < 10) continue;
      
      const info = eraInfo[decadeStart] || { name: `${decadeStart}s Channel`, icon: '📅' };
      decades.push({
        id: `${decadeStart}s`,
        name: info.name,
        startYear: decadeStart,
        endYear: decadeStart + 9,
        count,
      });
    }

    // Sort by decade (newest first is more interesting, but oldest first is more traditional)
    // Let's go with descending count to prioritize decades with more content
    return decades.sort((a, b) => b.count - a.count);
  }

  /**
   * Analyze library to find directors with multiple works
   */
  private getDirectorsFromLibrary(items: JellyfinItem[]): { name: string; items: JellyfinItem[]; count: number }[] {
    const directorMap = new Map<string, JellyfinItem[]>();

    let itemsWithPeople = 0;
    for (const item of items) {
      if (!item.People || item.People.length === 0) continue;
      itemsWithPeople++;
      
      // Find directors in the People array
      const directors = item.People.filter(p => p.Type === 'Director');
      for (const director of directors) {
        if (!director.Name) continue;
        const existing = directorMap.get(director.Name) || [];
        existing.push(item);
        directorMap.set(director.Name, existing);
      }
    }

    console.log(`[ChannelManager] Found ${itemsWithPeople}/${items.length} items with People data, ${directorMap.size} unique directors`);

    const directors: { name: string; items: JellyfinItem[]; count: number }[] = [];
    
    for (const [name, directorItems] of directorMap) {
      // Only include directors with at least 2 items (enough for a channel)
      if (directorItems.length < 2) continue;
      
      directors.push({
        name,
        items: directorItems,
        count: directorItems.length,
      });
    }

    // Sort by count (most prolific first) and limit to top 10
    const result = directors.sort((a, b) => b.count - a.count).slice(0, 10);
    console.log(`[ChannelManager] Top 10 directors: ${result.map(d => `${d.name} (${d.count})`).join(', ')}`);
    return result;
  }

  /**
   * Analyze library to find lead actors with multiple appearances
   */
  private getActorsFromLibrary(items: JellyfinItem[]): { name: string; items: JellyfinItem[]; count: number }[] {
    const actorMap = new Map<string, JellyfinItem[]>();

    for (const item of items) {
      if (!item.People) continue;
      
      // Find actors in the People array (only top-billed actors, first 3)
      const actors = item.People
        .filter(p => p.Type === 'Actor')
        .slice(0, 3); // Only lead actors
      
      for (const actor of actors) {
        if (!actor.Name) continue;
        const existing = actorMap.get(actor.Name) || [];
        existing.push(item);
        actorMap.set(actor.Name, existing);
      }
    }

    const actors: { name: string; items: JellyfinItem[]; count: number }[] = [];
    
    for (const [name, actorItems] of actorMap) {
      // Only include actors with at least 5 items (they need to be prolific)
      if (actorItems.length < 5) continue;
      
      actors.push({
        name,
        items: actorItems,
        count: actorItems.length,
      });
    }

    // Sort by count (most appearances first) and limit to top 10
    return actors.sort((a, b) => b.count - a.count).slice(0, 10);
  }

  /**
   * Analyze library to find composers with multiple works
   */
  private getComposersFromLibrary(items: JellyfinItem[]): { name: string; items: JellyfinItem[]; count: number }[] {
    const composerMap = new Map<string, JellyfinItem[]>();

    for (const item of items) {
      if (!item.People) continue;
      
      // Find composers in the People array
      const composers = item.People.filter(p => p.Type === 'Composer');
      for (const composer of composers) {
        if (!composer.Name) continue;
        const existing = composerMap.get(composer.Name) || [];
        existing.push(item);
        composerMap.set(composer.Name, existing);
      }
    }

    const composers: { name: string; items: JellyfinItem[]; count: number }[] = [];
    
    for (const [name, composerItems] of composerMap) {
      // Only include composers with at least 3 items (enough for a channel)
      if (composerItems.length < 3) continue;
      
      composers.push({
        name,
        items: composerItems,
        count: composerItems.length,
      });
    }

    // Sort by count (most prolific first) and limit to top 10
    return composers.sort((a, b) => b.count - a.count).slice(0, 10);
  }

  /**
   * Analyze library to find studios with multiple works
   */
  private getStudiosFromLibrary(items: JellyfinItem[]): { name: string; items: JellyfinItem[]; count: number }[] {
    const studioMap = new Map<string, JellyfinItem[]>();
    let itemsWithStudios = 0;

    for (const item of items) {
      if (!item.Studios || item.Studios.length === 0) continue;
      itemsWithStudios++;
      
      // Get all studios for this item
      for (const studio of item.Studios) {
        if (!studio.Name) continue;
        const existing = studioMap.get(studio.Name) || [];
        existing.push(item);
        studioMap.set(studio.Name, existing);
      }
    }

    console.log(`[ChannelManager] Found ${itemsWithStudios}/${items.length} items with Studios data, ${studioMap.size} unique studios`);

    const studios: { name: string; items: JellyfinItem[]; count: number }[] = [];
    
    for (const [name, studioItems] of studioMap) {
      // Only include studios with at least 5 items (enough for a channel with variety)
      if (studioItems.length < 5) continue;
      
      studios.push({
        name,
        items: studioItems,
        count: studioItems.length,
      });
    }

    // Sort by count (most prolific first) and limit to top 10
    const result = studios.sort((a, b) => b.count - a.count).slice(0, 10);
    console.log(`[ChannelManager] Top 10 studios: ${result.map(s => `${s.name} (${s.count})`).join(', ')}`);
    return result;
  }

  /**
   * Auto-generate genre-based channels from the Jellyfin library
   * This is the legacy method for backwards compatibility
   */
  async autoGenerateChannels(): Promise<ChannelParsed[]> {
    const genres = this.jellyfin.getGenres();
    const settings = this.getFilterSettings();
    const maxCount = DEFAULT_MAX_CHANNELS;

    // Remove existing auto channels only (keep preset channels)
    queries.deleteAutoChannels(this.db);

    const created: ChannelParsed[] = [];

    // Sort genres by content count (descending) to prioritize bigger genres
    const sortedGenres = Array.from(genres.entries()).sort((a, b) => b[1].length - a[1].length);

    for (const [genre, items] of sortedGenres) {
      if (created.length >= maxCount) break;

      // Apply genre filter - skip creating channel for blocked genres
      if (!this.isGenreAllowed(genre, settings.genreFilter)) continue;

      // Apply content type, rating, and genre filters (item-level)
      const filteredItems = items.filter(item => {
        if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
        if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
        if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
        // Also filter items that have any blocked genre (even if they're in an allowed genre channel)
        const itemGenres = item.Genres || [];
        for (const g of itemGenres) {
          if (!this.isGenreAllowed(g, settings.genreFilter)) return false;
        }
        return true;
      });

      // Check minimum duration
      const totalDuration = filteredItems.reduce(
        (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
        0
      );

      if (totalDuration < MIN_CHANNEL_DURATION_MS) continue;

      const channel = queries.createChannel(this.db, {
        name: genre,
        type: 'auto',
        genre,
        item_ids: filteredItems.map(i => i.Id),
      });

      created.push(channel);
    }

    console.log(`[ChannelManager] Auto-generated ${created.length} genre channels`);
    return created;
  }

  /**
   * Create a channel from a specific preset
   */
  createPresetChannel(presetId: string): ChannelParsed {
    const preset = getPresetById(presetId);
    if (!preset) {
      throw new Error(`Unknown preset: ${presetId}`);
    }

    const libraryItems = this.jellyfin.getLibraryItems();
    const filteredItems = this.filterItemsByChannelFilter(libraryItems, preset.filter);

    if (filteredItems.length === 0) {
      throw new Error(`No content matches the "${preset.name}" preset`);
    }

    const channel = queries.createChannel(this.db, {
      name: preset.name,
      type: 'preset',
      preset_id: preset.id,
      filter: preset.filter,
      item_ids: filteredItems.map(i => i.Id),
    });

    // Generate schedule for the new channel
    this.scheduleEngine.ensureSchedule(channel);

    return channel;
  }

  /**
   * Create a custom channel from a list of item IDs
   */
  createCustomChannel(name: string, itemIds: string[], aiPrompt?: string): ChannelParsed {
    // Validate all IDs exist in the library
    const validIds = itemIds.filter(id => this.jellyfin.getItem(id));

    if (validIds.length === 0) {
      throw new Error('No valid items found for channel');
    }

    const channel = queries.createChannel(this.db, {
      name,
      type: 'custom',
      item_ids: validIds,
      ai_prompt: aiPrompt,
    });

    // Generate schedule for the new channel
    this.scheduleEngine.ensureSchedule(channel);

    return channel;
  }

  /**
   * Create a custom channel with a filter
   */
  createFilteredChannel(name: string, filter: ChannelFilter): ChannelParsed {
    const libraryItems = this.jellyfin.getLibraryItems();
    const filteredItems = this.filterItemsByChannelFilter(libraryItems, filter);

    if (filteredItems.length === 0) {
      throw new Error('No content matches the specified filter');
    }

    const channel = queries.createChannel(this.db, {
      name,
      type: 'custom',
      filter,
      item_ids: filteredItems.map(i => i.Id),
    });

    // Generate schedule for the new channel
    this.scheduleEngine.ensureSchedule(channel);

    return channel;
  }

  /**
   * Filter library items based on a ChannelFilter
   */
  filterItemsByChannelFilter(items: JellyfinItem[], filter: ChannelFilter): JellyfinItem[] {
    return items.filter(item => {
      // Content type filter
      const includeMovies = filter.includeMovies ?? true;
      const includeEpisodes = filter.includeEpisodes ?? true;
      
      if (!includeMovies && item.Type === 'Movie') return false;
      if (!includeEpisodes && item.Type === 'Episode') return false;
      
      // If only one type is explicitly true and the other is explicitly false
      if (filter.includeMovies === true && filter.includeEpisodes === false && item.Type !== 'Movie') {
        return false;
      }
      if (filter.includeEpisodes === true && filter.includeMovies === false && item.Type !== 'Episode') {
        return false;
      }

      // Genre filter (include)
      if (filter.genres && filter.genres.length > 0) {
        const itemGenres = (item.Genres || []).map(g => g.toLowerCase());
        const hasMatchingGenre = filter.genres.some(fg => 
          itemGenres.some(ig => ig.includes(fg.toLowerCase()) || fg.toLowerCase().includes(ig))
        );
        if (!hasMatchingGenre) return false;
      }

      // Genre filter (exclude)
      if (filter.excludeGenres && filter.excludeGenres.length > 0) {
        const itemGenres = (item.Genres || []).map(g => g.toLowerCase());
        const hasExcludedGenre = filter.excludeGenres.some(fg =>
          itemGenres.some(ig => ig.includes(fg.toLowerCase()))
        );
        if (hasExcludedGenre) return false;
      }

      // Year filter
      if (filter.minYear && (item.ProductionYear || 0) < filter.minYear) return false;
      if (filter.maxYear && (item.ProductionYear || 9999) > filter.maxYear) return false;

      // Recently added filter
      if (filter.releasedInLastDays && item.DateCreated) {
        const addedDate = new Date(item.DateCreated);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - filter.releasedInLastDays);
        if (addedDate < cutoff) return false;
      }

      // Rating filter (include)
      if (filter.ratings && filter.ratings.length > 0) {
        if (!item.OfficialRating || !filter.ratings.includes(item.OfficialRating)) {
          return false;
        }
      }

      // Rating filter (exclude)
      if (filter.excludeRatings && filter.excludeRatings.length > 0) {
        if (item.OfficialRating && filter.excludeRatings.includes(item.OfficialRating)) {
          return false;
        }
      }

      // Duration filter
      const durationMinutes = this.jellyfin.getItemDurationMs(item) / 60000;
      if (filter.minDurationMinutes && durationMinutes < filter.minDurationMinutes) return false;
      if (filter.maxDurationMinutes && durationMinutes > filter.maxDurationMinutes) return false;

      // Studio filter
      if (filter.studios && filter.studios.length > 0) {
        const itemStudios = (item.Studios || []).map(s => s.Name.toLowerCase());
        const hasMatchingStudio = filter.studios.some(fs =>
          itemStudios.some(is => is.includes(fs.toLowerCase()))
        );
        if (!hasMatchingStudio) return false;
      }

      // Behavioral filters (require UserData)
      if (filter.unwatchedOnly && item.UserData?.Played) return false;
      if (filter.favoritesOnly && !item.UserData?.IsFavorite) return false;

      // Continue watching (partially watched)
      if (filter.continueWatching) {
        const played = item.UserData?.Played;
        const percentage = item.UserData?.PlayedPercentage ?? 0;
        if (played || percentage === 0 || percentage > 90) return false;
      }

      // Forgotten gems (not watched in X days)
      if (filter.notWatchedInDays && item.UserData?.LastPlayedDate) {
        const lastPlayed = new Date(item.UserData.LastPlayedDate);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - filter.notWatchedInDays);
        if (lastPlayed > cutoff) return false;
      }

      // Series filter
      if (filter.seriesIds && filter.seriesIds.length > 0) {
        if (item.Type === 'Episode' && item.SeriesId) {
          if (!filter.seriesIds.includes(item.SeriesId)) return false;
        } else if (item.Type === 'Movie') {
          // For movies in franchise, would need Tags check
          return false;
        }
      }

      // Director filter
      if (filter.directors && filter.directors.length > 0) {
        const itemDirectors = (item.People || [])
          .filter(p => p.Type === 'Director')
          .map(p => p.Name.toLowerCase());
        const hasMatchingDirector = filter.directors.some(fd =>
          itemDirectors.some(id => id === fd.toLowerCase())
        );
        if (!hasMatchingDirector) return false;
      }

      // Actor filter
      if (filter.actors && filter.actors.length > 0) {
        const itemActors = (item.People || [])
          .filter(p => p.Type === 'Actor')
          .map(p => p.Name.toLowerCase());
        const hasMatchingActor = filter.actors.some(fa =>
          itemActors.some(ia => ia === fa.toLowerCase())
        );
        if (!hasMatchingActor) return false;
      }

      // Composer filter
      if (filter.composers && filter.composers.length > 0) {
        const itemComposers = (item.People || [])
          .filter(p => p.Type === 'Composer')
          .map(p => p.Name.toLowerCase());
        const hasMatchingComposer = filter.composers.some(fc =>
          itemComposers.some(ic => ic === fc.toLowerCase())
        );
        if (!hasMatchingComposer) return false;
      }

      return true;
    });
  }

  /**
   * Get all available genres from the library
   */
  getAvailableGenres(): { genre: string; count: number; totalDurationMs: number }[] {
    const genres = this.jellyfin.getGenres();
    const result: { genre: string; count: number; totalDurationMs: number }[] = [];

    for (const [genre, items] of genres) {
      const totalDurationMs = items.reduce(
        (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
        0
      );
      result.push({ genre, count: items.length, totalDurationMs });
    }

    return result.sort((a, b) => b.count - a.count);
  }

  /**
   * Get all available content ratings from the library
   */
  getAvailableRatings(): { rating: string; count: number }[] {
    const libraryItems = this.jellyfin.getLibraryItems();
    const ratingCounts = new Map<string, number>();

    for (const item of libraryItems) {
      const rating = item.OfficialRating;
      if (rating) {
        ratingCounts.set(rating, (ratingCounts.get(rating) || 0) + 1);
      }
    }

    const result: { rating: string; count: number }[] = [];
    for (const [rating, count] of ratingCounts) {
      result.push({ rating, count });
    }

    return result.sort((a, b) => b.count - a.count);
  }

  /**
   * Preview how many items match a preset (without creating channel)
   * For dynamic presets, returns info about the channels that would be generated
   */
  async previewPreset(presetId: string): Promise<{ count: number; totalDurationMs: number; isDynamic?: boolean; dynamicChannels?: { name: string; count: number }[] }> {
    const preset = getPresetById(presetId);
    if (!preset) {
      return { count: 0, totalDurationMs: 0 };
    }

    const libraryItems = this.jellyfin.getLibraryItems();

    // Handle dynamic presets
    if (preset.isDynamic) {
      return await this.previewDynamicPreset(preset, libraryItems);
    }

    const filtered = this.filterItemsByChannelFilter(libraryItems, preset.filter);
    const totalDurationMs = filtered.reduce(
      (sum, item) => sum + this.jellyfin.getItemDurationMs(item),
      0
    );

    return { count: filtered.length, totalDurationMs };
  }

  /**
   * Preview dynamic preset channels
   */
  private async previewDynamicPreset(preset: typeof CHANNEL_PRESETS[0], libraryItems: JellyfinItem[]): Promise<{ count: number; totalDurationMs: number; isDynamic: boolean; dynamicChannels: { name: string; count: number }[] }> {
    const dynamicChannels: { name: string; count: number }[] = [];
    let totalItems = 0;
    let totalDuration = 0;

    if (preset.dynamicType === 'genres') {
      const genres = this.jellyfin.getGenres();
      const settings = this.getFilterSettings();
      const sortedGenres = Array.from(genres.entries()).sort((a, b) => b[1].length - a[1].length);

      for (const [genre, items] of sortedGenres) {
        if (!this.isGenreAllowed(genre, settings.genreFilter)) continue;

        const filteredItems = items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          // Also filter items that have any blocked genre
          const itemGenres = item.Genres || [];
          for (const g of itemGenres) {
            if (!this.isGenreAllowed(g, settings.genreFilter)) return false;
          }
          return true;
        });

        const duration = filteredItems.reduce((sum, item) => sum + this.jellyfin.getItemDurationMs(item), 0);
        if (duration >= MIN_CHANNEL_DURATION_MS) {
          dynamicChannels.push({ name: genre, count: filteredItems.length });
          totalItems += filteredItems.length;
          totalDuration += duration;
        }
      }
    } else if (preset.dynamicType === 'eras') {
      const decades = this.getDecadesFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      for (const decade of decades) {
        const filter: ChannelFilter = {
          ...preset.filter,
          minYear: decade.startYear,
          maxYear: decade.endYear,
        };

        let filteredItems = this.filterItemsByChannelFilter(libraryItems, filter);
        // Apply global content filters
        filteredItems = filteredItems.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });
        const duration = filteredItems.reduce((sum, item) => sum + this.jellyfin.getItemDurationMs(item), 0);
        
        if (duration >= MIN_CHANNEL_DURATION_MS) {
          dynamicChannels.push({ name: decade.name, count: filteredItems.length });
          totalItems += filteredItems.length;
          totalDuration += duration;
        }
      }
    } else if (preset.dynamicType === 'directors') {
      const directors = this.getDirectorsFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      for (const director of directors) {
        const filteredItems = director.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        const duration = filteredItems.reduce((sum, item) => sum + this.jellyfin.getItemDurationMs(item), 0);
        if (duration >= MIN_CAST_CHANNEL_DURATION_MS) {
          dynamicChannels.push({ name: director.name, count: filteredItems.length });
          totalItems += filteredItems.length;
          totalDuration += duration;
        }
      }
    } else if (preset.dynamicType === 'actors') {
      const actors = this.getActorsFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      for (const actor of actors) {
        const filteredItems = actor.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        const duration = filteredItems.reduce((sum, item) => sum + this.jellyfin.getItemDurationMs(item), 0);
        if (duration >= MIN_CAST_CHANNEL_DURATION_MS) {
          dynamicChannels.push({ name: actor.name, count: filteredItems.length });
          totalItems += filteredItems.length;
          totalDuration += duration;
        }
      }
    } else if (preset.dynamicType === 'composers') {
      const composers = this.getComposersFromLibrary(libraryItems);
      const settings = this.getFilterSettings();

      for (const composer of composers) {
        const filteredItems = composer.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        const duration = filteredItems.reduce((sum, item) => sum + this.jellyfin.getItemDurationMs(item), 0);
        if (duration >= MIN_CAST_CHANNEL_DURATION_MS) {
          dynamicChannels.push({ name: composer.name, count: filteredItems.length });
          totalItems += filteredItems.length;
          totalDuration += duration;
        }
      }
    } else if (preset.dynamicType === 'collections') {
      const collections = await this.jellyfin.getCollections();
      const settings = this.getFilterSettings();

      for (const collection of collections) {
        // Use items directly from the collection
        const filteredItems = collection.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        const duration = filteredItems.reduce((sum, item) => sum + this.jellyfin.getItemDurationMs(item), 0);
        if (duration >= MIN_CHANNEL_DURATION_MS) {
          dynamicChannels.push({ name: collection.name, count: filteredItems.length });
          totalItems += filteredItems.length;
          totalDuration += duration;
        }
      }
    } else if (preset.dynamicType === 'studios') {
      const studios = this.getStudiosFromLibrary(libraryItems);

      for (const studio of studios) {
        const filteredItems = studio.items.filter(item => {
          if (item.Type === 'Movie' && !settings.contentTypes.movies) return false;
          if (item.Type === 'Episode' && !settings.contentTypes.tv_shows) return false;
          if (!this.isRatingAllowed(item.OfficialRating, settings.ratingFilter)) return false;
          const itemGenres = item.Genres || [];
          for (const genre of itemGenres) {
            if (!this.isGenreAllowed(genre, settings.genreFilter)) return false;
          }
          return true;
        });

        const duration = filteredItems.reduce((sum, item) => sum + this.jellyfin.getItemDurationMs(item), 0);
        if (duration >= MIN_CHANNEL_DURATION_MS) {
          dynamicChannels.push({ name: studio.name, count: filteredItems.length });
          totalItems += filteredItems.length;
          totalDuration += duration;
        }
      }
    }

    return {
      count: totalItems,
      totalDurationMs: totalDuration,
      isDynamic: true,
      dynamicChannels,
    };
  }

  /**
   * Search library items by query (for manual channel creation)
   */
  searchLibrary(query: string): JellyfinItem[] {
    const items = this.jellyfin.getLibraryItems();
    const lower = query.toLowerCase();

    return items.filter(item => {
      const name = (item.Name || '').toLowerCase();
      const seriesName = (item.SeriesName || '').toLowerCase();
      const genres = (item.Genres || []).map(g => g.toLowerCase());
      return name.includes(lower) || seriesName.includes(lower) || genres.some(g => g.includes(lower));
    }).slice(0, 100); // Limit results
  }

  // ─── Private helpers ──────────────────────────────────

  private getFilterSettings(): { 
    genreFilter: { mode: string; genres: string[] }; 
    contentTypes: { movies: boolean; tv_shows: boolean };
    ratingFilter: { mode: string; ratings: string[]; ratingSystem: string };
  } {
    const genreFilter = (queries.getSetting(this.db, 'genre_filter') as { mode: string; genres: string[] }) || { mode: 'allow', genres: [] };
    const contentTypes = (queries.getSetting(this.db, 'content_types') as { movies: boolean; tv_shows: boolean }) || { movies: true, tv_shows: true };
    const ratingFilter = (queries.getSetting(this.db, 'rating_filter') as { mode: string; ratings: string[]; ratingSystem: string }) || { mode: 'allow', ratings: [], ratingSystem: 'us' };
    return { genreFilter, contentTypes, ratingFilter };
  }

  private isRatingAllowed(rating: string | undefined, filter: { mode: string; ratings: string[] }): boolean {
    // If no ratings selected, allow all
    if (filter.ratings.length === 0) return true;

    // If item has no rating, allow it (unrated content is not blocked)
    if (!rating) return true;

    const lowerRating = rating.toLowerCase();
    const filterRatings = filter.ratings.map(r => r.toLowerCase());

    // In the simplified UI, mode is always 'allow' and ratings list contains BLOCKED ratings
    // So we return true if the rating is NOT in the blocked list
    if (filter.mode === 'allow') {
      return !filterRatings.includes(lowerRating);
    }
    // 'deny' mode (legacy): block all except selected
    return filterRatings.includes(lowerRating);
  }

  private isGenreAllowed(genre: string, filter: { mode: string; genres: string[] }): boolean {
    if (filter.genres.length === 0) return true; // No filter = allow all

    const lower = genre.toLowerCase();
    const filterGenres = filter.genres.map(g => g.toLowerCase());

    // In the simplified UI, mode is always 'allow' and genres list contains BLOCKED genres
    // So we return true if the genre is NOT in the blocked list
    if (filter.mode === 'allow') {
      return !filterGenres.includes(lower);
    }
    // 'deny' mode (legacy): block all except selected
    return filterGenres.includes(lower);
  }
}
