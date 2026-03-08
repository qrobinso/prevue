import { useMemo, useState, useEffect } from 'react';
import { X } from '@phosphor-icons/react';
import type { ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import {
  getAvailableFilters,
  countFilterMatches,
  type GuideFilterId,
} from './guideFilterUtils';
import './Guide.css';

interface GuideFilterProps {
  channels: ChannelWithProgram[];
  scheduleByChannel: Map<number, ScheduleProgram[]>;
  activeFilters: GuideFilterId[];
  onToggleFilter: (filterId: GuideFilterId) => void;
  onClearFilters: () => void;
  onClose: () => void;
}

export default function GuideFilter({
  channels,
  scheduleByChannel,
  activeFilters,
  onToggleFilter,
  onClearFilters,
  onClose,
}: GuideFilterProps) {
  // Refresh counts periodically so numbers update in real time while the dropdown is open
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 15000);
    return () => clearInterval(timer);
  }, []);

  const counts = useMemo(
    () => countFilterMatches(channels, scheduleByChannel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, scheduleByChannel, tick],
  );

  const activeSet = useMemo(() => new Set(activeFilters), [activeFilters]);

  return (
    <div
      className="channel-search-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Filter channels"
    >
      <div className="guide-filter-modal" onClick={(e) => e.stopPropagation()}>
        <div className="guide-filter-header">
          <span className="guide-filter-title">Filter Channels</span>
          <button
            type="button"
            className="channel-search-close"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={18} weight="bold" />
          </button>
        </div>
        <div className="guide-filter-options">
          {activeFilters.length > 0 && (
            <button
              type="button"
              className="guide-filter-option guide-filter-option-clear"
              onClick={onClearFilters}
            >
              Clear All Filters
            </button>
          )}
          {getAvailableFilters().map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`guide-filter-option ${activeSet.has(preset.id) ? 'guide-filter-option-active' : ''}`}
              onClick={() => onToggleFilter(preset.id)}
            >
              <span className="guide-filter-option-label">{preset.label}</span>
              <span className="guide-filter-option-count">{counts[preset.id]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
