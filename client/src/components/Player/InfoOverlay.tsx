import type { Channel, ScheduleProgram } from '../../types';
import './Player.css';

interface InfoOverlayProps {
  channel: Channel;
  program: ScheduleProgram;
  nextProgram: ScheduleProgram | null;
  progress: number;
}

export default function InfoOverlay({ channel, program, nextProgram, progress }: InfoOverlayProps) {
  const startTime = new Date(program.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endTime = new Date(program.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const remaining = Math.max(0, Math.ceil((new Date(program.end_time).getTime() - Date.now()) / 60000));

  return (
    <div className="info-overlay">
      <div className="info-overlay-content">
        <div className="info-channel">
          <span className="info-channel-num">CH {channel.number}</span>
          <span className="info-channel-name">{channel.name}</span>
        </div>

        <div className="info-program">
          <div className="info-title">{program.title}</div>
          {program.subtitle && (
            <div className="info-subtitle">{program.subtitle}</div>
          )}
          <div className="info-meta">
            {program.year && <span className="info-year">{program.year}</span>}
            {program.rating && <span className="info-rating">{program.rating}</span>}
          </div>
        </div>

        <div className="info-time">
          <span>{startTime} - {endTime}</span>
          <span className="info-remaining">{remaining} min remaining</span>
        </div>

        {nextProgram && (
          <div className="info-next">
            <span className="info-next-label">UP NEXT:</span>
            <span className="info-next-title">{nextProgram.title}</span>
            <span className="info-next-time">
              {new Date(nextProgram.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
