import { useState } from 'react';
import ServerSettings from './ServerSettings';
import FilterSettings from './FilterSettings';
import ChannelSettings from './ChannelSettings';
import DisplaySettings from './DisplaySettings';
import './Settings.css';

interface SettingsProps {
  onClose: () => void;
}

type SettingsTab = 'servers' | 'filters' | 'channels' | 'display';

export default function Settings({ onClose }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('servers');

  return (
    <div className="settings-overlay">
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
        </div>

        <div className="settings-content">
          {activeTab === 'servers' && <ServerSettings />}
          {activeTab === 'filters' && <FilterSettings />}
          {activeTab === 'channels' && <ChannelSettings />}
          {activeTab === 'display' && <DisplaySettings />}
        </div>
      </div>
    </div>
  );
}
