import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useSleepTimer } from './useSleepTimer';
import { ProfileProvider } from '../contexts/ProfileContext';
import * as api from '../services/api';
import type { Profile } from '../types';

const JOEY: Profile = {
  id: 1, name: 'Joey', avatar_glyph: '', avatar_color: '#7c5cff',
  is_kids: false, max_rating: null, prefs: {}, sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

function Probe() {
  const [state, actions] = useSleepTimer();
  return (
    <div>
      <span data-testid="enabled">{String(state.enabled)}</span>
      <button onClick={() => actions.start(15)}>enable</button>
    </div>
  );
}

describe('useSleepTimer persistence', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([JOEY]);
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
    localStorage.setItem('prevue_prefs_migrated', '1');
  });

  afterEach(() => vi.restoreAllMocks());

  it('reads the enabled flag from the profile', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ sleep_enabled: false });
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('false'));
  });

  it('writes the last-used preset to the profile when a timer starts', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({});
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('true'));

    act(() => { screen.getByText('enable').click(); });

    await waitFor(() =>
      expect(api.patchProfilePrefs).toHaveBeenCalledWith(1, expect.objectContaining({ sleep_preset: 15 })),
    );
  });
});
