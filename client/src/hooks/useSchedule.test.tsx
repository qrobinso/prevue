import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useSchedule } from './useSchedule';
import { ProfileProvider, useProfile } from '../contexts/ProfileContext';
import * as api from '../services/api';
import * as profileApi from '../services/api';
import type { Profile } from '../types';

const JOEY: Profile = {
  id: 1, name: 'Joey', avatar_glyph: '', avatar_color: '#7c5cff',
  is_kids: false, max_rating: null, prefs: {}, sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

const KID: Profile = {
  id: 2, name: 'Kiddo', avatar_glyph: '', avatar_color: '#ff5c5c',
  is_kids: true, max_rating: 'TV-Y7', prefs: {}, sort_order: 1,
  created_at: '2026-01-01T00:00:00.000Z',
};

function Probe() {
  const { channels } = useSchedule();
  const { switchProfile } = useProfile();
  return (
    <div>
      <span data-testid="count">{channels.length}</span>
      <button onClick={() => switchProfile(2)}>switch</button>
    </div>
  );
}

describe('useSchedule profile-change refetch', () => {
  beforeEach(() => {
    vi.spyOn(profileApi, 'getProfiles').mockResolvedValue([JOEY, KID]);
    vi.spyOn(profileApi, 'getProfilePrefs').mockResolvedValue({});
    vi.spyOn(profileApi, 'patchProfilePrefs').mockResolvedValue({});
    vi.spyOn(api, 'getSchedule').mockResolvedValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('fetches the schedule exactly once on mount', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    // Give any stray effects a tick to settle before asserting call count.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.getSchedule).toHaveBeenCalledTimes(1);
  });

  it('refetches the schedule when the active profile changes', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByText('switch').click();
    });

    await waitFor(() => expect(api.getSchedule).toHaveBeenCalledTimes(2));
  });
});
