import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ProfileProvider, useProfile } from './ProfileContext';
import * as api from '../services/api';
import type { Profile } from '../types';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    name: 'Joey',
    avatar_glyph: '',
    avatar_color: '#7c5cff',
    is_kids: false,
    max_rating: null,
    prefs: {},
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function Probe() {
  const { activeProfile, prefs, setPref, switchProfile, loading } = useProfile();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="name">{activeProfile?.name ?? 'none'}</span>
      <span data-testid="hours">{String(prefs.guide_hours ?? 'unset')}</span>
      <button onClick={() => setPref('guide_hours', 4)}>set</button>
      <button onClick={() => void switchProfile(2)}>switch</button>
    </div>
  );
}

describe('ProfileContext', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'getProfiles').mockResolvedValue([
      makeProfile(),
      makeProfile({ id: 2, name: 'Kid', is_kids: true, max_rating: 'TV-Y7', sort_order: 1 }),
    ]);
    vi.spyOn(api, 'getProfilePrefs').mockImplementation(async (id: number) =>
      id === 1 ? { guide_hours: 2 } : { guide_hours: 1 }
    );
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads the first profile when none is stored', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Joey'));
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  it('loads the stored active profile', async () => {
    localStorage.setItem('prevue_active_profile_id', '2');
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Kid'));
  });

  it('exposes the loaded prefs', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));
  });

  it('applies setPref optimistically before the request lands', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));

    act(() => { screen.getByText('set').click(); });
    expect(screen.getByTestId('hours')).toHaveTextContent('4');
    expect(api.patchProfilePrefs).not.toHaveBeenCalled();
  });

  it('debounces the write and sends it once', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));

    act(() => {
      screen.getByText('set').click();
      screen.getByText('set').click();
      screen.getByText('set').click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(api.patchProfilePrefs).toHaveBeenCalledTimes(1);
    expect(api.patchProfilePrefs).toHaveBeenCalledWith(1, { guide_hours: 4 });
  });

  it('retains the local value when the write fails', async () => {
    vi.spyOn(api, 'patchProfilePrefs').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));

    act(() => { screen.getByText('set').click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(screen.getByTestId('hours')).toHaveTextContent('4');
  });

  it('swaps prefs and persists the id when switching profile', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Joey'));

    await act(async () => { screen.getByText('switch').click(); });

    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Kid'));
    expect(screen.getByTestId('hours')).toHaveTextContent('1');
    expect(localStorage.getItem('prevue_active_profile_id')).toBe('2');
  });

  it('falls back to the first profile when the stored id no longer exists', async () => {
    localStorage.setItem('prevue_active_profile_id', '999');
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Joey'));
  });

  it('does not block rendering when the profile fetch fails', async () => {
    vi.spyOn(api, 'getProfiles').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('name')).toHaveTextContent('none');
  });
});
