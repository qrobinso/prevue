import { useEffect, useState } from 'react';
import type { Channel, ScheduleProgram } from '../../types';
import { getProgramDetails } from '../../services/api';
import './Guide.css';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

interface ProgramInfoModalProps {
  channel: Channel;
  program: ScheduleProgram;
  onClose: () => void;
}

export default function ProgramInfoModal({ channel, program, onClose }: ProgramInfoModalProps) {
  const [details, setDetails] = useState<{ overview: string | null; genres?: string[] } | null>(null);

  useEffect(() => {
    if (program.jellyfin_item_id) {
      getProgramDetails(program.jellyfin_item_id).then(setDetails);
    } else {
      setDetails({ overview: null });
    }
  }, [program.jellyfin_item_id]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const start = formatTime(program.start_time);
  const end = formatTime(program.end_time);
  const duration = formatDuration(program.duration_ms);

  return (
    <div
      className="program-info-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="program-info-title"
    >
      <div className="program-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="program-info-header">
          <h2 id="program-info-title" className="program-info-title">{program.title}</h2>
          <button
            type="button"
            className="program-info-close"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="program-info-body">
          <div className="program-info-channel">
            <span className="program-info-channel-num">CH {channel.number}</span>
            <span className="program-info-channel-name">{channel.name}</span>
          </div>
          {program.subtitle && (
            <div className="program-info-subtitle">{program.subtitle}</div>
          )}
          <div className="program-info-meta-row">
            {program.year != null && (
              <span className="program-info-year">{program.year}</span>
            )}
            {program.rating && (
              <span className="program-info-rating">{program.rating}</span>
            )}
            {details?.genres && details.genres.length > 0 && (
              <span className="program-info-genres">{details.genres.join(' · ')}</span>
            )}
          </div>
          <div className="program-info-time-row">
            <span>{start} – {end}</span>
            <span className="program-info-duration">{duration}</span>
          </div>
          {details?.overview && (
            <div className="program-info-overview">{details.overview}</div>
          )}
        </div>
      </div>
    </div>
  );
}
