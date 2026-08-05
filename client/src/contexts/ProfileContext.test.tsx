import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
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
      <button onClick={() => void switchProfile(1)}>switch1</button>
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
    // Unmount (which flushes any pending debounced write) BEFORE restoring
    // mocks, so the unmount-time flush() still hits the mocked
    // patchProfilePrefs instead of falling through to a real, unmocked
    // fetch() call.
    cleanup();
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

  it('attributes a pending debounced write to the profile it was made for, not the one switched into', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));

    // Pending write for profile 1; debounce timer hasn't fired yet.
    act(() => { screen.getByText('set').click(); });
    expect(api.patchProfilePrefs).not.toHaveBeenCalled();

    // Switch to profile 2 before the 400ms debounce elapses.
    await act(async () => { screen.getByText('switch').click(); });
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Kid'));

    // The switch must have flushed profile 1's pending write attributed to
    // profile 1 -- never let it land on profile 2 once activeProfile flips.
    expect(api.patchProfilePrefs).toHaveBeenCalledWith(1, { guide_hours: 4 });
    expect(api.patchProfilePrefs).not.toHaveBeenCalledWith(2, expect.objectContaining({ guide_hours: 4 }));

    // The old timer must be cleared by the switch, so letting time pass
    // must not fire a second, misattributed write.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(api.patchProfilePrefs).toHaveBeenCalledTimes(1);
  });

  it('applies only the most recently requested profile load when prefs fetches resolve out of order', async () => {
    let resolveNewer: ((prefs: Record<string, unknown>) => void) | null = null;
    let resolveOlder: ((prefs: Record<string, unknown>) => void) | null = null;
    let call = 0;

    vi.spyOn(api, 'getProfilePrefs').mockImplementation((id: number) => {
      call++;
      if (call === 1) {
        // Initial mount load for profile 1.
        return Promise.resolve(id === 1 ? { guide_hours: 2 } : { guide_hours: 1 });
      }
      if (call === 2) {
        // First switch (to profile 2) -- the OLDER request; resolves LAST.
        return new Promise<Record<string, unknown>>((resolve) => { resolveOlder = resolve; });
      }
      // Second switch (back to profile 1) -- the NEWER request; resolves FIRST.
      return new Promise<Record<string, unknown>>((resolve) => { resolveNewer = resolve; });
    });

    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));

    // Fire both switches back-to-back without waiting for either to resolve.
    act(() => {
      screen.getByText('switch').click();   // -> profile 2 (older, in-flight)
      screen.getByText('switch1').click();  // -> profile 1 (newer, in-flight)
    });

    // Resolve out of order: the newer request lands first, the stale one after.
    await act(async () => {
      resolveNewer?.({ guide_hours: 2 });
      await Promise.resolve();
    });
    await act(async () => {
      resolveOlder?.({ guide_hours: 1 });
      await Promise.resolve();
    });

    // The stale (older, profile-2) response must not clobber the newer
    // (profile-1) prefs that already landed.
    expect(screen.getByTestId('name')).toHaveTextContent('Joey');
    expect(screen.getByTestId('hours')).toHaveTextContent('2');
  });

  it('runs the localStorage migration once on boot', async () => {
    // guide_hours is already present in the mocked profile prefs (see
    // beforeEach), so use a key the profile doesn't have yet -- otherwise
    // first-migration-wins filters it out and no PATCH is sent.
    localStorage.setItem('prevue_color_theme', 'amber');
    const patch = vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});

    const { unmount } = render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    unmount();

    patch.mockClear();
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(patch).not.toHaveBeenCalled();
  });
});
