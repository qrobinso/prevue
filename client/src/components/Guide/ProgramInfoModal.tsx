import { useEffect, useState } from 'react';
import type { Channel, ScheduleProgram } from '../../types';
import { getProgramDetails } from '../../services/api';
import type { ProgramDetails } from '../../services/api';
import { X } from '@phosphor-icons/react';
import './Guide.css';

function formatRTRating(rating: number): string {
  return `${Math.round(rating * 10)}%`;
}

function isRottenTomatoes(imageKey?: string): boolean {
  return !!imageKey?.includes('rottentomatoes');
}

function isFresh(ratingImage?: string): boolean {
  return !!ratingImage && (ratingImage.includes('.ripe') || ratingImage.includes('.certified_fresh'));
}

function isUpright(audienceRatingImage?: string): boolean {
  return !!audienceRatingImage?.includes('.upright');
}

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

function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = Math.round(m % 60);
  return h > 0 ? `${h}:${min.toString().padStart(2, '0')}` : `${min}m`;
}

interface ProgramInfoModalProps {
  channel: Channel;
  program: ScheduleProgram;
  onClose: () => void;
}

export default function ProgramInfoModal({ channel, program, onClose }: ProgramInfoModalProps) {
  const [details, setDetails] = useState<ProgramDetails | null>(null);

  useEffect(() => {
    if (program.media_item_id) {
      getProgramDetails(program.media_item_id).then(setDetails);
    } else {
      setDetails({ overview: null });
    }
  }, [program.media_item_id]);

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
            <X size={18} weight="bold" />
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
            {details?.communityRating != null && isRottenTomatoes(details.ratingImage) && (
              <span className="program-info-rt-critic" title={isFresh(details.ratingImage) ? 'Fresh' : 'Rotten'}>
                {isFresh(details.ratingImage) ? '🍅' : '🪣'} {formatRTRating(details.communityRating)}
              </span>
            )}
            {details?.audienceRating != null && isRottenTomatoes(details.audienceRatingImage) && (
              <span className="program-info-rt-audience" title={isUpright(details.audienceRatingImage) ? 'Liked it' : 'Disliked it'}>
                🍿 {formatRTRating(details.audienceRating)}
              </span>
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
          {program.iconic_scenes && program.iconic_scenes.length > 0 && (
            <div className="program-info-iconic">
              <h4 className="program-info-iconic-title">ICONIC SCENES</h4>
              <ul className="program-info-iconic-list">
                {program.iconic_scenes.map((scene, i) => (
                  <li key={i} className="program-info-iconic-item">
                    <span className="program-info-iconic-time">
                      {formatMinutes(scene.timestamp_minutes)}–{formatMinutes(scene.end_minutes)}
                    </span>
                    <span className="program-info-iconic-name">{scene.name}</span>
                    <span className="program-info-iconic-why">{scene.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
