import { useState, useCallback, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import Guide from './components/Guide/Guide';
import Player from './components/Player/Player';
import Settings from './components/Settings/Settings';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboard } from './hooks/useKeyboard';
import { getChannels, getSettings, type ChannelWithProgram } from './services/api';
import { applyPreviewBg, type PreviewBgOption } from './components/Settings/DisplaySettings';
import { isIOS } from './utils/platform';
import type { Channel, ScheduleProgram } from './types';

// Guide view component
function GuideView({ 
  onTune, 
  settingsOpen, 
  onOpenSettings, 
  onCloseSettings,
  guideRefreshKey,
  initialChannelId 
}: {
  onTune: (channel: Channel, program: ScheduleProgram, opts?: { fromFullscreen?: boolean }) => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  guideRefreshKey: number;
  initialChannelId: number | null;
}) {
  useWebSocket();
  const [hasUserInteracted, setHasUserInteracted] = useState(false);
  const interactedRef = useRef(false);

  // On iOS, don't start preview stream until user has touched the page (required for video autoplay)
  useEffect(() => {
    if (!isIOS() || interactedRef.current) return;
    const onInteraction = () => {
      if (interactedRef.current) return;
      interactedRef.current = true;
      setHasUserInteracted(true);
    };
    window.addEventListener('touchstart', onInteraction, { once: true, passive: true });
    window.addEventListener('click', onInteraction, { once: true });
    window.addEventListener('keydown', onInteraction, { once: true });
    return () => {
      window.removeEventListener('touchstart', onInteraction);
      window.removeEventListener('click', onInteraction);
      window.removeEventListener('keydown', onInteraction);
    };
  }, []);

  useKeyboard('guide', {
    onEscape: settingsOpen ? onCloseSettings : undefined,
  });

  const streamingPaused = settingsOpen || (isIOS() && !hasUserInteracted);

  return (
    <>
      <Guide
        key={guideRefreshKey}
        onTune={onTune}
        onOpenSettings={onOpenSettings}
        streamingPaused={streamingPaused}
        initialChannelId={initialChannelId}
      />
      {settingsOpen && (
        <Settings onClose={onCloseSettings} />
      )}
    </>
  );
}

// Player view component
function PlayerView({ 
  channels,
  onBack 
}: { 
  channels: ChannelWithProgram[];
  onBack: (channel?: Channel) => void;
}) {
  const { channelNumber } = useParams<{ channelNumber: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const enterFullscreenOnMount = (location.state as { fromFullscreen?: boolean } | null)?.fromFullscreen === true;
  
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [currentProgram, setCurrentProgram] = useState<ScheduleProgram | null>(null);

  useWebSocket();

  // Find channel from URL parameter
  useEffect(() => {
    if (channelNumber && channels.length > 0) {
      const num = parseInt(channelNumber, 10);
      const channel = channels.find(ch => ch.number === num);
      if (channel) {
        setCurrentChannel(channel);
        setCurrentProgram(channel.current_program || null);
      } else {
        // Channel not found, redirect to guide
        navigate('/', { replace: true });
      }
    }
  }, [channelNumber, channels, navigate]);

  const handleChannelUp = useCallback(() => {
    if (channels.length === 0 || !currentChannel) return;
    const idx = channels.findIndex(ch => ch.id === currentChannel.id);
    const prevIdx = idx <= 0 ? channels.length - 1 : idx - 1;
    navigate(`/channel/${channels[prevIdx].number}`);
  }, [channels, currentChannel, navigate]);

  const handleChannelDown = useCallback(() => {
    if (channels.length === 0 || !currentChannel) return;
    const idx = channels.findIndex(ch => ch.id === currentChannel.id);
    const nextIdx = idx < 0 || idx >= channels.length - 1 ? 0 : idx + 1;
    navigate(`/channel/${channels[nextIdx].number}`);
  }, [channels, currentChannel, navigate]);

  useKeyboard('player', {
    onEscape: onBack,
    onUp: handleChannelUp,
    onDown: handleChannelDown,
  });

  if (!currentChannel) {
    return (
      <div className="guide">
        <div className="guide-loading">
          <div className="guide-loading-text">LOADING CHANNEL...</div>
        </div>
      </div>
    );
  }

  return (
    <Player
      channel={currentChannel}
      program={currentProgram}
      onBack={() => onBack(currentChannel)}
      onChannelUp={handleChannelUp}
      onChannelDown={handleChannelDown}
      enterFullscreenOnMount={enterFullscreenOnMount}
    />
  );
}

// Main App content with shared state
function AppContent() {
  const navigate = useNavigate();
  
  const [guideRefreshKey, setGuideRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [channels, setChannels] = useState<ChannelWithProgram[]>([]);
  const [lastChannelId, setLastChannelId] = useState<number | null>(null);

  // Fetch channels for URL-based navigation
  useEffect(() => {
    const fetchChannels = async () => {
      try {
        const data = await getChannels();
        setChannels(data);
      } catch (err) {
        console.error('Failed to fetch channels:', err);
      }
    };
    fetchChannels();
  }, [guideRefreshKey]);

  // Apply display settings from DB on load (preview background, etc.)
  useEffect(() => {
    applyPreviewBg('theme'); // default while fetching
    getSettings()
      .then((s) => {
        const v = s.preview_bg;
        if (v === 'theme' || v === 'black' || v === 'white') {
          applyPreviewBg(v as PreviewBgOption);
        }
      })
      .catch(() => {});
  }, []);

  const handleTune = useCallback((channel: Channel, program: ScheduleProgram, opts?: { fromFullscreen?: boolean }) => {
    setLastChannelId(channel.id);
    // Navigate to channel URL; preserve fullscreen state when switching from guide
    navigate(`/channel/${channel.number}`, { state: opts?.fromFullscreen ? { fromFullscreen: true } : undefined });
  }, [navigate]);

  const handleBackToGuide = useCallback((channel?: Channel) => {
    if (channel) setLastChannelId(channel.id);
    navigate('/');
  }, [navigate]);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setGuideRefreshKey(k => k + 1);
    setSettingsOpen(false);
  }, []);

  return (
    <div className="app">
      <div className="app-content">
        <Routes>
          <Route
            path="/"
            element={
            <GuideView
              onTune={handleTune}
              settingsOpen={settingsOpen}
              onOpenSettings={handleOpenSettings}
              onCloseSettings={handleCloseSettings}
              guideRefreshKey={guideRefreshKey}
              initialChannelId={lastChannelId}
            />
            }
          />
          <Route
            path="/channel/:channelNumber"
            element={
            <PlayerView 
              channels={channels}
              onBack={handleBackToGuide}
            />
            }
          />
        </Routes>
      </div>
    </div>
  );
}

// Main App with Router
export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
