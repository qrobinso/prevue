import { useState, useCallback, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams } from 'react-router-dom';
import Guide from './components/Guide/Guide';
import Player from './components/Player/Player';
import Settings from './components/Settings/Settings';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboard } from './hooks/useKeyboard';
import { getChannels, type ChannelWithProgram } from './services/api';
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
  onTune: (channel: Channel, program: ScheduleProgram) => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  guideRefreshKey: number;
  initialChannelId: number | null;
}) {
  useWebSocket();
  
  useKeyboard('guide', {
    onEscape: settingsOpen ? onCloseSettings : undefined,
  });

  return (
    <>
      <Guide
        key={guideRefreshKey}
        onTune={onTune}
        onOpenSettings={onOpenSettings}
        streamingPaused={settingsOpen}
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
  onBack: () => void;
}) {
  const { channelNumber } = useParams<{ channelNumber: string }>();
  const navigate = useNavigate();
  
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

  useKeyboard('player', {
    onEscape: onBack,
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
      onBack={onBack}
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

  const handleTune = useCallback((channel: Channel, program: ScheduleProgram) => {
    setLastChannelId(channel.id);
    // Navigate to channel URL
    navigate(`/channel/${channel.number}`);
  }, [navigate]);

  const handleBackToGuide = useCallback(() => {
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
