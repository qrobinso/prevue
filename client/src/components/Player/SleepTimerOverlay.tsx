import { useRef } from 'react';
import { SLEEP_PRESETS, formatSleepRemaining, type SleepTimerState, type SleepTimerActions } from '../../hooks/useSleepTimer';
import { Moon, X } from '@phosphor-icons/react';
import { useNavLayer, moveFocus } from '../../navigation';
import './SleepTimerOverlay.css';

interface SleepTimerOverlayProps {
  state: SleepTimerState;
  actions: SleepTimerActions;
}

/** Inner component — only mounts when picker is shown, so hooks run unconditionally. */
function SleepTimerPicker({ state, actions }: SleepTimerOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const presetsRef = useRef<HTMLDivElement>(null);

  useNavLayer('sleep-timer', panelRef, () => actions.closePicker(), {
    onArrow: (dir) => {
      if ((dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right') && presetsRef.current) {
        // Presets are laid out in a grid — use horizontal for left/right, vertical for up/down
        const d = dir === 'right' || dir === 'down' ? 'next' : 'prev';
        return moveFocus(presetsRef.current, d, { wrap: true });
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

  return (
    <div
      className="sleep-timer-backdrop"
      onClick={() => actions.closePicker()}
      aria-hidden="true"
    >
      <div
        className="sleep-timer-panel"
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Sleep timer"
      >
        <div className="sleep-timer-drag-handle" aria-hidden="true" />
        <div className="sleep-timer-header">
          <Moon size={18} weight="bold" className="sleep-timer-icon" />
          <span className="sleep-timer-title">Sleep Timer</span>
          <button
            type="button"
            className="sleep-timer-close"
            onClick={() => actions.closePicker()}
            aria-label="Close"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        {state.active && (
          <div className="sleep-timer-status">
            <span className="sleep-timer-remaining">
              {formatSleepRemaining(state.remainingMs)}
            </span>
            <span className="sleep-timer-label">remaining</span>
          </div>
        )}

        <div className="sleep-timer-presets" ref={presetsRef}>
          {SLEEP_PRESETS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={`sleep-timer-preset ${state.active && state.totalMs === minutes * 60 * 1000 ? 'active' : ''} ${minutes === state.lastPreset && !state.active ? 'last-used' : ''}`}
              onClick={() => actions.start(minutes)}
            >
              <span className="sleep-timer-preset-value">{minutes}</span>
              <span className="sleep-timer-preset-unit">min</span>
            </button>
          ))}
        </div>

        {state.active && (
          <button
            type="button"
            className="sleep-timer-cancel"
            onClick={() => actions.cancel()}
          >
            Turn Off
          </button>
        )}
      </div>
    </div>
  );
}

export default function SleepTimerOverlay({ state, actions }: SleepTimerOverlayProps) {
  if (!state.showPicker) return null;
  return <SleepTimerPicker state={state} actions={actions} />;
}

/** Small badge shown on the player when timer is active */
export function SleepTimerBadge({ state, onClick }: { state: SleepTimerState; onClick: () => void }) {
  if (!state.active) return null;

  return (
    <button
      type="button"
      className={`sleep-timer-badge ${state.isWindingDown ? 'winding-down' : ''}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title="Sleep timer"
    >
      <Moon size={12} weight="bold" />
      <span>{formatSleepRemaining(state.remainingMs)}</span>
    </button>
  );
}
