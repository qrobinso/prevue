import { useState, useEffect, useRef, useCallback } from 'react';
import { getTickerItems, getBatchProgramFacts, getHiddenGems } from '../services/api';
import type { TickerItem, BatchFactsProgram } from '../services/api';
import type { ScheduleProgram } from '../types';
import { getGuideYear, getGuideRatings, getGuideResolution, getGuideHdr } from '../components/Settings/DisplaySettings';
import { getProgramFactsEnabled, getHiddenGemsEnabled } from '../components/Settings/GeneralSettings';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FACTS_DELAY_MS = 10 * 1000; // wait 10s after schedule loads before requesting facts

export function useTicker(
  enabled: boolean,
  scheduleByChannel?: Map<number, ScheduleProgram[]>,
): { items: TickerItem[]; loading: boolean } {
  const [baseItems, setBaseItems] = useState<TickerItem[]>([]);
  const [activeFact, setActiveFact] = useState<TickerItem | null>(null);
  const [activeGem, setActiveGem] = useState<TickerItem | null>(null);
  const [loading, setLoading] = useState(false);
  const prevJson = useRef('');
  const factsCacheKey = useRef<string | null>(null);
  const factsPool = useRef<string[]>([]);
  const factsIndex = useRef(0);
  const gemsPool = useRef<string[]>([]);
  const gemsIndex = useRef(0);

  // Pick the next fact from the pool (round-robin so each fact gets shown)
  const rotateFact = useCallback(() => {
    const pool = factsPool.current;
    if (pool.length === 0) {
      setActiveFact(null);
      return;
    }
    const idx = factsIndex.current % pool.length;
    factsIndex.current = idx + 1;
    setActiveFact({
      id: `fact-${Date.now()}`,
      text: `DID YOU KNOW: ${pool[idx]}`,
      category: 'fact' as const,
    });
  }, []);

  // Pick the next gem from the pool (round-robin)
  const rotateGem = useCallback(() => {
    const pool = gemsPool.current;
    if (pool.length === 0) {
      setActiveGem(null);
      return;
    }
    const idx = gemsIndex.current % pool.length;
    gemsIndex.current = idx + 1;
    setActiveGem({
      id: `gem-${Date.now()}`,
      text: `HIDDEN GEM: ${pool[idx]}`,
      category: 'gem' as const,
    });
  }, []);

  // Fetch hidden gems for ticker display
  useEffect(() => {
    if (!enabled || !getHiddenGemsEnabled()) {
      setActiveGem(null);
      return;
    }

    let cancelled = false;

    const fetchGems = async () => {
      try {
        const data = await getHiddenGems();
        if (cancelled || !data.gems || data.gems.length === 0) return;

        // Build pool: "Title — reason"
        const pool = data.gems.map(g => `${g.title} \u2014 ${g.reason}`);
        // Shuffle
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        gemsPool.current = pool;
        gemsIndex.current = 0;
        rotateGem();
      } catch {
        // AI call failed — just skip gems
      }
    };

    const timer = setTimeout(fetchGems, FACTS_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, rotateGem]);

  // Fetch base ticker items (primetime, new, stats) + rotate fact/gem each cycle
  useEffect(() => {
    if (!enabled) {
      setBaseItems([]);
      prevJson.current = '';
      return;
    }

    let cancelled = false;

    const fetchTicker = async () => {
      try {
        setLoading(true);
        const badges = {
          year: getGuideYear(),
          rating: getGuideRatings(),
          resolution: getGuideResolution(),
          hdr: getGuideHdr(),
        };
        const data = await getTickerItems(undefined, badges);
        if (cancelled) return;

        const json = JSON.stringify(data.items);
        if (json !== prevJson.current) {
          prevJson.current = json;
          setBaseItems(data.items);
        }
      } catch {
        // Silently fail — ticker is non-critical
      } finally {
        if (!cancelled) setLoading(false);
      }
      // Rotate to a new fact and gem each refresh cycle
      if (!cancelled) {
        rotateFact();
        rotateGem();
      }
    };

    fetchTicker();
    const interval = setInterval(fetchTicker, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, rotateFact, rotateGem]);

  // Batch-fetch program facts for all currently airing programs
  useEffect(() => {
    if (!enabled || !getProgramFactsEnabled() || !scheduleByChannel || scheduleByChannel.size === 0) {
      return;
    }

    // Build deduplicated list of currently airing programs
    const now = Date.now();
    const programs: BatchFactsProgram[] = [];
    const seenMovies = new Set<string>();
    const seenSeries = new Set<string>();

    for (const [, schedule] of scheduleByChannel) {
      for (const prog of schedule) {
        if (prog.type !== 'program') continue;
        const startMs = prog.start_ms ?? new Date(prog.start_time).getTime();
        const endMs = prog.end_ms ?? new Date(prog.end_time).getTime();
        if (now < startMs || now >= endMs) continue;

        if (prog.content_type === 'episode') {
          const seriesName = prog.title;
          if (!seriesName || seenSeries.has(seriesName)) continue;
          seenSeries.add(seriesName);
          programs.push({
            media_item_id: prog.media_item_id,
            title: seriesName,
            content_type: 'episode',
            series_name: seriesName,
          });
        } else {
          if (seenMovies.has(prog.media_item_id)) continue;
          seenMovies.add(prog.media_item_id);
          programs.push({
            media_item_id: prog.media_item_id,
            title: prog.title,
            year: prog.year,
            content_type: prog.content_type,
          });
        }
      }
    }

    if (programs.length === 0) return;

    const cacheKey = programs.map(p => p.media_item_id).sort().join(',');
    if (factsCacheKey.current === cacheKey) return;

    let cancelled = false;

    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const data = await getBatchProgramFacts(programs);
        if (cancelled) return;

        factsCacheKey.current = cacheKey;

        // Build shuffled pool of all facts
        const allFacts: string[] = [];
        for (const [, facts] of Object.entries(data.facts)) {
          allFacts.push(...facts);
        }
        // Shuffle the pool
        for (let i = allFacts.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [allFacts[i], allFacts[j]] = [allFacts[j], allFacts[i]];
        }
        factsPool.current = allFacts;
        factsIndex.current = 0;
        rotateFact();
      } catch {
        // AI call failed — just keep showing regular ticker
      }
    }, FACTS_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, scheduleByChannel, rotateFact]);

  // Merge: gem and fact placed before base items
  const items = [
    ...(activeGem ? [activeGem] : []),
    ...(activeFact ? [activeFact] : []),
    ...baseItems,
  ];

  return { items, loading };
}
