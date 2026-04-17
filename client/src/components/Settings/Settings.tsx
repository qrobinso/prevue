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
import {
  X, Check, XCircle,
  HardDrives, ListBullets, Funnel,
  Palette, Television, Play,
  Sparkle,
  Info, ChartBar,
} from '@phosphor-icons/react';
import { useNavLayer, moveFocus, getFocusableChildren } from '../../navigation';
import './Settings.css';

interface SettingsProps {
  onClose: () => void;
  sleepState?: SleepTimerState;
  sleepActions?: SleepTimerActions;
}

type PanelId =
  | 'sources'
  | 'channels'
  | 'filters'
  | 'theme'
  | 'guide'
  | 'player'
  | 'ai'
  | 'about'
  | 'diagnostics';

interface PanelDef {
  id: PanelId;
  label: string;
  group: 'SETUP' | 'LOOK' | 'INTELLIGENCE' | 'SYSTEM';
  Icon: typeof HardDrives;
}

const PANELS: PanelDef[] = [
  { id: 'sources',     label: 'Sources',     group: 'SETUP',        Icon: HardDrives },
  { id: 'channels',    label: 'Channels',    group: 'SETUP',        Icon: ListBullets },
  { id: 'filters',     label: 'Filters',     group: 'SETUP',        Icon: Funnel },
  { id: 'theme',       label: 'Theme',       group: 'LOOK',         Icon: Palette },
  { id: 'guide',       label: 'Guide',       group: 'LOOK',         Icon: Television },
  { id: 'player',      label: 'Player',      group: 'LOOK',         Icon: Play },
  { id: 'ai',          label: 'AI',          group: 'INTELLIGENCE', Icon: Sparkle },
  { id: 'about',       label: 'About',       group: 'SYSTEM',       Icon: Info },
  { id: 'diagnostics', label: 'Diagnostics', group: 'SYSTEM',       Icon: ChartBar },
];

const PANEL_ORDER = PANELS.map(p => p.id);

interface SyncProgress {
  step: string;
  message: string;
  current?: number;
  total?: number;
}

export default function Settings({ onClose, sleepState, sleepActions }: SettingsProps) {
  const [activePanel, setActivePanel] = useState<PanelId>('sources');
  const [syncInterstitialVisible, setSyncInterstitialVisible] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const isFocusInNav = useCallback(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && navRef.current?.contains(el);
  }, []);

  const isFocusInContent = useCallback(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && contentRef.current?.contains(el);
  }, []);

  const focusPanelButton = useCallback((id: PanelId) => {
    requestAnimationFrame(() => {
      const btn = navRef.current?.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
      btn?.focus();
    });
  }, []);

  // Scroll content to top when switching panels
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activePanel]);

  useNavLayer('settings', panelRef, onClose, {
    onArrow: (dir) => {
      // Sidebar: up/down moves through panels, right enters content
      if (isFocusInNav()) {
        if (dir === 'up' || dir === 'down') {
          const idx = PANEL_ORDER.indexOf(activePanel);
          const nextIdx = dir === 'down'
            ? (idx < PANEL_ORDER.length - 1 ? idx + 1 : 0)
            : (idx > 0 ? idx - 1 : PANEL_ORDER.length - 1);
          setActivePanel(PANEL_ORDER[nextIdx]);
          focusPanelButton(PANEL_ORDER[nextIdx]);
          return true;
        }
        if (dir === 'right' && contentRef.current) {
          const children = getFocusableChildren(contentRef.current);
          if (children.length > 0) {
            children[0].focus();
            return true;
          }
        }
        return false;
      }

      if (isFocusInContent() && contentRef.current) {
        if (dir === 'down') return moveFocus(contentRef.current, 'next', { wrap: false });
        if (dir === 'up') {
          const children = getFocusableChildren(contentRef.current);
          const active = document.activeElement as HTMLElement;
          const currentIdx = children.indexOf(active);
          if (currentIdx <= 0) {
            focusPanelButton(activePanel);
            return true;
          }
          return moveFocus(contentRef.current, 'prev', { wrap: false });
        }
        if (dir === 'left') {
          focusPanelButton(activePanel);
          return true;
        }
        return false;
      }

      return false;
    },
    onEnter: () => {
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

  const activeDef = PANELS.find(p => p.id === activePanel)!;

  const renderPanel = () => {
    switch (activePanel) {
      case 'sources':
        return (
          <>
            <GeneralSettings panel="sources" onServerAdded={handleServerAdded} />
            <IPTVSettings />
          </>
        );
      case 'channels':
        return (
          <>
            <ChannelSettings />
            <DisplaySettings panel="channels" />
          </>
        );
      case 'filters':
        return <FilterSettings />;
      case 'theme':
        return <DisplaySettings panel="theme" />;
      case 'guide':
        return <DisplaySettings panel="guide" />;
      case 'player':
        return (
          <>
            <DisplaySettings panel="player" />
            <GeneralSettings panel="playback" onServerAdded={handleServerAdded} />
            {sleepState && sleepActions && (
              <SleepTimerSettings sleepState={sleepState} sleepActions={sleepActions} />
            )}
          </>
        );
      case 'ai':
        return <GeneralSettings panel="ai" onServerAdded={handleServerAdded} />;
      case 'about':
        return <GeneralSettings panel="about" onServerAdded={handleServerAdded} />;
      case 'diagnostics':
        return (
          <>
            <MetricsSettings />
            <GeneralSettings panel="system" onServerAdded={handleServerAdded} />
          </>
        );
    }
  };

  // Group panels for sidebar rendering
  const grouped = (['SETUP', 'LOOK', 'INTELLIGENCE', 'SYSTEM'] as const).map(g => ({
    group: g,
    items: PANELS.filter(p => p.group === g),
  }));

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
      <div className="settings-panel settings-panel-sidebar" ref={panelRef}>
        <div className="settings-header">
          <h2 className="settings-title">SETTINGS</h2>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close">
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" ref={navRef} aria-label="Settings sections">
            {grouped.map(({ group, items }) => (
              <div key={group} className="settings-nav-group">
                <div className="settings-nav-group-label">{group}</div>
                {items.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    data-panel-id={id}
                    className={`settings-nav-item ${activePanel === id ? 'settings-nav-item-active' : ''}`}
                    onClick={() => setActivePanel(id)}
                  >
                    <span className="settings-nav-led" aria-hidden="true" />
                    <Icon size={14} weight={activePanel === id ? 'fill' : 'regular'} />
                    <span className="settings-nav-label">{label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="settings-content" ref={contentRef}>
            <div className="settings-panel-header">
              <span className="settings-panel-crumb">{activeDef.group}</span>
              <span className="settings-panel-crumb-sep">/</span>
              <span className="settings-panel-crumb-current">{activeDef.label.toUpperCase()}</span>
            </div>
            {renderPanel()}
          </div>
        </div>
      </div>
    </div>
  );
}
