import { useState, useEffect, useRef, useCallback } from 'react';
import type { ScheduleProgram } from '../../types';
import { getIconicScenesEnabled } from '../Settings/GeneralSettings';
import { useBottomNotifications, type NotificationData } from './BottomNotificationManager';

interface IconicSceneOverlayProps {
  program: ScheduleProgram;
  /** When true the notification is suppressed (e.g. metadata overlay is visible). */
  hidden?: boolean;
}

const EARLY_START_MIN = 1; // Show notification 1 minute before the scene starts
const POLL_INTERVAL_MS = 15000;
const UPDATE_INTERVAL_MS = 3000; // Fast updates while scene is active (for countdown)
const NOTIFICATION_ID = 'iconic-scene';
const NOTIFICATION_PRIORITY = 20; // Higher than starting-soon (10)

/** Format seconds into M:SS or just Xs for small values. */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0s';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

type IconicSceneData = { name: string; why: string; timestamp_minutes: number; end_minutes: number };

/** Find the iconic scene currently playing (starts 1 min early, ends on time). */
function findActiveScene(program: ScheduleProgram): IconicSceneData | null {
  if (program.content_type !== 'movie' || !program.iconic_scenes?.length) return null;
  const startMs = program.start_ms ?? new Date(program.start_time).getTime();
  const elapsedMin = (Date.now() - startMs) / 60000;
  for (const scene of program.iconic_scenes) {
    const effectiveStart = scene.timestamp_minutes - EARLY_START_MIN;
    const effectiveEnd = scene.end_minutes ?? scene.timestamp_minutes + 3; // fallback for legacy data
    if (elapsedMin >= effectiveStart && elapsedMin <= effectiveEnd) {
      return scene;
    }
  }
  return null;
}

/** Build phase-aware notification data for an active iconic scene. */
function buildNotificationData(scene: IconicSceneData, program: ScheduleProgram): NotificationData {
  const startMs = program.start_ms ?? new Date(program.start_time).getTime();
  const elapsedMin = (Date.now() - startMs) / 60000;
  const isApproaching = elapsedMin < scene.timestamp_minutes;

  if (isApproaching) {
    const secondsUntil = (scene.timestamp_minutes - elapsedMin) * 60;
    return {
      label: 'ICONIC SCENE \u2014 COMING UP',
      labelColor: '#e040fb',
      title: scene.name,
      subtitle: `Starting in ~${formatCountdown(secondsUntil)} \u2014 ${scene.why}`,
      className: 'bottom-notification--iconic',
    };
  }

  return {
    label: 'ICONIC SCENE \u2014 NOW',
    labelColor: '#e040fb',
    title: scene.name,
    subtitle: scene.why,
    className: 'bottom-notification--iconic',
  };
}

export default function IconicSceneOverlay({ program, hidden }: IconicSceneOverlayProps) {
  const [scene, setScene] = useState<IconicSceneData | null>(null);
  const lastSceneName = useRef<string | null>(null);
  const { show, hide } = useBottomNotifications();

  // Poll for active iconic scenes
  useEffect(() => {
    if (!getIconicScenesEnabled()) return;

    function check() {
      const active = findActiveScene(program);
      if (active) {
        lastSceneName.current = active.name;
        setScene(active);
      } else {
        lastSceneName.current = null;
        setScene(null);
      }
    }

    check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [program.media_item_id]);

  // Register / unregister with the notification manager
  useEffect(() => {
    if (scene && !hidden) {
      show(NOTIFICATION_ID, NOTIFICATION_PRIORITY, buildNotificationData(scene, program));
    } else {
      hide(NOTIFICATION_ID);
    }
  }, [scene, hidden, show, hide]);

  // Fast update interval: re-push notification data every 3s for live countdown
  useEffect(() => {
    if (!scene || hidden) return;

    const id = setInterval(() => {
      show(NOTIFICATION_ID, NOTIFICATION_PRIORITY, buildNotificationData(scene, program));
    }, UPDATE_INTERVAL_MS);

    return () => clearInterval(id);
  }, [scene, hidden, program, show]);

  // Cleanup on unmount
  useEffect(() => {
    return () => hide(NOTIFICATION_ID);
  }, [hide]);

  return null; // Rendering handled by BottomNotificationProvider
}
