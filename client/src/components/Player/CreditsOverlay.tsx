import { useState, useEffect } from 'react';
import type { ScheduleProgram } from '../../types';
import { sanitizeImageUrl } from '../../utils/sanitize';
import './Player.css';

interface CreditsOverlayProps {
  nextProgram: ScheduleProgram;
  currentProgram: ScheduleProgram | null;
}

export default function CreditsOverlay({ nextProgram, currentProgram }: CreditsOverlayProps) {
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    const tick = () => {
      if (!currentProgram) return;
      const endMs = new Date(currentProgram.end_time).getTime();
      const remaining = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      setCountdown(m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [currentProgram]);

  const startTime = new Date(nextProgram.start_time).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const backdropUrl = nextProgram.backdrop_url || nextProgram.thumbnail_url || nextProgram.banner_url;
  const hdBackdrop = backdropUrl
    ? backdropUrl + (backdropUrl.includes('?') ? '&' : '?') + 'maxWidth=1280'
    : null;

  return (
    <div className="credits-overlay">
      <div className="credits-overlay-content">
        <div className="credits-info">
          <span className="credits-label">UP NEXT</span>
          <span className="credits-title">{nextProgram.title}</span>
          {nextProgram.subtitle && (
            <span className="credits-subtitle">{nextProgram.subtitle}</span>
          )}
          <div className="credits-meta">
            <span className="credits-time">{startTime}</span>
            {countdown && (
              <span className="credits-countdown">Starts in {countdown}</span>
            )}
          </div>
        </div>
        {hdBackdrop && (
          <div
            className="credits-backdrop"
            style={{ backgroundImage: `url("${sanitizeImageUrl(hdBackdrop) || ''}")` }}
          />
        )}
      </div>
    </div>
  );
}
