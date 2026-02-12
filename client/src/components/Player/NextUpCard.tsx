import { useState, useEffect } from 'react';
import type { ScheduleProgram } from '../../types';
import './Player.css';

interface NextUpCardProps {
  program: ScheduleProgram;
  nextProgram: ScheduleProgram | null;
}

export default function NextUpCard({ program, nextProgram }: NextUpCardProps) {
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = new Date(program.end_time).getTime() - Date.now();
      if (remaining <= 0) {
        setCountdown('NOW');
        return;
      }
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      setCountdown(`${minutes}:${String(seconds).padStart(2, '0')}`);
    }, 1000);

    return () => clearInterval(timer);
  }, [program.end_time]);

  const displayProgram = nextProgram || program;

  return (
    <div className="next-up-card">
      <div className="next-up-background">
        {displayProgram.thumbnail_url && (
          <img
            src={displayProgram.thumbnail_url}
            alt=""
            className="next-up-bg-image"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
      </div>
      <div className="next-up-content">
        <div className="next-up-label">COMING UP NEXT</div>
        <div className="next-up-title">{displayProgram.title}</div>
        {displayProgram.subtitle && (
          <div className="next-up-subtitle">{displayProgram.subtitle}</div>
        )}
        <div className="next-up-countdown">{countdown}</div>
      </div>
    </div>
  );
}
