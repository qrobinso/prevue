import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkle, X } from '@phosphor-icons/react';
import './AIFilterModal.css';

interface AIFilterModalProps {
  open: boolean;
  /** Pre-filled query when re-editing an active filter. */
  initialQuery?: string;
  /** True while the network call is in flight. */
  submitting: boolean;
  /** Called when user submits. Parent runs the LLM call and handles errors. */
  onSubmit: (query: string) => void;
  onClose: () => void;
}

const EXAMPLES = [
  'Something short before bed',
  'A feel-good movie',
  'Action that just started',
  '90s nostalgia',
  'Something I can have on in the background',
];

export default function AIFilterModal({
  open,
  initialQuery = '',
  submitting,
  onSubmit,
  onClose,
}: AIFilterModalProps) {
  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const trimmed = query.trim();

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!trimmed || submitting) return;
    onSubmit(trimmed);
  };

  return createPortal(
    <div
      className="ai-filter-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div
        className="ai-filter-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-filter-modal-title"
      >
        <button
          type="button"
          className="ai-filter-modal-close"
          onClick={onClose}
          aria-label="Close"
          disabled={submitting}
        >
          <X size={18} weight="bold" />
        </button>

        <div className="ai-filter-modal-header">
          <Sparkle size={18} weight="fill" className="ai-filter-modal-sparkle" />
          <span className="ai-filter-modal-label">AI CHANNEL FILTER</span>
        </div>

        <h2 id="ai-filter-modal-title" className="ai-filter-modal-title">
          What do you feel like watching?
        </h2>
        <p className="ai-filter-modal-subtitle">
          Describe the vibe, mood, or a specific ask. The guide will narrow to channels whose current program matches.
        </p>

        <form className="ai-filter-modal-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="ai-filter-modal-input"
            placeholder="e.g. short comedy before bed"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={submitting}
            maxLength={200}
            autoComplete="off"
            spellCheck
          />
          <div className="ai-filter-modal-actions">
            <button
              type="button"
              className="ai-filter-modal-btn ai-filter-modal-btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="ai-filter-modal-btn ai-filter-modal-btn-primary"
              disabled={!trimmed || submitting}
            >
              {submitting ? 'Finding…' : 'Find channels'}
            </button>
          </div>
        </form>

        <div className="ai-filter-modal-examples">
          <div className="ai-filter-modal-examples-label">Try</div>
          <div className="ai-filter-modal-examples-chips">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="ai-filter-modal-example"
                onClick={() => { setQuery(ex); inputRef.current?.focus(); }}
                disabled={submitting}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
