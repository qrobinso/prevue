import { useState, useCallback, useEffect, useRef } from 'react';
import Hls from 'hls.js';

// Local storage key for preferred audio language
const AUDIO_LANGUAGE_KEY = 'prevue_audio_language';

export interface AudioTrack {
  id: number;
  name: string;
  lang: string;
  default: boolean;
}

function getStoredAudioLanguage(): string | null {
  return localStorage.getItem(AUDIO_LANGUAGE_KEY);
}

function setStoredAudioLanguage(lang: string): void {
  localStorage.setItem(AUDIO_LANGUAGE_KEY, lang);
}

// Custom event for audio track sync across components
const AUDIO_TRACK_CHANGE_EVENT = 'prevue_audio_track_change';

interface AudioTrackChangeDetail {
  language: string;
}

export function useAudioTrack(hlsRef: React.RefObject<Hls | null>) {
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [currentTrackId, setCurrentTrackId] = useState<number>(-1);
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [hlsInstance, setHlsInstance] = useState<Hls | null>(null);
  const audioMenuHideTimer = useRef<ReturnType<typeof setTimeout>>();
  const hasAppliedPreference = useRef(false);

  // Parse audio tracks from HLS instance. When HLS reports no alternate tracks
  // (audio in main stream), expose a single "Default" track so the UI can show the section.
  const updateAudioTracks = useCallback((hls: Hls | null) => {
    if (!hls) {
      setAudioTracks([]);
      setCurrentTrackId(-1);
      return;
    }

    const rawTracks = hls.audioTracks.map((track, index) => ({
      id: index,
      name: track.name || `Track ${index + 1}`,
      lang: track.lang || 'und',
      default: track.default || false,
    }));

    const tracks =
      rawTracks.length > 0
        ? rawTracks
        : [{ id: 0, name: 'Default', lang: 'und', default: true }];

    setAudioTracks(tracks);
    const selectedId = rawTracks.length === 0 ? 0 : hls.audioTrack;
    setCurrentTrackId(selectedId >= 0 && selectedId < tracks.length ? selectedId : 0);

    // Apply stored language preference on first load (only when we have real multiple tracks)
    if (!hasAppliedPreference.current && rawTracks.length > 1) {
      const preferredLang = getStoredAudioLanguage();
      if (preferredLang) {
        const matchingTrack = rawTracks.find(t => t.lang === preferredLang);
        if (matchingTrack && matchingTrack.id !== hls.audioTrack) {
          hls.audioTrack = matchingTrack.id;
          setCurrentTrackId(matchingTrack.id);
        }
      }
      hasAppliedPreference.current = true;
    }
  }, []);

  // Poll for HLS instance changes (since refs don't trigger re-renders)
  useEffect(() => {
    const checkHls = () => {
      const currentHls = hlsRef.current;
      if (currentHls !== hlsInstance) {
        setHlsInstance(currentHls);
        hasAppliedPreference.current = false;
      }
    };

    // Check immediately and periodically
    checkHls();
    const interval = setInterval(checkHls, 500);
    return () => clearInterval(interval);
  }, [hlsRef, hlsInstance]);

  // Listen for HLS audio track events
  useEffect(() => {
    if (!hlsInstance) {
      setAudioTracks([]);
      setCurrentTrackId(-1);
      return;
    }

    const onManifestParsed = () => updateAudioTracks(hlsInstance);
    const onAudioTracksUpdated = () => updateAudioTracks(hlsInstance);
    const onAudioTrackSwitched = () => setCurrentTrackId(hlsInstance.audioTrack);

    // Use correct HLS.js event names
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
    hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, onAudioTracksUpdated);
    hlsInstance.on(Hls.Events.AUDIO_TRACK_SWITCHED, onAudioTrackSwitched);

    // Initial update (in case manifest already parsed)
    updateAudioTracks(hlsInstance);

    return () => {
      hlsInstance.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
      hlsInstance.off(Hls.Events.AUDIO_TRACKS_UPDATED, onAudioTracksUpdated);
      hlsInstance.off(Hls.Events.AUDIO_TRACK_SWITCHED, onAudioTrackSwitched);
    };
  }, [hlsInstance, updateAudioTracks]);

  // Sync audio language preference across components
  useEffect(() => {
    const handleAudioTrackChange = (e: CustomEvent<AudioTrackChangeDetail>) => {
      if (!hlsInstance || audioTracks.length === 0) return;

      const matchingTrack = audioTracks.find(t => t.lang === e.detail.language);
      if (matchingTrack && matchingTrack.id !== currentTrackId) {
        hlsInstance.audioTrack = matchingTrack.id;
        setCurrentTrackId(matchingTrack.id);
      }
    };

    window.addEventListener(AUDIO_TRACK_CHANGE_EVENT, handleAudioTrackChange as EventListener);
    return () => {
      window.removeEventListener(AUDIO_TRACK_CHANGE_EVENT, handleAudioTrackChange as EventListener);
    };
  }, [hlsInstance, audioTracks, currentTrackId]);

  // Change audio track (no-op when only the synthetic "Default" track exists)
  const setAudioTrack = useCallback((trackId: number) => {
    if (!hlsInstance) return;

    const track = audioTracks.find(t => t.id === trackId);
    if (!track) return;

    const isSyntheticOnly =
      audioTracks.length === 1 && audioTracks[0].name === 'Default';
    if (!isSyntheticOnly) {
      hlsInstance.audioTrack = trackId;
      setStoredAudioLanguage(track.lang);
      window.dispatchEvent(
        new CustomEvent<AudioTrackChangeDetail>(AUDIO_TRACK_CHANGE_EVENT, {
          detail: { language: track.lang },
        })
      );
    }
    setCurrentTrackId(trackId);
  }, [hlsInstance, audioTracks]);

  const showAudioControl = useCallback(() => {
    setShowAudioMenu(true);
    if (audioMenuHideTimer.current) clearTimeout(audioMenuHideTimer.current);
    audioMenuHideTimer.current = setTimeout(() => setShowAudioMenu(false), 5000);
  }, []);

  const hideAudioControl = useCallback(() => {
    if (audioMenuHideTimer.current) clearTimeout(audioMenuHideTimer.current);
    audioMenuHideTimer.current = setTimeout(() => setShowAudioMenu(false), 1000);
  }, []);

  const toggleAudioMenu = useCallback(() => {
    setShowAudioMenu(prev => !prev);
    if (audioMenuHideTimer.current) clearTimeout(audioMenuHideTimer.current);
    if (!showAudioMenu) {
      audioMenuHideTimer.current = setTimeout(() => setShowAudioMenu(false), 5000);
    }
  }, [showAudioMenu]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (audioMenuHideTimer.current) clearTimeout(audioMenuHideTimer.current);
    };
  }, []);

  const currentTrack = audioTracks.find(t => t.id === currentTrackId) || null;

  return {
    audioTracks,
    currentTrack,
    currentTrackId,
    setAudioTrack,
    showAudioMenu,
    setShowAudioMenu,
    showAudioControl,
    hideAudioControl,
    toggleAudioMenu,
    hasMultipleTracks: audioTracks.length > 1,
    hasAudioTracks: audioTracks.length >= 1,
  };
}

// Helper to format language code to display name
export function formatAudioTrackName(track: AudioTrack): string {
  // Common language codes to names
  const langNames: Record<string, string> = {
    eng: 'English',
    en: 'English',
    spa: 'Spanish',
    es: 'Spanish',
    fra: 'French',
    fr: 'French',
    deu: 'German',
    de: 'German',
    ita: 'Italian',
    it: 'Italian',
    por: 'Portuguese',
    pt: 'Portuguese',
    jpn: 'Japanese',
    ja: 'Japanese',
    kor: 'Korean',
    ko: 'Korean',
    zho: 'Chinese',
    zh: 'Chinese',
    rus: 'Russian',
    ru: 'Russian',
    ara: 'Arabic',
    ar: 'Arabic',
    hin: 'Hindi',
    hi: 'Hindi',
    und: 'Unknown',
  };

  // If track has a descriptive name, use it
  if (track.name && track.name !== 'und' && !track.name.match(/^Track \d+$/)) {
    return track.name;
  }

  // Otherwise use language code mapping
  const langName = langNames[track.lang.toLowerCase()] || track.lang.toUpperCase();
  return langName;
}
