import type { MediaItem, IconicScene } from '../types/index.js';

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
  /** Optional media type filter: "movies", "shows", or "all" */
  filter?: 'movies' | 'shows' | 'all';
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

  /**
   * Centralized LLM call with logging. All AI features go through this method.
   */
  private async callLLM(
    feature: string,
    messages: { role: string; content: string }[],
    params: { model: string; apiKey: string; max_tokens: number; temperature: number }
  ): Promise<string> {
    const startTime = Date.now();
    console.log(`[AI:${feature}] Calling ${params.model} (max_tokens=${params.max_tokens})...`);

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.apiKey}`,
        'HTTP-Referer': 'https://github.com/prevue',
        'X-Title': 'Prevue TV Guide',
      },
      body: JSON.stringify({
        model: params.model,
        messages,
        max_tokens: params.max_tokens,
        temperature: params.temperature,
        response_format: { type: 'json_object' },
      }),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AI:${feature}] Failed (${response.status}) in ${elapsed}ms: ${errorText.slice(0, 200)}`);
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    let content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error(`[AI:${feature}] Empty response in ${elapsed}ms`);
      throw new Error('No response from AI');
    }

    // Strip markdown code fences that some models add despite json response_format
    content = content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const tokens = data.usage;
    const tokenStr = tokens
      ? ` (${tokens.prompt_tokens ?? '?'}→${tokens.completion_tokens ?? '?'} tokens)`
      : '';
    console.log(`[AI:${feature}] Completed in ${elapsed}ms${tokenStr}`);

    return content;
  }

  async createChannelFromPrompt(
    prompt: string,
    libraryItems: MediaItem[],
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
- "filter": "movies" if user wants only movies, "shows" if user wants only TV shows/series, or "all" for both

Rules:
1. ONLY use keys listed below
2. Include enough for ~4+ hours of content
3. For series (S keys), all episodes are included automatically
4. Return ONLY valid JSON
5. If filter is "movies", only use M keys. If filter is "shows", only use S keys.

Library:
${summary}`;

    const content = await this.callLLM('channel-create', [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], { model, apiKey, max_tokens: 2048, temperature: 0.3 });

    // Parse the JSON response
    const raw = JSON.parse(content) as AIRawResult;
    const filter = raw.filter || 'all';

    // Map short keys back to real Jellyfin IDs, enforcing the filter
    const itemIds: string[] = [];
    for (const key of (raw.items || [])) {
      if (filter !== 'shows') {
        const movieId = movieKeyToId.get(key);
        if (movieId) {
          itemIds.push(movieId);
          continue;
        }
      }
      if (filter !== 'movies') {
        const episodeIds = seriesKeyToEpisodeIds.get(key);
        if (episodeIds) {
          itemIds.push(...episodeIds);
        }
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
   * Generate fun facts for multiple programs, chunked into small LLM calls.
   * Each chunk handles up to 5 programs to keep requests/responses short.
   */
  async getBatchProgramFacts(
    programs: { key: string; label: string }[],
    options?: AIRequestOptions
  ): Promise<Record<string, string[]>> {
    const apiKey = this.resolveApiKey(options);
    if (!apiKey) throw new Error('OpenRouter API key not configured');
    if (programs.length === 0) return {};

    const CHUNK_SIZE = 100;
    const result: Record<string, string[]> = {};

    for (let i = 0; i < programs.length; i += CHUNK_SIZE) {
      const chunk = programs.slice(i, i + CHUNK_SIZE);
      try {
        const chunkResult = await this.fetchProgramFactsChunk(chunk, options);
        Object.assign(result, chunkResult);
      } catch (err) {
        console.error(`[AIService] Program facts chunk ${i / CHUNK_SIZE + 1} failed:`, (err as Error).message);
      }
    }
    return result;
  }

  private async fetchProgramFactsChunk(
    programs: { key: string; label: string }[],
    options?: AIRequestOptions
  ): Promise<Record<string, string[]>> {
    const apiKey = this.resolveApiKey(options)!;
    const model = this.resolveModel(options);

    const listing = programs.map((p, i) => `${i + 1}. [${p.key}] ${p.label}`).join('\n');

    const systemPrompt = `You are a fun TV trivia host. For EACH item, return exactly 5 interesting, entertaining facts. Facts can include behind-the-scenes details, casting trivia, box office milestones, cultural impact, easter eggs, awards, or connections to other media.

Return ONLY a JSON object where each key is the bracketed identifier from the list, and the value is an array of 5 short fact strings (1-2 sentences each). Example:
{"movie_abc": ["Fact 1...", "Fact 2...", ...], "series:Breaking Bad": ["Fact 1...", ...]}`;

    const content = await this.callLLM(`program-facts (${programs.length} items)`, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Currently airing programs:\n${listing}` },
    ], { model, apiKey, max_tokens: 16384, temperature: 0.7 });

    const parsed = JSON.parse(content) as Record<string, string[]>;
    const result: Record<string, string[]> = {};
    for (const p of programs) {
      const facts = parsed[p.key];
      if (Array.isArray(facts)) {
        result[p.key] = facts.slice(0, 5).filter(f => typeof f === 'string');
      }
    }
    return result;
  }

  /**
   * Generate iconic scenes for multiple movies, chunked into small LLM calls.
   * Each chunk handles up to 3 movies to keep requests/responses short.
   */
  async generateBatchIconicScenes(
    movies: { key: string; title: string; year: number | null; durationMinutes: number }[],
    options?: AIRequestOptions
  ): Promise<Record<string, IconicScene[]>> {
    const apiKey = this.resolveApiKey(options);
    if (!apiKey) throw new Error('OpenRouter API key not configured');
    if (movies.length === 0) return {};

    const CHUNK_SIZE = 100;
    const result: Record<string, IconicScene[]> = {};

    for (let i = 0; i < movies.length; i += CHUNK_SIZE) {
      const chunk = movies.slice(i, i + CHUNK_SIZE);
      try {
        const chunkResult = await this.fetchIconicScenesChunk(chunk, options);
        Object.assign(result, chunkResult);
      } catch (err) {
        console.error(`[AIService] Iconic scenes chunk ${i / CHUNK_SIZE + 1} failed:`, (err as Error).message);
        // Fill failed chunk with empty arrays
        for (const movie of chunk) {
          result[movie.key] = [];
        }
      }
    }
    return result;
  }

  private async fetchIconicScenesChunk(
    movies: { key: string; title: string; year: number | null; durationMinutes: number }[],
    options?: AIRequestOptions
  ): Promise<Record<string, IconicScene[]>> {
    const apiKey = this.resolveApiKey(options)!;
    const model = this.resolveModel(options);

    const listing = movies.map((m, i) => {
      const yearStr = m.year ? ` (${m.year})` : '';
      return `${i + 1}. [${m.key}] "${m.title}"${yearStr} — ${m.durationMinutes} min`;
    }).join('\n');

    const systemPrompt = `You are a film and television expert. For EACH program, identify the most iconic, most talked-about scenes — the moments people quote, reference, and remember.

For each scene, provide:
- "name": A short, recognizable name (e.g. "I am your father", "Here's looking at you, kid")
- "timestamp_minutes": Minutes into the program when this scene starts
- "end_minutes": Minutes into the program when this scene ends (the scene's natural conclusion)
- "why": 1-2 sentences on why it's iconic and widely talked about

Rules:
1. Only the most iconic, most culturally discussed scenes — the ones everyone knows and talks about
2. timestamp_minutes and end_minutes must be between 0 and the program's runtime, and end_minutes must be greater than timestamp_minutes
3. Scene duration (end_minutes - timestamp_minutes) should reflect the actual scene length, typically 1-5 minutes
4. Up to 2 scenes per program maximum — choose only the very best
5. For lesser-known programs, fewer scenes or an empty array is fine
6. Return ONLY a JSON object keyed by the bracketed identifier. Each value is an array of scene objects.

Example: {"movie_abc": [{"name": "...", "timestamp_minutes": 45, "end_minutes": 48, "why": "..."}], "movie_xyz": []}`;

    const content = await this.callLLM(`iconic-scenes (${movies.length} movies)`, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Movies:\n${listing}` },
    ], { model, apiKey, max_tokens: 32768, temperature: 0.2 });

    const parsed = JSON.parse(content) as Record<string, IconicScene[]>;

    const result: Record<string, IconicScene[]> = {};
    for (const movie of movies) {
      const scenes = parsed[movie.key];
      if (!Array.isArray(scenes)) {
        result[movie.key] = [];
        continue;
      }
      result[movie.key] = scenes
        .filter(s =>
          typeof s.name === 'string' &&
          typeof s.timestamp_minutes === 'number' &&
          typeof s.end_minutes === 'number' &&
          typeof s.why === 'string' &&
          s.timestamp_minutes >= 0 &&
          s.end_minutes > s.timestamp_minutes &&
          s.end_minutes <= movie.durationMinutes
        )
        .slice(0, 2)
        .sort((a, b) => a.timestamp_minutes - b.timestamp_minutes);
    }
    return result;
  }

  /**
   * Generate a catch-up summary for a movie the viewer tuned into mid-way.
   * Returns a concise summary of where the viewer is in the story right now.
   */
  async generateCatchUpSummary(
    title: string,
    year: number | null,
    elapsedMinutes: number,
    durationMinutes: number,
    options?: AIRequestOptions
  ): Promise<string> {
    const apiKey = this.resolveApiKey(options);
    if (!apiKey) throw new Error('AI not configured');
    const model = this.resolveModel(options);

    const yearStr = year ? ` (${year})` : '';
    const systemPrompt = `Catch up a viewer who tuned into a movie late. Write short, direct sentences. No filler. Say what happened and what's on screen now. Never say "you missed." No spoilers past the elapsed time. 3-4 sentences max.

Return JSON: {"summary": "..."}`;

    const userMessage = `Movie: "${title}"${yearStr}
Runtime: ${durationMinutes} minutes
Viewer tuned in at: ${elapsedMinutes} minutes into the film`;

    const content = await this.callLLM('catch-up', [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ], { model, apiKey, max_tokens: 300, temperature: 0.3 });

    const parsed = JSON.parse(content) as { summary?: string };
    if (!parsed.summary || typeof parsed.summary !== 'string') {
      throw new Error('Invalid catch-up summary response');
    }
    return parsed.summary;
  }

  /**
   * Generate hidden gem recommendations from underwatched library items.
   * Takes user watch profile + candidate items, returns AI-picked gems with reasons.
   */
  async generateHiddenGems(
    userProfile: {
      topGenres: string[];
      topSeries: string[];
      recentFavorites: string[];
      peakHours: number[];
    },
    candidates: {
      key: string;
      title: string;
      type: string;
      year: number | null;
      genres: string[];
      rating: number | null;
      directors: string[];
    }[],
    options?: AIRequestOptions
  ): Promise<{ key: string; reason: string; score: number }[]> {
    const apiKey = this.resolveApiKey(options);
    if (!apiKey) throw new Error('AI not configured');
    const model = this.resolveModel(options);

    if (candidates.length === 0) return [];

    const systemPrompt = `You are a personal movie & TV recommendation engine for a home media library.
The user's library contains items they own but haven't watched yet (or barely watched).
Pick the ~20 best "hidden gems" — items the user would love based on their viewing patterns but probably hasn't noticed.

Prioritize:
1. Strong genre/taste alignment with the user's watch history
2. Higher community ratings (quality signal)
3. Items that connect to shows/directors/actors the user already watches
4. Variety — don't pick 20 items from the same genre

For each pick, return:
- "key": the item's identifier from the candidate list
- "reason": 1-2 sentences explaining WHY this is a gem for this user (reference their taste)
- "score": 1-10 confidence the user would enjoy this (10 = perfect match)

Return ONLY JSON: {"gems": [{"key": "...", "reason": "...", "score": 8}, ...]}
Pick at most 20 items. Fewer is fine if the library is small.`;

    // Build compact candidate listing
    const candidateLines = candidates.map(c => {
      const year = c.year ? ` (${c.year})` : '';
      const genres = c.genres.length > 0 ? ` ${c.genres.slice(0, 3).join(',')}` : '';
      const rating = c.rating ? ` ${c.rating.toFixed(1)}★` : '';
      const directors = c.directors.length > 0 ? ` dir:${c.directors[0]}` : '';
      return `${c.key} ${c.title}${year}${genres}${rating}${directors}`;
    });

    const userMessage = `USER PROFILE:
Top genres watched: ${userProfile.topGenres.join(', ') || 'None yet'}
Favorite series: ${userProfile.topSeries.join(', ') || 'None yet'}
Recent favorites: ${userProfile.recentFavorites.join(', ') || 'None yet'}
Most active viewing hours: ${userProfile.peakHours.length > 0 ? userProfile.peakHours.join(', ') : 'Varied'}

CANDIDATE ITEMS (unwatched/underwatched, rated 6+):
${candidateLines.join('\n')}`;

    const content = await this.callLLM('hidden-gems', [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ], { model, apiKey, max_tokens: 4096, temperature: 0.5 });

    const parsed = JSON.parse(content) as { gems?: { key: string; reason: string; score: number }[] };
    if (!parsed.gems || !Array.isArray(parsed.gems)) return [];

    // Validate each gem
    return parsed.gems.filter(g =>
      typeof g.key === 'string' &&
      typeof g.reason === 'string' &&
      typeof g.score === 'number' &&
      g.score >= 1 && g.score <= 10
    );
  }

  /**
   * Build a token-efficient library summary using short index keys.
   * Movies get M0..Mn, series get S0..Sn. Episodes are grouped under
   * their series (the AI picks a series key, we expand to all episodes).
   */
  private buildLibrarySummary(items: MediaItem[]): {
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
