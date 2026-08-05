import { useState, useCallback, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import Guide from './components/Guide/Guide';
import Player from './components/Player/Player';
import AuthGate from './components/AuthGate';
import NavBar from './components/NavBar/NavBar';
import Settings from './components/Settings/Settings';
import ProfilePage from './components/Profile/ProfilePage';
import { useWebSocket } from './hooks/useWebSocket';
import { NavigationProvider } from './navigation';
import { NotificationProvider } from './notifications';
import { ProfileProvider, useProfile } from './contexts/ProfileContext';
import { getChannels, getSettings, getAuthStatus, onUnauthorized, metricsChannelSwitch, getRecommendedChannel, getServers, regenerateSchedule, type ChannelWithProgram } from './services/api';
import { getClientId, getMetricsClientFields } from './services/clientIdentity';
import { useClientRegistration } from './hooks/useClientRegistration';
import { applyPreviewBg, type PreviewBgOption } from './components/Settings/DisplaySettings';
import { applyGuideFilterSimple, type GuideFilterId } from './components/Guide/guideFilterUtils';
import { usePref } from './hooks/usePref';
import { useSleepTimer } from './hooks/useSleepTimer';
import GoodnightScreen from './components/Player/GoodnightScreen';
import { isIOS } from './utils/platform';
import type { Channel, ScheduleProgram, WSEvent } from './types';

export type AppView = 'guide' | 'player';

const EMPTY_FILTERS: GuideFilterId[] = [];

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
  const { activeProfile, loading: profileLoading } = useProfile();

  // Derive active channel from URL
  const channelMatch = location.pathname.match(/^\/channel\/(\d+)$/);
  const activeChannelNumber = channelMatch ? parseInt(channelMatch[1], 10) : null;
  const playerActive = activeChannelNumber !== null;

  const [channels, setChannels] = useState<ChannelWithProgram[]>([]);
  const [lastChannelId, setLastChannelId] = useState<number | null>(null);
  const [guideFocusedChannelId, setGuideFocusedChannelId] = useState<number | null>(null);
  const enterFullscreenRef = useRef(false);
  // guide_filter is shared with Guide.tsx via ProfileContext, so this component re-renders
  // automatically when the filter changes there — no event listener needed here.
  const [activeFilters] = usePref<GuideFilterId[]>('guide_filter', EMPTY_FILTERS);
  const [autoTuneEnabled] = usePref('auto_tune', false);
  const [lastChannelNumber, setLastChannelNumber] = usePref<number | null>('last_channel_number', null);

  // iOS interaction detection (required for video autoplay)
  const [hasUserInteracted, setHasUserInteracted] = useState(false);
  const interactedRef = useRef(false);

  // Re-fetch App-level channels when server broadcasts changes
  const handleWsEvent = useCallback((event: WSEvent) => {
    if (
      event.type === 'channels:regenerated' ||
      event.type === 'channel:added' ||
      event.type === 'channel:removed' ||
      event.type === 'schedule:updated'
    ) {
      getChannels()
        .then(setChannels)
        .catch(() => {});
    }
  }, []);

  useWebSocket(handleWsEvent);
  useClientRegistration();

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

  // Fetch channels on mount for player channel resolution (WS events handle subsequent updates)
  const scheduleCheckDoneRef = useRef(false);
  useEffect(() => {
    getChannels()
      .then((chs) => {
        setChannels(chs);
        // Auto-regenerate schedule if server is active but no programs are playing
        if (scheduleCheckDoneRef.current || chs.length === 0) return;
        scheduleCheckDoneRef.current = true;
        const hasAnyProgram = chs.some(ch => ch.current_program !== null);
        if (!hasAnyProgram) {
          getServers()
            .then((servers) => {
              if (servers.some(s => s.is_active)) {
                regenerateSchedule()
                  .catch(() => {}); // WS event will refresh channels automatically
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // Refetch channels when the active profile changes (lineup/ceiling differ per
  // profile) — otherwise the previous profile's channel list lingers until a
  // WebSocket event or reload. Skip the run that merely observes the initial
  // profile resolution: the mount effect above already fetched once.
  const channelsProfileIdRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (profileLoading) return;
    const id = activeProfile?.id ?? null;
    if (channelsProfileIdRef.current === undefined) {
      channelsProfileIdRef.current = id;
      return;
    }
    if (channelsProfileIdRef.current === id) return;
    channelsProfileIdRef.current = id;
    getChannels().then(setChannels).catch(() => {});
  }, [activeProfile?.id, profileLoading]);

  // Auto-tune: skip guide and navigate directly to a channel on mount
  const autoTuneAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoTuneAttemptedRef.current || !autoTuneEnabled || channels.length === 0 || playerActive) return;
    autoTuneAttemptedRef.current = true;

    // Try persisted channel first
    if (lastChannelNumber !== null) {
      const ch = channels.find(c => c.number === lastChannelNumber);
      if (ch) {
        navigate(`/channel/${ch.number}`, { replace: true });
        return;
      }
    }

    // Fall back to smart recommendation
    getRecommendedChannel(getClientId())
      .then(({ channel_number }) => {
        if (channel_number !== null) {
          navigate(`/channel/${channel_number}`, { replace: true });
        }
      })
      .catch(() => {}); // Fail silently - user sees guide as normal
  }, [channels, playerActive, navigate, autoTuneEnabled, lastChannelNumber]);

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
    setLastChannelNumber(channel.number);
    enterFullscreenRef.current = opts?.fromFullscreen === true;
    navigate(`/channel/${channel.number}`);
    metricsChannelSwitch({
      ...getMetricsClientFields(),
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
    navigate('/settings');
  }, [navigate]);

  const handleCloseSettings = useCallback(() => {
    navigate('/');
  }, [navigate]);

  // Jump back to the last-tuned channel
  const handleLastChannel = useCallback(() => {
    if (!lastChannelId || channels.length === 0) return;
    const target = channels.find(ch => ch.id === lastChannelId);
    if (!target) return;
    // Don't switch if already on the last channel
    if (currentChannel && currentChannel.id === lastChannelId) return;
    const fromChannel = currentChannel ?? null;
    setLastChannelId(fromChannel?.id ?? null);
    navigate(`/channel/${target.number}`);
    metricsChannelSwitch({
      ...getMetricsClientFields(),
      from_channel_id: fromChannel?.id,
      from_channel_name: fromChannel?.name,
      to_channel_id: target.id,
      to_channel_name: target.name,
    }).catch(() => {});
  }, [lastChannelId, channels, currentChannel, navigate, setLastChannelNumber]);

  // Player channel navigation
  const handleChannelUp = useCallback(() => {
    if (channels.length === 0 || !currentChannel) return;
    const navChannels = applyGuideFilterSimple(channels, activeFilters, currentChannel.id);
    if (navChannels.length === 0) return;
    const idx = navChannels.findIndex(ch => ch.id === currentChannel.id);
    const prevIdx = idx <= 0 ? navChannels.length - 1 : idx - 1;
    const target = navChannels[prevIdx];
    setLastChannelId(currentChannel.id);
    navigate(`/channel/${target.number}`);
    metricsChannelSwitch({
      ...getMetricsClientFields(),
      from_channel_id: currentChannel.id,
      from_channel_name: currentChannel.name,
      to_channel_id: target.id,
      to_channel_name: target.name,
    }).catch(() => {});
  }, [channels, currentChannel, navigate, activeFilters]);

  const handleChannelDown = useCallback(() => {
    if (channels.length === 0 || !currentChannel) return;
    const navChannels = applyGuideFilterSimple(channels, activeFilters, currentChannel.id);
    if (navChannels.length === 0) return;
    const idx = navChannels.findIndex(ch => ch.id === currentChannel.id);
    const nextIdx = idx < 0 || idx >= navChannels.length - 1 ? 0 : idx + 1;
    const target = navChannels[nextIdx];
    setLastChannelId(currentChannel.id);
    navigate(`/channel/${target.number}`);
    metricsChannelSwitch({
      ...getMetricsClientFields(),
      from_channel_id: currentChannel.id,
      from_channel_name: currentChannel.name,
      to_channel_id: target.id,
      to_channel_name: target.name,
    }).catch(() => {});
  }, [channels, currentChannel, navigate, activeFilters]);

  // Random channel (for player view)
  const handleRandomChannel = useCallback(() => {
    if (channels.length <= 1) return;
    const navChannels = applyGuideFilterSimple(channels, activeFilters);
    if (navChannels.length <= 1) return;
    let target: typeof navChannels[number];
    do {
      target = navChannels[Math.floor(Math.random() * navChannels.length)];
    } while (currentChannel && target.id === currentChannel.id);
    if (currentChannel) setLastChannelId(currentChannel.id);
    navigate(`/channel/${target.number}`);
    metricsChannelSwitch({
      ...getMetricsClientFields(),
      from_channel_id: currentChannel?.id,
      from_channel_name: currentChannel?.name,
      to_channel_id: target.id,
      to_channel_name: target.name,
    }).catch(() => {});
  }, [channels, currentChannel, navigate, activeFilters]);

  // Sleep timer (lives at App level so it survives channel changes and guide navigation)
  const [sleepState, sleepActions] = useSleepTimer();

  // Handle goodnight screen dismiss: resume playback
  const handleGoodnightDismiss = useCallback(() => {
    sleepActions.cancel();
  }, [sleepActions]);

  // Guide streaming paused when player overlay is active or iOS not yet interacted
  const guideStreamingPaused = playerActive || (isIOS() && !hasUserInteracted);

  // Fullscreen signal: consumed once when player opens, reset when player closes
  const enterFullscreenOnMount = playerActive ? enterFullscreenRef.current : false;
  useEffect(() => {
    if (!playerActive) {
      enterFullscreenRef.current = false;
    }
  }, [playerActive]);

  return (
    <div className="app">
      <NavBar />
      <div className="app-content">
        {/* Guide - always mounted as base layer */}
        <Guide
          onTune={handleTune}
          onOpenSettings={handleOpenSettings}
          streamingPaused={guideStreamingPaused}
          initialChannelId={lastChannelId}
          keyboardDisabled={playerActive}
          onFocusedChannelChange={setGuideFocusedChannelId}
          onLastChannel={handleLastChannel}
        />

        {/* Player overlay - shown when a channel URL is active */}
        {playerActive && currentChannel && (
          <div className="player-overlay">
            <Player
              channel={currentChannel}
              program={currentProgram}
              onBack={() => handleBackToGuide(currentChannel)}
              onChannelUp={handleChannelUp}
              onChannelDown={handleChannelDown}
              onLastChannel={handleLastChannel}
              onRandomChannel={handleRandomChannel}
              enterFullscreenOnMount={enterFullscreenOnMount}
              sleepState={sleepState}
              sleepActions={sleepActions}
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

      {/* Settings / Profile render over the always-mounted guide */}
      <Routes>
        <Route
          path="/settings"
          element={<Settings onClose={handleCloseSettings} sleepState={sleepState} sleepActions={sleepActions} />}
        />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={null} />
      </Routes>

      {/* Goodnight screen - shown when sleep timer expires */}
      {sleepState.isExpired && (
        <GoodnightScreen onDismiss={handleGoodnightDismiss} />
      )}
    </div>
  );
}

// Main App with Router
export default function App() {
  return (
    <BrowserRouter>
      <NavigationProvider>
        <NotificationProvider>
          <AuthWrapper>
            <ProfileProvider>
              <AppContent />
            </ProfileProvider>
          </AuthWrapper>
        </NotificationProvider>
      </NavigationProvider>
    </BrowserRouter>
  );
}
