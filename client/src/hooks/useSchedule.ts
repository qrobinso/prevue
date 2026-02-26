import { useState, useEffect, useCallback, useRef } from 'react';
import { getSchedule, type ChannelWithProgram } from '../services/api';
import type { ScheduleProgram, ScheduleBlock, WSEvent } from '../types';
import { useWebSocket } from './useWebSocket';

/** Minimum gap between schedule reloads (ms). */
const RELOAD_DEBOUNCE_MS = 2000;

interface ScheduleData {
  channels: ChannelWithProgram[];
  scheduleByChannel: Map<number, ScheduleProgram[]>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSchedule(): ScheduleData {
  const [channels, setChannels] = useState<ChannelWithProgram[]>([]);
  const [scheduleByChannel, setScheduleByChannel] = useState<Map<number, ScheduleProgram[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval>>();

  const hasLoadedOnce = useRef(false);
  const loadingRef = useRef(false);
  const debouncedTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastLoadTime = useRef(0);

  const loadData = useCallback(async () => {
    // Prevent overlapping requests
    if (loadingRef.current) return;
    loadingRef.current = true;
    lastLoadTime.current = Date.now();

    // Only show loading spinner on the initial load; background refreshes are silent
    // so that PreviewPanel (and its HLS stream) is never unmounted mid-playback.
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }
    setError(null);
    try {
      const scheduleData = await getSchedule();

      const schedMap = new Map<number, ScheduleProgram[]>();
      const nextChannels: ChannelWithProgram[] = [];
      const nowMs = Date.now();
      for (const [channelId, data] of Object.entries(scheduleData)) {
        const channelIdNum = parseInt(channelId, 10);
        const programs: ScheduleProgram[] = [];
        for (const block of (data as { blocks: ScheduleBlock[] }).blocks) {
          programs.push(...block.programs);
        }
        // Pre-compute numeric timestamps once so renderers never parse Date strings
        for (const prog of programs) {
          prog.start_ms = new Date(prog.start_time).getTime();
          prog.end_ms = new Date(prog.end_time).getTime();
        }
        // Sort by pre-computed timestamp
        programs.sort((a, b) => a.start_ms! - b.start_ms!);
        schedMap.set(channelIdNum, programs);

        const currentIdx = programs.findIndex((prog) => {
          return nowMs >= prog.start_ms! && nowMs < prog.end_ms!;
        });

        const currentProgram = currentIdx >= 0 ? programs[currentIdx] : null;
        const nextProgram = currentIdx >= 0 ? (programs[currentIdx + 1] ?? null) : null;
        const channel = (data as { channel: Omit<ChannelWithProgram, 'current_program' | 'next_program' | 'schedule_generated_at' | 'schedule_updated_at'> }).channel;
        nextChannels.push({
          ...channel,
          current_program: currentProgram,
          next_program: nextProgram,
          schedule_generated_at: null,
          schedule_updated_at: null,
        });
      }

      nextChannels.sort((a, b) => (a.sort_order - b.sort_order) || (a.number - b.number));
      setChannels(nextChannels);
      setScheduleByChannel(schedMap);
      setError(null);
      hasLoadedOnce.current = true;
    } catch (err) {
      // Only set error if we haven't loaded successfully before (don't break the UI on a transient refresh failure)
      if (!hasLoadedOnce.current) {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  /** Debounced reload — collapses rapid WS events into a single fetch. */
  const debouncedLoad = useCallback(() => {
    if (debouncedTimer.current) clearTimeout(debouncedTimer.current);
    const elapsed = Date.now() - lastLoadTime.current;
    const delay = Math.max(0, RELOAD_DEBOUNCE_MS - elapsed);
    debouncedTimer.current = setTimeout(loadData, delay);
  }, [loadData]);

  // Reload guide when schedules are regenerated via WebSocket
  const handleWsEvent = useCallback((event: WSEvent) => {
    if (
      event.type === 'channels:regenerated' ||
      event.type === 'channel:added' ||
      event.type === 'channel:removed' ||
      event.type === 'schedule:updated'
    ) {
      debouncedLoad();
    }
  }, [debouncedLoad]);

  useWebSocket(handleWsEvent);

  useEffect(() => {
    loadData();

    // Refresh every 60 seconds
    refreshTimer.current = setInterval(loadData, 60000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
      if (debouncedTimer.current) clearTimeout(debouncedTimer.current);
    };
  }, [loadData]);

  return { channels, scheduleByChannel, loading, error, refresh: loadData };
}
