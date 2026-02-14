import { useState, useCallback, useEffect, useRef } from 'react';
import { BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import Guide from './components/Guide/Guide';
import Player from './components/Player/Player';
import Settings from './components/Settings/Settings';
import AuthGate from './components/AuthGate';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboard } from './hooks/useKeyboard';
import { getChannels, getSettings, getAuthStatus, onUnauthorized, metricsChannelSwitch, type ChannelWithProgram } from './services/api';
import { getClientId } from './services/clientIdentity';
import { applyPreviewBg, type PreviewBgOption } from './components/Settings/DisplaySettings';
import { isIOS } from './utils/platform';
import type { Channel, ScheduleProgram } from './types';

export type AppView = 'guide' | 'player';

// Auth wrapper: checks if API key auth is required and gates the app
function AuthWrapper({ children }: { children: React.ReactNode }) {
  const [authChecked, setAuthChecked] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    getAuthStatus()
      .then(({ required }) => {
        setAuthRequired(required);
        if (!required) setAuthenticated(true);
        else if (sessionStorage.getItem('prevue_api_key')) setAuthenticated(true);
        setAuthChecked(true);
      })
      .catch(() => {
        // Server unreachable; proceed without auth gate
        setAuthChecked(true);
        setAuthenticated(true);
      });

    onUnauthorized(() => {
      setAuthenticated(false);
    });
  }, []);

  if (!authChecked) return null;
  if (authRequired && !authenticated) {
    return <AuthGate onAuthenticated={() => setAuthenticated(true)} />;
  }
  return <>{children}</>;
}

// Single app shell: Guide is always mounted, Player appears as overlay
function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();

  // Derive active channel from URL
  const channelMatch = location.pathname.match(/^\/channel\/(\d+)$/);
  const activeChannelNumber = channelMatch ? parseInt(channelMatch[1], 10) : null;
  const playerActive = activeChannelNumber !== null;

  const [guideRefreshKey, setGuideRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [channels, setChannels] = useState<ChannelWithProgram[]>([]);
  const [lastChannelId, setLastChannelId] = useState<number | null>(null);
  const enterFullscreenRef = useRef(false);

  // iOS interaction detection (required for video autoplay)
  const [hasUserInteracted, setHasUserInteracted] = useState(false);
  const interactedRef = useRef(false);

  useWebSocket();

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

  // Fetch channels for player channel resolution
  useEffect(() => {
    const fetchChannels = async () => {
      try {
        const data = await getChannels();
        setChannels(data);
      } catch {
        // Channel fetch failed — will retry on next refresh
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

  // Resolve current channel and program for Player
  const currentChannel = playerActive && channels.length > 0
    ? channels.find(ch => ch.number === activeChannelNumber) ?? null
    : null;
  const currentProgram = currentChannel?.current_program ?? null;

  // Redirect to guide if channel not found (only after channels have loaded)
  useEffect(() => {
    if (playerActive && channels.length > 0 && !currentChannel) {
      navigate('/', { replace: true });
    }
  }, [playerActive, channels.length, currentChannel, navigate]);

  const handleTune = useCallback((channel: Channel, program: ScheduleProgram, opts?: { fromFullscreen?: boolean }) => {
    const prevChannelId = lastChannelId;
    const prevChannel = prevChannelId ? channels.find(ch => ch.id === prevChannelId) : null;
    setLastChannelId(channel.id);
    enterFullscreenRef.current = opts?.fromFullscreen === true;
    navigate(`/channel/${channel.number}`);
    metricsChannelSwitch({
      client_id: getClientId(),
      from_channel_id: prevChannel?.id,
      from_channel_name: prevChannel?.name,
      to_channel_id: channel.id,
      to_channel_name: channel.name,
    }).catch(() => {});
  }, [navigate, lastChannelId, channels]);

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

  // Player channel navigation
  const handleChannelUp = useCallback(() => {
    if (channels.length === 0 || !currentChannel) return;
    const idx = channels.findIndex(ch => ch.id === currentChannel.id);
    const prevIdx = idx <= 0 ? channels.length - 1 : idx - 1;
    const target = channels[prevIdx];
    navigate(`/channel/${target.number}`);
    metricsChannelSwitch({
      client_id: getClientId(),
      from_channel_id: currentChannel.id,
      from_channel_name: currentChannel.name,
      to_channel_id: target.id,
      to_channel_name: target.name,
    }).catch(() => {});
  }, [channels, currentChannel, navigate]);

  const handleChannelDown = useCallback(() => {
    if (channels.length === 0 || !currentChannel) return;
    const idx = channels.findIndex(ch => ch.id === currentChannel.id);
    const nextIdx = idx < 0 || idx >= channels.length - 1 ? 0 : idx + 1;
    const target = channels[nextIdx];
    navigate(`/channel/${target.number}`);
    metricsChannelSwitch({
      client_id: getClientId(),
      from_channel_id: currentChannel.id,
      from_channel_name: currentChannel.name,
      to_channel_id: target.id,
      to_channel_name: target.name,
    }).catch(() => {});
  }, [channels, currentChannel, navigate]);

  // Guide-level keyboard (disabled when player overlay is active)
  useKeyboard('guide', {
    onEscape: settingsOpen ? handleCloseSettings : undefined,
  }, !playerActive);

  // Guide streaming paused when player overlay is active, settings open, or iOS not yet interacted
  const guideStreamingPaused = playerActive || settingsOpen || (isIOS() && !hasUserInteracted);

  // Fullscreen signal: consumed once when player opens, reset when player closes
  const enterFullscreenOnMount = playerActive ? enterFullscreenRef.current : false;
  useEffect(() => {
    if (!playerActive) {
      enterFullscreenRef.current = false;
    }
  }, [playerActive]);

  return (
    <div className="app">
      <div className="app-content">
        {/* Guide - always mounted as base layer */}
        <Guide
          key={guideRefreshKey}
          onTune={handleTune}
          onOpenSettings={handleOpenSettings}
          streamingPaused={guideStreamingPaused}
          initialChannelId={lastChannelId}
          keyboardDisabled={playerActive}
        />
        {settingsOpen && !playerActive && (
          <Settings onClose={handleCloseSettings} />
        )}

        {/* Player overlay - shown when a channel URL is active */}
        {playerActive && currentChannel && (
          <div className="player-overlay">
            <Player
              channel={currentChannel}
              program={currentProgram}
              onBack={() => handleBackToGuide(currentChannel)}
              onChannelUp={handleChannelUp}
              onChannelDown={handleChannelDown}
              enterFullscreenOnMount={enterFullscreenOnMount}
            />
          </div>
        )}

        {/* Loading overlay while channels resolve for deep links */}
        {playerActive && !currentChannel && (
          <div className="player-overlay">
            <div className="guide">
              <div className="guide-loading">
                <div className="guide-loading-text">LOADING CHANNEL...</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Main App with Router
export default function App() {
  return (
    <BrowserRouter>
      <AuthWrapper>
        <AppContent />
      </AuthWrapper>
    </BrowserRouter>
  );
}
