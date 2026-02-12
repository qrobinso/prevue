import { useState, useEffect, useCallback, useRef } from 'react';
import { getChannels, getSchedule, type ChannelWithProgram } from '../services/api';
import type { Channel, ScheduleProgram, ScheduleBlock } from '../types';

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

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [channelsData, scheduleData] = await Promise.all([
        getChannels(),
        getSchedule(),
      ]);

      setChannels(channelsData);

      const schedMap = new Map<number, ScheduleProgram[]>();
      for (const [channelId, data] of Object.entries(scheduleData)) {
        const programs: ScheduleProgram[] = [];
        for (const block of (data as { blocks: ScheduleBlock[] }).blocks) {
          programs.push(...block.programs);
        }
        // Sort by start time
        programs.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
        schedMap.set(parseInt(channelId, 10), programs);
      }
      setScheduleByChannel(schedMap);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    // Refresh every 60 seconds
    refreshTimer.current = setInterval(loadData, 60000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [loadData]);

  return { channels, scheduleByChannel, loading, error, refresh: loadData };
}
