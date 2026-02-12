import type { JellyfinItem } from '../types/index.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-3-flash-preview';

interface AIChannelResult {
  name: string;
  item_ids: string[];
  description: string;
}

export class AIService {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY || undefined;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async createChannelFromPrompt(
    prompt: string,
    libraryItems: JellyfinItem[]
  ): Promise<AIChannelResult> {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured');
    }

    // Build a compact library summary for the AI
    const librarySummary = this.buildLibrarySummary(libraryItems);

    const systemPrompt = `You are a TV channel curator. The user wants to create a custom TV channel from their media library.

Given the user's request and their available library, return a JSON object with:
- "name": A short, catchy channel name (e.g., "90s Nostalgia", "Horror Night")
- "item_ids": An array of item IDs from the library that match the request
- "description": A one-sentence description of the channel

IMPORTANT RULES:
1. ONLY include item IDs that exist in the provided library
2. Try to include at least 4 hours worth of content
3. If you can't find enough matching content, include what you can and explain in the description
4. Return ONLY valid JSON, no markdown or extra text

Available Library:
${librarySummary}`;

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/prevue',
        'X-Title': 'Prevue TV Guide',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4096,
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
    const result = JSON.parse(content) as AIChannelResult;

    // Validate that all item_ids exist in the library
    const validIds = new Set(libraryItems.map(i => i.Id));
    result.item_ids = result.item_ids.filter(id => validIds.has(id));

    if (result.item_ids.length === 0) {
      throw new Error('AI could not find any matching content in your library');
    }

    return result;
  }

  private buildLibrarySummary(items: JellyfinItem[]): string {
    // Group by type for compact representation
    const movies = items.filter(i => i.Type === 'Movie');
    const episodes = items.filter(i => i.Type === 'Episode');

    // For episodes, group by series
    const seriesMap = new Map<string, { name: string; seasons: Set<number>; episodeCount: number; id: string }>();
    const episodeIds: string[] = [];

    for (const ep of episodes) {
      const seriesId = ep.SeriesId || ep.Id;
      if (!seriesMap.has(seriesId)) {
        seriesMap.set(seriesId, {
          name: ep.SeriesName || ep.Name,
          seasons: new Set(),
          episodeCount: 0,
          id: seriesId,
        });
      }
      const series = seriesMap.get(seriesId)!;
      if (ep.ParentIndexNumber) series.seasons.add(ep.ParentIndexNumber);
      series.episodeCount++;
      episodeIds.push(ep.Id);
    }

    let summary = 'MOVIES:\n';
    for (const movie of movies) {
      const year = movie.ProductionYear ? ` (${movie.ProductionYear})` : '';
      const genres = movie.Genres?.join(', ') || 'Unknown';
      summary += `- ID:${movie.Id} | ${movie.Name}${year} | ${genres}\n`;
    }

    summary += '\nTV SERIES:\n';
    for (const [seriesId, info] of seriesMap) {
      const seasons = Array.from(info.seasons).sort((a, b) => a - b);
      summary += `- Series:${seriesId} | ${info.name} | Seasons: ${seasons.join(',')} | ${info.episodeCount} episodes\n`;

      // Include episode IDs for this series
      const seriesEps = episodes.filter(e => e.SeriesId === seriesId);
      for (const ep of seriesEps) {
        summary += `  - ID:${ep.Id} | S${ep.ParentIndexNumber || '?'}E${ep.IndexNumber || '?'} ${ep.Name}\n`;
      }
    }

    return summary;
  }
}
