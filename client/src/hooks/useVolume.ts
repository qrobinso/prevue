import { useState, useCallback, useEffect, useRef } from 'react';

// Local storage keys for volume preferences
const VOLUME_KEY = 'prevue_volume';
const MUTED_KEY = 'prevue_muted';

function getStoredVolume(): number {
  const stored = localStorage.getItem(VOLUME_KEY);
  return stored ? parseFloat(stored) : 1;
}

function setStoredVolume(volume: number): void {
  localStorage.setItem(VOLUME_KEY, String(volume));
}

function getStoredMuted(): boolean {
  const stored = localStorage.getItem(MUTED_KEY);
  return stored === 'true';
}

function setStoredMuted(muted: boolean): void {
  localStorage.setItem(MUTED_KEY, String(muted));
}

// Custom event for volume sync across components
const VOLUME_CHANGE_EVENT = 'prevue_volume_change';

interface VolumeChangeDetail {
  volume: number;
  muted: boolean;
}

export function useVolume() {
  const [volume, setVolumeState] = useState(getStoredVolume);
  const [muted, setMutedState] = useState(getStoredMuted);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const volumeHideTimer = useRef<ReturnType<typeof setTimeout>>();

  // Sync volume state across components via custom event
  useEffect(() => {
    const handleVolumeChange = (e: CustomEvent<VolumeChangeDetail>) => {
      setVolumeState(e.detail.volume);
      setMutedState(e.detail.muted);
    };

    window.addEventListener(VOLUME_CHANGE_EVENT, handleVolumeChange as EventListener);
    return () => {
      window.removeEventListener(VOLUME_CHANGE_EVENT, handleVolumeChange as EventListener);
    };
  }, []);

  // Broadcast volume changes to other components
  const broadcastVolumeChange = useCallback((newVolume: number, newMuted: boolean) => {
    window.dispatchEvent(
      new CustomEvent<VolumeChangeDetail>(VOLUME_CHANGE_EVENT, {
        detail: { volume: newVolume, muted: newMuted },
      })
    );
  }, []);

  const setVolume = useCallback((newVolume: number) => {
    const clampedVolume = Math.max(0, Math.min(1, newVolume));
    setVolumeState(clampedVolume);
    setStoredVolume(clampedVolume);
    
    // Unmute if changing volume from 0
    let newMuted = muted;
    if (clampedVolume > 0 && muted) {
      newMuted = false;
      setMutedState(false);
      setStoredMuted(false);
    }
    
    broadcastVolumeChange(clampedVolume, newMuted);
  }, [muted, broadcastVolumeChange]);

  const toggleMute = useCallback(() => {
    const newMuted = !muted;
    setMutedState(newMuted);
    setStoredMuted(newMuted);
    broadcastVolumeChange(volume, newMuted);
  }, [muted, volume, broadcastVolumeChange]);

  const showVolumeControl = useCallback(() => {
    setShowVolumeSlider(true);
    if (volumeHideTimer.current) clearTimeout(volumeHideTimer.current);
    volumeHideTimer.current = setTimeout(() => setShowVolumeSlider(false), 3000);
  }, []);

  const hideVolumeControl = useCallback(() => {
    if (volumeHideTimer.current) clearTimeout(volumeHideTimer.current);
    volumeHideTimer.current = setTimeout(() => setShowVolumeSlider(false), 1000);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (volumeHideTimer.current) clearTimeout(volumeHideTimer.current);
    };
  }, []);

  return {
    volume,
    muted,
    showVolumeSlider,
    setVolume,
    toggleMute,
    showVolumeControl,
    hideVolumeControl,
    setShowVolumeSlider,
  };
}

// Hook to apply volume to a video element
export function useVideoVolume(
  videoRef: React.RefObject<HTMLVideoElement>,
  volume: number,
  muted: boolean
) {
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      video.muted = muted;
    }
  }, [videoRef, volume, muted]);
}
