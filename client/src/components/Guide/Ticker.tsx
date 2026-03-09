import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTicker } from '../../hooks/useTicker';
import { getTickerSpeed } from '../Settings/DisplaySettings';
import type { TickerSpeedPreset } from '../Settings/DisplaySettings';
import type { ScheduleProgram } from '../../types';
import './Ticker.css';

interface TickerProps {
  enabled: boolean;
  scheduleByChannel?: Map<number, ScheduleProgram[]>;
  onChannelSelect?: (channelNumber: number) => void;
}

const SEPARATOR = '  \u2666  '; // ◆ diamond
const CHARS_PER_SECOND = 7.5; // base rate at "standard" speed
const MIN_DURATION = 60;
const MAX_DURATION = 960;

export default function Ticker({ enabled, scheduleByChannel, onChannelSelect }: TickerProps) {
  const { items } = useTicker(enabled, scheduleByChannel);
  const [speed, setSpeed] = useState<TickerSpeedPreset>(getTickerSpeed);

  // Listen for speed changes from settings
  useEffect(() => {
    const handler = () => setSpeed(getTickerSpeed());
    window.addEventListener('tickerspeedchange', handler);
    return () => window.removeEventListener('tickerspeedchange', handler);
  }, []);

  const handleItemClick = useCallback((channelNumber: number) => {
    onChannelSelect?.(channelNumber);
  }, [onChannelSelect]);

  const { elements, duration } = useMemo(() => {
    if (items.length === 0) return { elements: null, duration: MIN_DURATION };
    const fullText = items.map(i => i.text).join(SEPARATOR);
    const len = fullText.length;
    const baseDur = Math.round(len / CHARS_PER_SECOND);
    const dur = Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(baseDur * speed.multiplier)));

    const nodes = items.map((item, idx) => {
      const isClickable = !!item.channel_number;
      const separator = idx < items.length - 1 ? SEPARATOR : '';
      if (isClickable) {
        return (
          <span key={item.id}>
            <span
              className="ticker-item ticker-item--clickable"
              onClick={() => handleItemClick(item.channel_number!)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleItemClick(item.channel_number!); }}
            >
              {item.text}
            </span>
            {separator}
          </span>
        );
      }
      return <span key={item.id}>{item.text}{separator}</span>;
    });

    return { elements: nodes, duration: dur };
  }, [items, speed, handleItemClick]);

  if (!enabled || !elements) return null;

  return (
    <div className="ticker-bar">
      <div
        className="ticker-track"
        style={{ '--ticker-duration': `${duration}s` } as React.CSSProperties}
      >
        <span className="ticker-text">{elements}</span>
        <span className="ticker-text" aria-hidden="true">{elements}</span>
      </div>
    </div>
  );
}
