import { useState, useEffect } from 'react';
import type { ScheduleProgram } from '../../types';
import { getIconicScenesEnabled } from '../Settings/GeneralSettings';
import './Player.css';

interface IconicSceneOverlayProps {
  program: ScheduleProgram;
}

const TOLERANCE_MIN = 3;
const DISPLAY_DURATION_MS = 12000;

/** Find the iconic scene currently playing (within ±3 min tolerance). */
function findActiveScene(program: ScheduleProgram): { name: string; why: string } | null {
  if (program.content_type !== 'movie' || !program.iconic_scenes?.length) return null;
  const startMs = program.start_ms ?? new Date(program.start_time).getTime();
  const elapsedMin = (Date.now() - startMs) / 60000;
  for (const scene of program.iconic_scenes) {
    if (Math.abs(elapsedMin - scene.timestamp_minutes) <= TOLERANCE_MIN) {
      return scene;
    }
  }
  return null;
}

export default function IconicSceneOverlay({ program }: IconicSceneOverlayProps) {
  const [scene, setScene] = useState<{ name: string; why: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // On mount (tune-in), check if we're in an iconic scene window
  useEffect(() => {
    if (!getIconicScenesEnabled()) return;
    const active = findActiveScene(program);
    if (active) {
      setScene(active);
      setDismissed(false);
      const timer = setTimeout(() => setDismissed(true), DISPLAY_DURATION_MS);
      return () => clearTimeout(timer);
    }
  }, [program.media_item_id]);

  if (!scene || dismissed) return null;

  return (
    <div className="iconic-scene-overlay">
      <div className="iconic-scene-overlay-content">
        <span className="iconic-scene-label">ICONIC SCENE</span>
        <span className="iconic-scene-name">{scene.name}</span>
        <span className="iconic-scene-why">{scene.why}</span>
      </div>
    </div>
  );
}
