import { useState, useEffect, useRef, useCallback } from 'react';
import GeneralSettings from './GeneralSettings';
import FilterSettings from './FilterSettings';
import ChannelSettings from './ChannelSettings';
import DisplaySettings from './DisplaySettings';
import IPTVSettings from './IPTVSettings';
import MetricsSettings from './MetricsSettings';
import SleepTimerSettings from './SleepTimerSettings';
import type { SleepTimerState, SleepTimerActions } from '../../hooks/useSleepTimer';
import { wsClient } from '../../services/websocket';
import { X, Check, XCircle } from '@phosphor-icons/react';
import { useNavLayer, moveFocus, getFocusableChildren } from '../../navigation';
import './Settings.css';

interface SettingsProps {
  onClose: () => void;
  sleepState?: SleepTimerState;
  sleepActions?: SleepTimerActions;
}

type SettingsTab = 'general' | 'filters' | 'channels' | 'display' | 'iptv' | 'metrics' | 'timer';

const TAB_ORDER: SettingsTab[] = ['general', 'timer', 'filters', 'channels', 'display', 'iptv', 'metrics'];

interface SyncProgress {
  step: string;
  message: string;
  current?: number;
  total?: number;
}

export default function Settings({ onClose, sleepState, sleepActions }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [syncInterstitialVisible, setSyncInterstitialVisible] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Track whether focus is in tab bar vs content for arrow routing
  const isFocusInTabBar = useCallback(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && tabBarRef.current?.contains(el);
  }, []);

  const isFocusInContent = useCallback(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && contentRef.current?.contains(el);
  }, []);

  // ── Navigation Layer ──
  useNavLayer('settings', panelRef, onClose, {
    onArrow: (dir) => {
      if (dir === 'left' || dir === 'right') {
        // Tab bar: Left/Right switches tabs
        if (isFocusInTabBar()) {
          const currentIdx = TAB_ORDER.indexOf(activeTab);
          let nextIdx: number;
          if (dir === 'right') {
            nextIdx = currentIdx < TAB_ORDER.length - 1 ? currentIdx + 1 : 0;
          } else {
            nextIdx = currentIdx > 0 ? currentIdx - 1 : TAB_ORDER.length - 1;
          }
          setActiveTab(TAB_ORDER[nextIdx]);
          // Focus the new tab button after render
          requestAnimationFrame(() => {
            if (tabBarRef.current) {
              const tabs = tabBarRef.current.querySelectorAll<HTMLElement>('.settings-tab');
              tabs[nextIdx]?.focus();
            }
          });
          return true;
        }
        // In content area, don't handle left/right (let default behavior)
        return false;
      }

      if (dir === 'down') {
        if (isFocusInTabBar() && contentRef.current) {
          // Move from tab bar to content
          const children = getFocusableChildren(contentRef.current);
          if (children.length > 0) {
            children[0].focus();
            return true;
          }
        }
        // Within content: move to next focusable
        if (isFocusInContent() && contentRef.current) {
          return moveFocus(contentRef.current, 'next', { wrap: false });
        }
        return false;
      }

      if (dir === 'up') {
        if (isFocusInContent() && contentRef.current) {
          const children = getFocusableChildren(contentRef.current);
          const active = document.activeElement as HTMLElement;
          const idx = children.indexOf(active);
          if (idx <= 0) {
            // At top of content → move back to tab bar
            if (tabBarRef.current) {
              const tabIdx = TAB_ORDER.indexOf(activeTab);
              const tabs = tabBarRef.current.querySelectorAll<HTMLElement>('.settings-tab');
              tabs[tabIdx]?.focus();
              return true;
            }
          }
          return moveFocus(contentRef.current, 'prev', { wrap: false });
        }
        return false;
      }

      return false;
    },
    onEnter: () => {
      // Let the browser handle native button/input clicks
      const el = document.activeElement;
      if (el instanceof HTMLElement) {
        el.click();
        return true;
      }
      return false;
    },
  });

  const handleServerAdded = (server: { is_active: boolean }) => {
    if (server.is_active) {
      setSyncProgress({ step: 'syncing', message: 'Syncing library...' });
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
              {syncProgress.step === 'complete' ? <Check size={24} weight="bold" /> : syncProgress.step === 'error' ? <XCircle size={24} weight="bold" /> : ''}
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
      <div className="settings-panel" ref={panelRef}>
        <div className="settings-header">
          <h2 className="settings-title">SETTINGS</h2>
          <button className="settings-close-btn" onClick={onClose}><X size={18} weight="bold" /></button>
        </div>

        <div className="settings-tabs" ref={tabBarRef}>
          <button
            className={`settings-tab ${activeTab === 'general' ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            GENERAL
          </button>
          <button
            className={`settings-tab ${activeTab === 'timer' ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab('timer')}
          >
            TIMER
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

        <div className="settings-content" ref={contentRef}>
          {activeTab === 'general' && <GeneralSettings onServerAdded={handleServerAdded} />}
          {activeTab === 'filters' && <FilterSettings />}
          {activeTab === 'channels' && <ChannelSettings />}
          {activeTab === 'display' && <DisplaySettings />}
          {activeTab === 'iptv' && <IPTVSettings />}
          {activeTab === 'metrics' && <MetricsSettings />}
          {activeTab === 'timer' && sleepState && sleepActions && (
            <SleepTimerSettings sleepState={sleepState} sleepActions={sleepActions} />
          )}
        </div>
      </div>
    </div>
  );
}
