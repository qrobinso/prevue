import type Database from 'better-sqlite3';
import seedrandom from 'seedrandom';
import type { ChannelParsed, ScheduleProgram, ScheduleBlockParsed, JellyfinItem } from '../types/index.js';
import { JellyfinClient } from './JellyfinClient.js';
import * as queries from '../db/queries.js';
import { generateSeed } from '../utils/crypto.js';
import { getBlockStart, getBlockEnd, getNextBlockStart, getBlockHours, snapForwardTo15Min } from '../utils/time.js';

const EPISODE_RUN_LENGTH_MIN = 2;
const EPISODE_RUN_LENGTH_MAX = 5;
const MAX_GAP_MS = 30 * 60 * 1000; // Maximum 30-minute gap before we try to fill it
const INTERSTITIAL_FALLBACK_MS = 5 * 60 * 1000; // Minimal interstitial when no content fits (was 30 min)
const COOLDOWN_HOURS = 24; // Avoid reusing same program within this many hours
const COOLDOWN_HOURS_MOVIE_CHANNEL = 8; // Shorter cooldown for movie-only channels = more back-to-back content
const MOVIE_POOL_SIZE = 20; // Pick randomly from top N candidates (more = more variety)

/** Kids/family ratings (US); everything else is treated as adult so we don't mix with kids. */
const KIDS_RATINGS = new Set([
  'g', 'pg', 'tv-y', 'tv-y7', 'tv-y7-fv', 'tv-g', 'tv-pg'
]);

function getRatingBucket(rating: string | undefined): 'kids' | 'adult' {
  if (!rating) return 'adult';
  return KIDS_RATINGS.has(rating.toLowerCase().trim()) ? 'kids' : 'adult';
}

function isUnratedOrNotRated(rating: string | undefined): boolean {
  if (!rating || rating.trim() === '') return true;
  return rating.toLowerCase().trim() === 'not rated';
}

/**
 * Tracks which items are playing at which times across all channels.
 * Used to prevent the same movie/show from playing on multiple channels simultaneously.
 */
interface GlobalScheduleTracker {
  // Map of itemId -> array of [startMs, endMs] time ranges when it's scheduled
  itemSlots: Map<string, Array<[number, number]>>;
}

export class ScheduleEngine {
  private db: Database.Database;
  private jellyfin: JellyfinClient;

  constructor(db: Database.Database, jellyfin: JellyfinClient) {
    this.db = db;
    this.jellyfin = jellyfin;
  }

  /**
   * Build a tracker of all currently scheduled items across all channels for a time range.
   * This is used to prevent duplicate content playing simultaneously.
   */
  private buildGlobalTracker(blockStart: Date, blockEnd: Date): GlobalScheduleTracker {
    const tracker: GlobalScheduleTracker = { itemSlots: new Map() };
    const allBlocks = queries.getAllScheduleBlocksInRange(
      this.db,
      blockStart.toISOString(),
      blockEnd.toISOString()
    );

    for (const block of allBlocks) {
      for (const prog of block.programs) {
        if (prog.type === 'interstitial' || !prog.jellyfin_item_id) continue;
        
        const startMs = new Date(prog.start_time).getTime();
        const endMs = new Date(prog.end_time).getTime();
        
        const existing = tracker.itemSlots.get(prog.jellyfin_item_id) || [];
        existing.push([startMs, endMs]);
        tracker.itemSlots.set(prog.jellyfin_item_id, existing);
      }
    }

    return tracker;
  }

  /**
   * Check if an item would conflict with existing schedules (playing at the same time on another channel)
   */
  private wouldConflict(
    tracker: GlobalScheduleTracker,
    itemId: string,
    startMs: number,
    endMs: number
  ): boolean {
    const slots = tracker.itemSlots.get(itemId);
    if (!slots) return false;

    // Check if any existing slot overlaps with the proposed time
    for (const [existingStart, existingEnd] of slots) {
      // Overlap if: start < existingEnd AND end > existingStart
      if (startMs < existingEnd && endMs > existingStart) {
        return true;
      }
    }
    return false;
  }

