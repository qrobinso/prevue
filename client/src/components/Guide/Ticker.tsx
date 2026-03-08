import { useMemo, useState, useEffect } from 'react';
import { useTicker } from '../../hooks/useTicker';
import { getTickerSpeed } from '../Settings/DisplaySettings';
import type { TickerSpeedPreset } from '../Settings/DisplaySettings';
import type { ScheduleProgram } from '../../types';
import './Ticker.css';

interface TickerProps {
  enabled: boolean;
  scheduleByChannel?: Map<number, ScheduleProgram[]>;
}

const SEPARATOR = '  \u2666  '; // ◆ diamond
const CHARS_PER_SECOND = 7.5; // base rate at "standard" speed
const MIN_DURATION = 60;
const MAX_DURATION = 960;

export default function Ticker({ enabled, scheduleByChannel }: TickerProps) {
  const { items } = useTicker(enabled, scheduleByChannel);
  const [speed, setSpeed] = useState<TickerSpeedPreset>(getTickerSpeed);

  // Listen for speed changes from settings
  useEffect(() => {
    const handler = () => setSpeed(getTickerSpeed());
    window.addEventListener('tickerspeedchange', handler);
    return () => window.removeEventListener('tickerspeedchange', handler);
  }, []);

  const { fullText, duration } = useMemo(() => {
    if (items.length === 0) return { fullText: '', duration: MIN_DURATION };
    const text = items.map(i => i.text).join(SEPARATOR);
    const len = text.length;
    const baseDur = Math.round(len / CHARS_PER_SECOND);
    const dur = Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(baseDur * speed.multiplier)));
    return { fullText: text, duration: dur };
  }, [items, speed]);

  if (!enabled || items.length === 0) return null;

  return (
    <div className="ticker-bar">
      <div
        className="ticker-track"
        style={{ '--ticker-duration': `${duration}s` } as React.CSSProperties}
      >
        <span className="ticker-text">{fullText}</span>
        <span className="ticker-text" aria-hidden="true">{fullText}</span>
      </div>
    </div>
  );
}
