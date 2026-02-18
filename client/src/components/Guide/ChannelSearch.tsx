import { useState, useEffect, useRef, useCallback } from 'react';
import type { Channel } from '../../types';
import './Guide.css';

interface ChannelSearchProps {
  channels: Channel[];
  onSelect: (channelIdx: number) => void;
  onClose: () => void;
}

export default function ChannelSearch({ channels, onSelect, onClose }: ChannelSearchProps) {
  const [query, setQuery] = useState('');
  const [focusedIdx, setFocusedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Filter channels by number or name
  const filtered = query.trim() === ''
    ? channels.map((ch, idx) => ({ channel: ch, originalIdx: idx }))
    : channels
        .map((ch, idx) => ({ channel: ch, originalIdx: idx }))
        .filter(({ channel }) => {
          const q = query.trim().toLowerCase();
          const numStr = channel.number.toString();
          return numStr.startsWith(q) || channel.name.toLowerCase().includes(q);
        });

  // Reset focused index when filter changes
  useEffect(() => {
    setFocusedIdx(0);
  }, [query]);

  // Scroll focused result into view
  useEffect(() => {
    const container = resultsRef.current;
    if (!container) return;
    const el = container.children[focusedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx]);

  const handleSelect = useCallback((originalIdx: number) => {
    onSelect(originalIdx);
    onClose();
  }, [onSelect, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIdx(prev => Math.min(filtered.length - 1, prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIdx(prev => Math.max(0, prev - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered.length > 0 && focusedIdx < filtered.length) {
        handleSelect(filtered[focusedIdx].originalIdx);
      }
    }
  }, [onClose, filtered, focusedIdx, handleSelect]);

  return (
    <div
      className="channel-search-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Search channels"
    >
      <div className="channel-search-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="channel-search-header">
          <input
            ref={inputRef}
            type="text"
            className="channel-search-input"
            placeholder="Channel # or name..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="channel-search-close"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="channel-search-results" ref={resultsRef}>
          {filtered.length === 0 && query.trim() !== '' && (
            <div className="channel-search-empty">No channels found</div>
          )}
          {filtered.map(({ channel, originalIdx }, i) => (
            <button
              key={channel.id}
              type="button"
              className={`channel-search-result ${i === focusedIdx ? 'channel-search-result-focused' : ''}`}
              onClick={() => handleSelect(originalIdx)}
              onMouseEnter={() => setFocusedIdx(i)}
            >
              <span className="channel-search-result-num">CH {channel.number}</span>
              <span className="channel-search-result-name">{channel.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
