import { useState, useEffect, useRef } from 'react';
import ServerSettings from './ServerSettings';
import FilterSettings from './FilterSettings';
import ChannelSettings from './ChannelSettings';
import DisplaySettings from './DisplaySettings';
import IPTVSettings from './IPTVSettings';
import MetricsSettings from './MetricsSettings';
import { wsClient } from '../../services/websocket';
import './Settings.css';

interface SettingsProps {
  onClose: () => void;
}

type SettingsTab = 'servers' | 'filters' | 'channels' | 'display' | 'iptv' | 'metrics';

interface SyncProgress {
  step: string;
  message: string;
  current?: number;
  total?: number;
}

export default function Settings({ onClose }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('servers');
  const [syncInterstitialVisible, setSyncInterstitialVisible] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleServerAdded = (server: { is_active: boolean }) => {
    if (server.is_active) {
      setSyncProgress({ step: 'syncing', message: 'Syncing library from Jellyfin...' });
      setSyncInterstitialVisible(true);
    }
  };

  useEffect(() => {
    if (!syncInterstitialVisible) return;
    wsClient.connect();
    const unsubscribe = wsClient.subscribe((event) => {
      if (event.type === 'generation:progress') {
        setSyncProgress(event.payload as SyncProgress);
      }
    });
    return unsubscribe;
  }, [syncInterstitialVisible]);

  useEffect(() => {
    if (!syncProgress || !syncInterstitialVisible) return;
    if (syncProgress.step === 'complete' || syncProgress.step === 'error') {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        setSyncInterstitialVisible(false);
        setSyncProgress(null);
        hideTimerRef.current = null;
      }, syncProgress.step === 'error' ? 3000 : 1500);
    }
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [syncProgress?.step, syncInterstitialVisible]);

  return (
    <div className="settings-overlay">
      {syncInterstitialVisible && syncProgress && (
        <div className="settings-sync-interstitial">
          <div className="settings-sync-interstitial-card">
            <div className={`settings-sync-interstitial-spinner ${syncProgress.step === 'complete' ? 'settings-sync-interstitial-spinner-done' : ''} ${syncProgress.step === 'error' ? 'settings-sync-interstitial-spinner-error' : ''}`}>
              {syncProgress.step === 'complete' ? '✓' : syncProgress.step === 'error' ? '✗' : ''}
            </div>
            <div className="settings-sync-interstitial-message">{syncProgress.message}</div>
            {syncProgress.current != null && syncProgress.total != null && syncProgress.step === 'syncing' && (
              <div className="settings-sync-interstitial-bar">
                <div
                  className="settings-sync-interstitial-bar-fill"
                  style={{ width: `${(syncProgress.current / syncProgress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}
      <div className="settings-panel">
        <div className="settings-header">
          <h2 className="settings-title">SETTINGS</h2>
          <button className="settings-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeTab === 'servers' ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab('servers')}
          >
            SERVERS
          </button>
          <button
            className={`settings-tab ${activeTab === 'filters' ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab('filters')}
          >
            FILTERS
          </button>
          <button
            className={`settings-tab ${activeTab === 'channels' ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab('channels')}
          >
            CHANNELS
          </button>
          <button
            className={`settings-tab ${activeTab === 'display' ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab('display')}
          >
            DISPLAY
          </button>
          <button
            className={`settings-tab ${activeTab === 'iptv' ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab('iptv')}
          >
            IPTV
          </button>
          <button
            className={`settings-tab ${activeTab === 'metrics' ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab('metrics')}
          >
            METRICS
          </button>
        </div>

        <div className="settings-content">
          {activeTab === 'servers' && <ServerSettings onServerAdded={handleServerAdded} />}
          {activeTab === 'filters' && <FilterSettings />}
          {activeTab === 'channels' && <ChannelSettings />}
          {activeTab === 'display' && <DisplaySettings />}
          {activeTab === 'iptv' && <IPTVSettings />}
          {activeTab === 'metrics' && <MetricsSettings />}
        </div>
      </div>
    </div>
  );
}