  /**
   * Add a scheduled item to the tracker
   */
  private addToTracker(
    tracker: GlobalScheduleTracker,
    itemId: string,
    startMs: number,
    endMs: number
  ): void {
    const existing = tracker.itemSlots.get(itemId) || [];
    existing.push([startMs, endMs]);
    tracker.itemSlots.set(itemId, existing);
  }

  /**
   * Generate schedules for all channels (current block + next block).
   * Yields between channels so API requests (e.g. GET /api/schedule) can be served during boot.
   */
  async generateAllSchedules(): Promise<void> {
    const channels = queries.getAllChannels(this.db);
    const now = new Date();
    const currentBlockStart = getBlockStart(now);
    const nextBlockStart = getNextBlockStart(currentBlockStart);
    const blockEnd = getBlockEnd(nextBlockStart);

    // Build global tracker from any existing schedules
    const tracker = this.buildGlobalTracker(currentBlockStart, blockEnd);

    for (const channel of channels) {
      await this.ensureSchedule(channel, now, tracker);
      // Yield to event loop so incoming API requests (schedule, channels) can be handled
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  /**
   * Ensure a channel has current and next block schedules
   */
  async ensureSchedule(
    channel: ChannelParsed,
    now: Date = new Date(),
    tracker?: GlobalScheduleTracker
  ): Promise<void> {
    const currentBlockStart = getBlockStart(now);
    const nextBlockStart = getNextBlockStart(currentBlockStart);
    const blockEnd = getBlockEnd(nextBlockStart);

    // Build tracker if not provided (for single-channel regeneration)
    const globalTracker = tracker || this.buildGlobalTracker(currentBlockStart, blockEnd);

    // Generate current block if missing
    const currentBlock = queries.getScheduleBlock(
      this.db, channel.id, currentBlockStart.toISOString()
    );
    if (!currentBlock) {
      await this.generateBlock(channel, currentBlockStart, globalTracker);
    }

    // Generate next block if missing
    const nextBlock = queries.getScheduleBlock(
      this.db, channel.id, nextBlockStart.toISOString()
    );
    if (!nextBlock) {
      await this.generateBlock(channel, nextBlockStart, globalTracker);
    }
  }

  /**
   * Generate a single 24-hour schedule block for a channel (4am–4am).
   * Yields periodically to allow API requests to be processed during generation.
   * Uses globalTracker to avoid scheduling the same content at the same time as other channels.
   */
  async generateBlock(
    channel: ChannelParsed,
    blockStart: Date,
    globalTracker?: GlobalScheduleTracker
  ): Promise<ScheduleBlockParsed> {
    const blockEnd = getBlockEnd(blockStart);
    const seed = generateSeed(channel.id, blockStart.toISOString());
    const rng = seedrandom(seed);

    // Create a local tracker if none provided
    const tracker = globalTracker || { itemSlots: new Map() };

    // Items scheduled in last 24h for this channel - avoid reusing (cooldown)
    const cooldownStart = new Date(blockStart.getTime() - COOLDOWN_HOURS * 60 * 60 * 1000);
    const scheduledInLast24h = queries.getItemIdsScheduledInRangeForChannel(
      this.db, channel.id, cooldownStart.toISOString(), blockEnd.toISOString()
    );

    let items = this.getChannelItems(channel);
    const standaloneItemsPreview = items.filter(i => i.Type === 'Movie');
    const seriesMapPreview = this.groupBySeries(items);
    const isMovieOnlyChannel = standaloneItemsPreview.length > 0 && seriesMapPreview.size === 0;

    // Movie-only channels: shorter cooldown so we have more content for back-to-back scheduling
    const cooldownHours = isMovieOnlyChannel ? COOLDOWN_HOURS_MOVIE_CHANNEL : COOLDOWN_HOURS;
    const cooldownStartForChannel = new Date(blockStart.getTime() - cooldownHours * 60 * 60 * 1000);
    const scheduledInCooldown = queries.getItemIdsScheduledInRangeForChannel(
      this.db, channel.id, cooldownStartForChannel.toISOString(), blockEnd.toISOString()
    );

    // When rating filter is on, exclude unrated / "Not Rated" from the schedule
    const ratingFilter = (queries.getSetting(this.db, 'rating_filter') as { mode: string; ratings: string[] } | null) ?? { ratings: [] };
    if (ratingFilter.ratings.length > 0) {
      items = items.filter(i => !isUnratedOrNotRated(i.OfficialRating));
    }

    if (items.length === 0) {
      // Empty channel - return block with no programs
      return queries.upsertScheduleBlock(
        this.db, channel.id,
        blockStart.toISOString(), blockEnd.toISOString(),
        [], seed
      );
    }

    const programs: ScheduleProgram[] = [];
    let currentTime = new Date(blockStart);
    const blockEndMs = blockEnd.getTime();
    let lastItemId: string | null = null;
    let yieldCounter = 0; // Yield every N iterations to keep event loop responsive

    // Group episodes by series for episode runs
    const seriesMap = this.groupBySeries(items);
    const seriesIds = Array.from(seriesMap.keys());
    const standaloneItems = items.filter(i => i.Type === 'Movie');

    // Series in cooldown: at least one episode was scheduled in last 24h
    const seriesInCooldown = new Set<string>();
    for (const [sid, episodes] of seriesMap) {
      if (episodes.some(ep => scheduledInLast24h.has(ep.Id))) {
        seriesInCooldown.add(sid);
      }
    }

    // Rating buckets: don't mix kids and adult content
    const seriesBucket = new Map<string, 'kids' | 'adult'>();
    for (const [sid, episodes] of seriesMap) {
      const first = episodes[0];
      if (first) seriesBucket.set(sid, getRatingBucket(first.OfficialRating));
    }

    // Track episode position per series - start at random positions for variety
    const seriesEpisodeIndex = new Map<string, number>();
    for (const [seriesId, episodes] of seriesMap) {
      // Start each series at a random episode for more diverse scheduling
      const randomStartIdx = Math.floor(rng() * episodes.length);
      seriesEpisodeIndex.set(seriesId, randomStartIdx);
    }

    // Track items used in this block to prefer variety
    const usedInBlock = new Set<string>();
    // Track how many times each series has been used in this block (for diversity weighting)
    const seriesUsedCount = new Map<string, number>();
    let failedAttempts = 0;
    const MAX_FAILED_ATTEMPTS = 50; // Prevent infinite loops
    /** Current rating bucket so we don't mix kids and adult content. */
    let lastScheduledBucket: 'kids' | 'adult' | null = null;

    while (currentTime.getTime() < blockEndMs && failedAttempts < MAX_FAILED_ATTEMPTS) {
      const remainingMs = blockEndMs - currentTime.getTime();
      // Only stop if less than 5 minutes left (we'll fill with interstitials after)
      if (remainingMs < 5 * 60 * 1000) break;

      // Yield to event loop every 10 iterations so API requests can be processed
      yieldCounter++;
      if (yieldCounter % 10 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }

      const timeBeforeIteration = currentTime.getTime();
      const startMs = currentTime.getTime();

      // Decide: episode run or standalone (movie-only channels: always movies, back-to-back)
      const doEpisodeRun = seriesIds.length > 0 && (standaloneItems.length === 0 || (rng() < 0.6 && !isMovieOnlyChannel));

      let scheduledSomething = false;

      if (doEpisodeRun && seriesIds.length > 0) {
        // Restrict to same rating bucket (don't mix kids and adult)
        const seriesIdsInBucket = lastScheduledBucket === null
          ? seriesIds
          : seriesIds.filter(s => seriesBucket.get(s) === lastScheduledBucket);
        const candidateSeriesIds = seriesIdsInBucket.length > 0 ? seriesIdsInBucket : seriesIds;
        // Prefer series not in 24h cooldown, avoid back-to-back same series
        // Sort by least-used-in-block first, then filter for cooldown/last-item
        const sortedByUsage = [...candidateSeriesIds].sort((a, b) =>
          (seriesUsedCount.get(a) || 0) - (seriesUsedCount.get(b) || 0)
        );
        const minUsage = seriesUsedCount.get(sortedByUsage[0]) || 0;
        // Pick from the least-used tier (series with the lowest usage count)
        const leastUsedTier = sortedByUsage.filter(s =>
          (seriesUsedCount.get(s) || 0) <= minUsage + 1
        );
        const preferred = leastUsedTier.filter(s =>
          s !== lastItemId && !seriesInCooldown.has(s)
        );
        const fallback = leastUsedTier.filter(s => s !== lastItemId);
        const seriesId = this.pickRandom(
          preferred.length > 0 ? preferred : fallback.length > 0 ? fallback : candidateSeriesIds,
          candidateSeriesIds,
          rng
        );
        const episodes = seriesMap.get(seriesId) || [];
        if (episodes.length > 0) {
          const runLength = EPISODE_RUN_LENGTH_MIN + Math.floor(rng() * (EPISODE_RUN_LENGTH_MAX - EPISODE_RUN_LENGTH_MIN + 1));
          let episodeIdx = seriesEpisodeIndex.get(seriesId) || 0;
          const startingIdx = episodeIdx;

          // Episodes play back-to-back with no gaps
          for (let i = 0; i < runLength && currentTime.getTime() < blockEndMs; i++) {
            // Try multiple episodes to find one that doesn't conflict and isn't in cooldown
            // Prefer episodes not yet used in this block for diversity
            let found = false;
            let bestCandidate: { episode: JellyfinItem; attempt: number; durationMs: number; usedInBlock: boolean } | null = null;

            for (let attempt = 0; attempt < episodes.length; attempt++) {
              const episode = episodes[(episodeIdx + attempt) % episodes.length];
              const durationMs = this.jellyfin.getItemDurationMs(episode);
              if (durationMs === 0) continue;

              const epStartMs = currentTime.getTime();
              const epEndMs = epStartMs + durationMs;
              if (epEndMs > blockEndMs) continue;

              // Skip if in 24h cooldown (already scheduled recently on this channel)
              if (scheduledInLast24h.has(episode.Id)) continue;

              // Check for conflict with other channels
              if (this.wouldConflict(tracker, episode.Id, epStartMs, epEndMs)) {
                continue;
              }

              // If not used in block, use immediately (best case)
              if (!usedInBlock.has(episode.Id)) {
                bestCandidate = { episode, attempt, durationMs, usedInBlock: false };
                break;
              }

              // Otherwise keep as fallback (already used in block but still valid)
              if (!bestCandidate) {
                bestCandidate = { episode, attempt, durationMs, usedInBlock: true };
              }
            }

            if (bestCandidate) {
              const { episode, attempt, durationMs } = bestCandidate;
              const epStartMs = currentTime.getTime();
              const epEndMs = epStartMs + durationMs;
              const endTime = new Date(epEndMs);
              programs.push(this.createProgram(episode, currentTime, endTime));
              this.addToTracker(tracker, episode.Id, epStartMs, epEndMs);
              usedInBlock.add(episode.Id);
              lastItemId = seriesId;
              lastScheduledBucket = getRatingBucket(episode.OfficialRating);
              currentTime = endTime;
              episodeIdx = (episodeIdx + attempt + 1) % episodes.length;
              found = true;
              scheduledSomething = true;
            }
            if (!found) break;
          }

          seriesEpisodeIndex.set(seriesId, episodeIdx);
          // Track how many runs this series has had in this block
          seriesUsedCount.set(seriesId, (seriesUsedCount.get(seriesId) || 0) + 1);
        }
      }
      
      // If episode scheduling didn't work or wasn't chosen, try movies
      if (!scheduledSomething && standaloneItems.length > 0) {
        // Restrict to same rating bucket (don't mix kids and adult)
        const moviesInBucket = lastScheduledBucket === null
          ? standaloneItems
          : standaloneItems.filter(i => getRatingBucket(i.OfficialRating) === lastScheduledBucket);
        const moviePool = moviesInBucket.length > 0 ? moviesInBucket : standaloneItems;
        // Get all movies, preferring ones not used in this block, not in cooldown, and not conflicting
        const movieCandidates = moviePool
          .filter(i => {
            const dur = this.jellyfin.getItemDurationMs(i);
            return dur > 0 && dur <= remainingMs;
          })
          .map(i => ({
            item: i,
            duration: this.jellyfin.getItemDurationMs(i),
            conflicts: this.wouldConflict(tracker, i.Id, startMs, startMs + this.jellyfin.getItemDurationMs(i)),
            usedBefore: usedInBlock.has(i.Id),
            inCooldown: scheduledInCooldown.has(i.Id),
            isLastItem: i.Id === lastItemId
          }))
          .sort((a, b) => {
            // Prefer: not conflicting > not in cooldown > not used before > not last item > longer duration
            if (a.conflicts !== b.conflicts) return a.conflicts ? 1 : -1;
            if (a.inCooldown !== b.inCooldown) return a.inCooldown ? 1 : -1;
            if (a.usedBefore !== b.usedBefore) return a.usedBefore ? 1 : -1;
            if (a.isLastItem !== b.isLastItem) return a.isLastItem ? 1 : -1;
            return b.duration - a.duration;
          });

        // Movie-only channels: if no candidates (all in cooldown/conflict), allow cooldown reuse to avoid interstitials
        let movieCandidatesToUse = movieCandidates;
        if (movieCandidatesToUse.length === 0 && isMovieOnlyChannel) {
          movieCandidatesToUse = moviePool
            .filter(i => {
              const dur = this.jellyfin.getItemDurationMs(i);
              return dur > 0 && dur <= remainingMs;
            })
            .map(i => ({
              item: i,
              duration: this.jellyfin.getItemDurationMs(i),
              conflicts: this.wouldConflict(tracker, i.Id, startMs, startMs + this.jellyfin.getItemDurationMs(i)),
              usedBefore: usedInBlock.has(i.Id),
              inCooldown: scheduledInCooldown.has(i.Id),
              isLastItem: i.Id === lastItemId
            }))
            .sort((a, b) => {
              if (a.conflicts !== b.conflicts) return a.conflicts ? 1 : -1;
              if (a.inCooldown !== b.inCooldown) return a.inCooldown ? 1 : -1;
              if (a.usedBefore !== b.usedBefore) return a.usedBefore ? 1 : -1;
              if (a.isLastItem !== b.isLastItem) return a.isLastItem ? 1 : -1;
              return b.duration - a.duration;
            });
        }
        if (movieCandidatesToUse.length > 0) {
          // Pick from top N candidates for more variety (weighted toward fresher content)
          const topCandidates = movieCandidatesToUse.slice(0, Math.min(MOVIE_POOL_SIZE, movieCandidatesToUse.length));
          const selected = topCandidates[Math.floor(rng() * topCandidates.length)];
          
          const endMs = startMs + selected.duration;
          const endTime = new Date(endMs);
          
          programs.push(this.createProgram(selected.item, currentTime, endTime));
          // Only add to global tracker if not conflicting (allow same-channel replays)
          if (!selected.conflicts) {
            this.addToTracker(tracker, selected.item.Id, startMs, endMs);
          }
          usedInBlock.add(selected.item.Id);
          lastItemId = selected.item.Id;
          lastScheduledBucket = getRatingBucket(selected.item.OfficialRating);
          currentTime = endTime;
          scheduledSomething = true;
        }
      }

      // If nothing was scheduled, increment failed attempts
      if (!scheduledSomething || currentTime.getTime() === timeBeforeIteration) {
        failedAttempts++;
        // Last resort: try scheduling with fully relaxed constraints (any rating, allow cooldown)
        if (failedAttempts >= MAX_FAILED_ATTEMPTS / 2) {
          const allItemsForRelaxed = [...standaloneItems, ...items.filter(i => i.Type === 'Episode')];
          const relaxedCandidates = allItemsForRelaxed
            .map(i => ({
              item: i,
              duration: this.jellyfin.getItemDurationMs(i),
              conflicts: this.wouldConflict(tracker, i.Id, startMs, startMs + this.jellyfin.getItemDurationMs(i))
            }))
            .filter(x => x.duration > 0 && x.duration <= remainingMs && !x.conflicts)
            .sort((a, b) => b.duration - a.duration);
          const relaxed = relaxedCandidates.length > 0
            ? relaxedCandidates[Math.floor(rng() * Math.min(MOVIE_POOL_SIZE, relaxedCandidates.length))]
            : null;
          if (relaxed) {
            const endMs = startMs + relaxed.duration;
            const endTime = new Date(endMs);
            programs.push(this.createProgram(relaxed.item, currentTime, endTime));
            this.addToTracker(tracker, relaxed.item.Id, startMs, endMs);
            usedInBlock.add(relaxed.item.Id);
            lastItemId = relaxed.item.Id;
            lastScheduledBucket = getRatingBucket(relaxed.item.OfficialRating);
            currentTime = endTime;
            failedAttempts = 0;
          } else {
            // No content fits: if we're in the last 30 min of the block, fill the rest with one interstitial
            const remainingToEnd = blockEndMs - currentTime.getTime();
            if (remainingToEnd <= 30 * 60 * 1000) {
              programs.push(this.createInterstitial(currentTime, blockEnd, null));
              break;
            }
            const skipEnd = new Date(currentTime.getTime() + INTERSTITIAL_FALLBACK_MS);
            if (skipEnd.getTime() < blockEndMs) {
              programs.push(this.createInterstitial(currentTime, skipEnd, null));
              currentTime = skipEnd;
              lastScheduledBucket = null;
            } else {
              break;
            }
          }
        }
      } else {
        failedAttempts = 0;
      }
    }

    // Fill any remaining gap at the end - try to add more content
    if (currentTime.getTime() < blockEndMs) {
      const allItems = [...standaloneItems, ...items.filter(i => i.Type === 'Episode')];
      
      // Keep trying to fill gaps with content - allow reusing items if needed
      let gapFillAttempts = 0;
      while (currentTime.getTime() < blockEndMs && gapFillAttempts < 100) {
        gapFillAttempts++;
        const startMs = currentTime.getTime();
        const remainingGap = blockEndMs - startMs;
        
        // For very small gaps (< 5 min), just create a single interstitial and be done
        if (remainingGap < 5 * 60 * 1000) {
          programs.push(this.createInterstitial(currentTime, blockEnd, null));
          currentTime = blockEnd;
          break;
        }

        // Prefer same rating bucket, then all items; prefer no cooldown, then allow cooldown
        const gapPool = lastScheduledBucket === null
          ? allItems
          : allItems.filter(i => getRatingBucket(i.OfficialRating) === lastScheduledBucket);
        const itemsForGap = gapPool.length > 0 ? gapPool : allItems;
        const buildGapCandidates = (allowCooldown: boolean) =>
          itemsForGap
            .map(i => ({
              item: i,
              duration: this.jellyfin.getItemDurationMs(i),
              conflicts: this.wouldConflict(tracker, i.Id, startMs, startMs + this.jellyfin.getItemDurationMs(i)),
              usedInBlock: usedInBlock.has(i.Id),
              inCooldown: scheduledInCooldown.has(i.Id)
            }))
            .filter(x => x.duration > 0 && x.duration <= remainingGap && (allowCooldown || !x.inCooldown))
            .sort((a, b) => {
              if (a.conflicts !== b.conflicts) return a.conflicts ? 1 : -1;
              if (a.inCooldown !== b.inCooldown) return a.inCooldown ? 1 : -1;
              if (a.usedInBlock !== b.usedInBlock) return a.usedInBlock ? 1 : -1;
              return b.duration - a.duration;
            });
        let candidates = buildGapCandidates(false);
        if (candidates.length === 0) {
          candidates = buildGapCandidates(true);
        }
        // Last resort: try all items (any rating) with cooldown allowed
        if (candidates.length === 0 && itemsForGap.length < allItems.length) {
          candidates = allItems
            .map(i => ({
              item: i,
              duration: this.jellyfin.getItemDurationMs(i),
              conflicts: this.wouldConflict(tracker, i.Id, startMs, startMs + this.jellyfin.getItemDurationMs(i)),
              usedInBlock: usedInBlock.has(i.Id),
              inCooldown: scheduledInCooldown.has(i.Id)
            }))
            .filter(x => x.duration > 0 && x.duration <= remainingGap && !x.conflicts)
            .sort((a, b) => b.duration - a.duration);
        }

        if (candidates.length > 0) {
          const topN = Math.min(MOVIE_POOL_SIZE, candidates.length);
          const { item, duration, conflicts } = candidates[Math.floor(rng() * topN)];
          const endMs = startMs + duration;
          const endTime = new Date(endMs);
          programs.push(this.createProgram(item, currentTime, endTime));
          if (!conflicts) {
            this.addToTracker(tracker, item.Id, startMs, endMs);
          }
          usedInBlock.add(item.Id);
          lastScheduledBucket = getRatingBucket(item.OfficialRating);
          currentTime = endTime;
        } else {
          // No content fits: use ONE interstitial to fill the entire remaining gap
          // (avoids many small "Coming Up Next" blocks)
          programs.push(this.createInterstitial(currentTime, blockEnd, null));
          currentTime = blockEnd;
          lastScheduledBucket = null;
          break;
        }
      }
    }

    return queries.upsertScheduleBlock(
      this.db, channel.id,
      blockStart.toISOString(), blockEnd.toISOString(),
      programs, seed
    );
  }

  /**
   * Maintain schedules - generate upcoming blocks and clean old ones
   */
  async maintainSchedules(): Promise<void> {
    const now = new Date();
    const channels = queries.getAllChannels(this.db);

    // Generate next blocks if current block is within 1 hour of expiry
    const currentBlockStart = getBlockStart(now);
    const currentBlockEnd = getBlockEnd(currentBlockStart);
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    for (const channel of channels) {
      await this.ensureSchedule(channel, now);

      // If within 1 hour of block end, ensure next block
      if (oneHourFromNow.getTime() >= currentBlockEnd.getTime()) {
        const nextBlockStart = getNextBlockStart(currentBlockStart);
        const nextNextBlockStart = getNextBlockStart(nextBlockStart);
        const nextNextBlock = queries.getScheduleBlock(
          this.db, channel.id, nextNextBlockStart.toISOString()
        );
        if (!nextNextBlock) {
          this.generateBlock(channel, nextNextBlockStart);
        }
      }
    }

    // Clean blocks older than 24 hours
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    queries.cleanOldScheduleBlocks(this.db, cutoff.toISOString());
  }

  /**
   * Extend schedules for all channels to ensure content is available far into the future.
   * Generates enough blocks so each channel has at least 24 hours of schedule from now.
   * Designed to run periodically (e.g. every 4 hours) so returning users always have content.
   */
  async extendSchedules(): Promise<void> {
    const channels = queries.getAllChannels(this.db);
    if (channels.length === 0) return;

    const now = new Date();
    const currentBlockStart = getBlockStart(now);
    const blockHours = getBlockHours();

    // Number of blocks needed to cover at least 24 hours from current block start
    const blocksNeeded = Math.ceil(24 / blockHours) + 1;

    // Calculate the farthest block end for the global tracker
    let farEnd = new Date(currentBlockStart);
    for (let i = 0; i < blocksNeeded; i++) {
      farEnd = new Date(farEnd.getTime() + blockHours * 60 * 60 * 1000);
    }
    const tracker = this.buildGlobalTracker(currentBlockStart, farEnd);

    let blocksCreated = 0;
    for (const channel of channels) {
      let blockStart = new Date(currentBlockStart);
      for (let i = 0; i < blocksNeeded; i++) {
        const existing = queries.getScheduleBlock(
          this.db, channel.id, blockStart.toISOString()
        );
        if (!existing) {
          await this.generateBlock(channel, blockStart, tracker);
          blocksCreated++;
        }
        blockStart = getNextBlockStart(blockStart);
      }
      // Yield to event loop between channels
      await new Promise(resolve => setImmediate(resolve));
    }

    // Clean blocks older than 24 hours
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    queries.cleanOldScheduleBlocks(this.db, cutoff.toISOString());

    if (blocksCreated > 0) {
      console.log(`[ScheduleEngine] Extended schedules: created ${blocksCreated} new blocks for ${channels.length} channels`);
    }
  }

  /**
   * Get what's currently playing on a channel
   */
  getCurrentProgram(channelId: number): { program: ScheduleProgram; next: ScheduleProgram | null; seekMs: number } | null {
    const now = new Date();
    const blocks = queries.getCurrentAndNextBlocks(this.db, channelId, now.toISOString());

    // Gather all programs across blocks
    const allPrograms: ScheduleProgram[] = [];
    for (const block of blocks) {
      allPrograms.push(...block.programs);
    }

    // Find the currently airing program
    const nowMs = now.getTime();
    for (let i = 0; i < allPrograms.length; i++) {
      const prog = allPrograms[i];
      const startMs = new Date(prog.start_time).getTime();
      const endMs = new Date(prog.end_time).getTime();

      if (nowMs >= startMs && nowMs < endMs) {
        const seekMs = nowMs - startMs;
        const next = i + 1 < allPrograms.length ? allPrograms[i + 1] : null;
        return { program: prog, next, seekMs };
      }
    }

    return null;
  }

  /**
   * Regenerate schedule for a specific channel
   */
  regenerateForChannel(channelId: number): void {
    queries.deleteScheduleBlocksForChannel(this.db, channelId);
    const channel = queries.getChannelById(this.db, channelId);
    if (channel) {
      const now = new Date();
      this.ensureSchedule(channel, now);
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  private getChannelItems(channel: ChannelParsed): JellyfinItem[] {
    const items: JellyfinItem[] = [];
    for (const id of channel.item_ids) {
      const item = this.jellyfin.getItem(id);
      if (item) items.push(item);
    }
    return items;
  }

  private groupBySeries(items: JellyfinItem[]): Map<string, JellyfinItem[]> {
    const seriesMap = new Map<string, JellyfinItem[]>();
    for (const item of items) {
      if (item.Type === 'Episode' && item.SeriesId) {
        const existing = seriesMap.get(item.SeriesId) || [];
        existing.push(item);
        seriesMap.set(item.SeriesId, existing);
      }
    }
    // Sort episodes within each series by season and episode number
    for (const [, episodes] of seriesMap) {
      episodes.sort((a, b) => {
        const seasonDiff = (a.ParentIndexNumber || 0) - (b.ParentIndexNumber || 0);
        if (seasonDiff !== 0) return seasonDiff;
        return (a.IndexNumber || 0) - (b.IndexNumber || 0);
      });
    }
    return seriesMap;
  }

  private pickRandom<T>(preferred: T[], fallback: T[], rng: () => number): T {
    const pool = preferred.length > 0 ? preferred : fallback;
    return pool[Math.floor(rng() * pool.length)];
  }

  private createProgram(item: JellyfinItem, start: Date, end: Date): ScheduleProgram {
    const isEpisode = item.Type === 'Episode';
    const title = isEpisode
      ? (item.SeriesName || item.Name)
      : item.Name;

    // Only show subtitle for episodes (season/episode info), not for movies
    const subtitle = isEpisode
      ? `S${String(item.ParentIndexNumber || 1).padStart(2, '0')}E${String(item.IndexNumber || 1).padStart(2, '0')} - ${item.Name}`
      : null;

    return {
      jellyfin_item_id: item.Id,
      title,
      subtitle,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      duration_ms: end.getTime() - start.getTime(),
      type: 'program',
      content_type: isEpisode ? 'episode' : 'movie',
      thumbnail_url: `/api/images/${item.Id}/Primary`,
      banner_url: `/api/images/${item.Id}/Banner`,
      year: item.ProductionYear || null,
      rating: item.OfficialRating || null,
    };
  }

  private createInterstitial(start: Date, end: Date, nextItem: JellyfinItem | null): ScheduleProgram {
    return {
      jellyfin_item_id: '',
      title: nextItem ? `Next Up: ${nextItem.SeriesName || nextItem.Name}` : 'Coming Up Next',
      subtitle: null,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      duration_ms: end.getTime() - start.getTime(),
      type: 'interstitial',
      content_type: null,
      thumbnail_url: nextItem ? `/api/images/${nextItem.Id}/Primary` : null,
      banner_url: nextItem ? `/api/images/${nextItem.Id}/Banner` : null,
      year: null,
      rating: null,
    };
  }

  /**
   * Create interstitials for a gap, breaking into chunks of MAX_GAP_MS or less
   */
  private createInterstitialsForGap(
    start: Date,
    end: Date,
    nextItem: JellyfinItem | null
  ): ScheduleProgram[] {
    const interstitials: ScheduleProgram[] = [];
    let currentStart = new Date(start);
    const endMs = end.getTime();

    while (currentStart.getTime() < endMs) {
      const remainingMs = endMs - currentStart.getTime();
      const chunkMs = Math.min(remainingMs, MAX_GAP_MS);
      const chunkEnd = new Date(currentStart.getTime() + chunkMs);
      interstitials.push(this.createInterstitial(currentStart, chunkEnd, nextItem));
      currentStart = chunkEnd;
    }

    return interstitials;
  }
}
