import type { JellyfinItem } from '../types/index.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

interface AIChannelResult {
  name: string;
  item_ids: string[];
  description: string;
}

/** Raw shape returned by the LLM (uses short index keys, not real Jellyfin IDs). */
interface AIRawResult {
  name: string;
  /** Short keys like "M0", "M5", "S2" */
  items: string[];
  description: string;
}

interface AIRequestOptions {
  apiKey?: string;
  model?: string;
}

export class AIService {
  private envApiKey: string | undefined;

  constructor() {
    this.envApiKey = process.env.OPENROUTER_API_KEY || undefined;
  }

  /** Check if AI is available via env var alone (for backward compat). */
  isAvailable(): boolean {
    return !!this.envApiKey;
  }

  /** Check if AI is available given optional user-configured key. */
  isAvailableWith(userApiKey?: string): boolean {
    return !!(userApiKey || this.envApiKey);
  }

  /** Resolve the effective API key: user-configured takes priority, then env var. */
  private resolveApiKey(options?: AIRequestOptions): string | undefined {
    return options?.apiKey || this.envApiKey;
  }

  /** Resolve the effective model: user-configured takes priority, then default. */
  private resolveModel(options?: AIRequestOptions): string {
    return options?.model || DEFAULT_MODEL;
  }

  async createChannelFromPrompt(
    prompt: string,
    libraryItems: JellyfinItem[],
    options?: AIRequestOptions
  ): Promise<AIChannelResult> {
    const apiKey = this.resolveApiKey(options);
    if (!apiKey) {
      throw new Error('OpenRouter API key not configured');
    }

    const model = this.resolveModel(options);

    // Build compact library with short index keys to minimize tokens
    const { summary, movieKeyToId, seriesKeyToEpisodeIds } = this.buildLibrarySummary(libraryItems);

    const systemPrompt = `You curate TV channels from a media library. Return JSON with:
- "name": Short channel name (e.g. "90s Nostalgia", "Horror Night")
- "items": Array of keys from the library below (M0, M1... for movies, S0, S1... for series)
- "description": One sentence about the channel

Rules:
1. ONLY use keys listed below
2. Include enough for ~4+ hours of content
3. For series (S keys), all episodes are included automatically
4. Return ONLY valid JSON

Library:
${summary}`;

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/prevue',
        'X-Title': 'Prevue TV Guide',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 2048,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No response from AI');
    }

    // Parse the JSON response
    const raw = JSON.parse(content) as AIRawResult;

    // Map short keys back to real Jellyfin IDs
    const itemIds: string[] = [];
    for (const key of (raw.items || [])) {
      const movieId = movieKeyToId.get(key);
      if (movieId) {
        itemIds.push(movieId);
        continue;
      }
      const episodeIds = seriesKeyToEpisodeIds.get(key);
      if (episodeIds) {
        itemIds.push(...episodeIds);
      }
    }

    // Deduplicate
    const uniqueIds = [...new Set(itemIds)];

    if (uniqueIds.length === 0) {
      throw new Error('AI could not find any matching content in your library');
    }

    return {
      name: raw.name,
      item_ids: uniqueIds,
      description: raw.description,
    };
  }

  /**
   * Build a token-efficient library summary using short index keys.
   * Movies get M0..Mn, series get S0..Sn. Episodes are grouped under
   * their series (the AI picks a series key, we expand to all episodes).
   */
  private buildLibrarySummary(items: JellyfinItem[]): {
    summary: string;
    movieKeyToId: Map<string, string>;
    seriesKeyToEpisodeIds: Map<string, string[]>;
  } {
    const movies = items.filter(i => i.Type === 'Movie');
    const episodes = items.filter(i => i.Type === 'Episode');

    // Group episodes by series
    const seriesMap = new Map<string, { name: string; seasons: Set<number>; episodeCount: number; episodeIds: string[]; genres: Set<string>; year: number | null }>();
    for (const ep of episodes) {
      const seriesId = ep.SeriesId || ep.Id;
      if (!seriesMap.has(seriesId)) {
        seriesMap.set(seriesId, {
          name: ep.SeriesName || ep.Name,
          seasons: new Set(),
          episodeCount: 0,
          episodeIds: [],
          genres: new Set(ep.Genres || []),
          year: ep.ProductionYear || null,
        });
      }
      const series = seriesMap.get(seriesId)!;
      if (ep.ParentIndexNumber) series.seasons.add(ep.ParentIndexNumber);
      series.episodeCount++;
      series.episodeIds.push(ep.Id);
      // Merge genres from episodes
      for (const g of (ep.Genres || [])) series.genres.add(g);
    }

    const movieKeyToId = new Map<string, string>();
    const seriesKeyToEpisodeIds = new Map<string, string[]>();
    const lines: string[] = [];

    // Movies: "M0 The Matrix (1999) Action,Sci-Fi 136min"
    if (movies.length > 0) {
      lines.push('MOVIES:');
      for (let i = 0; i < movies.length; i++) {
        const m = movies[i];
        const key = `M${i}`;
        movieKeyToId.set(key, m.Id);
        const year = m.ProductionYear ? ` (${m.ProductionYear})` : '';
        const genres = m.Genres?.slice(0, 3).join(',') || '?';
        const mins = m.RunTimeTicks ? Math.round(m.RunTimeTicks / 600000000) : 0;
        const dur = mins > 0 ? ` ${mins}m` : '';
        lines.push(`${key} ${m.Name}${year} ${genres}${dur}`);
      }
    }

    // Series: "S0 Breaking Bad S1-5 62ep Drama,Crime"
    if (seriesMap.size > 0) {
      lines.push('SERIES:');
      let idx = 0;
      for (const [, info] of seriesMap) {
        const key = `S${idx}`;
        seriesKeyToEpisodeIds.set(key, info.episodeIds);
        const seasons = Array.from(info.seasons).sort((a, b) => a - b);
        const seasonStr = seasons.length > 0
          ? (seasons.length === 1 ? `S${seasons[0]}` : `S${seasons[0]}-${seasons[seasons.length - 1]}`)
          : '';
        const genres = Array.from(info.genres).slice(0, 3).join(',') || '?';
        lines.push(`${key} ${info.name} ${seasonStr} ${info.episodeCount}ep ${genres}`);
        idx++;
      }
    }

    return { summary: lines.join('\n'), movieKeyToId, seriesKeyToEpisodeIds };
  }
}

export const DEFAULT_AI_MODEL = DEFAULT_MODEL;
