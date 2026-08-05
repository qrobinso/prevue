import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useApplyTheme } from './useApplyTheme';
import { ProfileProvider } from '../contexts/ProfileContext';
import * as api from '../services/api';
import type { Profile } from '../types';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    name: 'Default',
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

/** Bare consumer — the hook's only output is the document attribute. */
function ThemeProbe() {
  useApplyTheme();
  return <p>probe</p>;
}

const theme = () => document.documentElement.getAttribute('data-theme');

describe('useApplyTheme', () => {
  beforeEach(() => {
    localStorage.setItem('prevue_prefs_migrated', '1');
    document.documentElement.removeAttribute('data-theme');
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it("applies the active profile's theme without opening Settings", async () => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([makeProfile()]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ color_theme: 'neon' });

    render(<ProfileProvider><ThemeProbe /></ProfileProvider>);

    await waitFor(() => expect(theme()).toBe('neon'));
  });

  it("ignores a stale device theme in favour of the profile's", async () => {
    // The device cached 'vapor', but this profile's theme is 'forest'.
    localStorage.setItem('prevue_color_theme', 'vapor');
    vi.spyOn(api, 'getProfiles').mockResolvedValue([makeProfile()]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ color_theme: 'forest' });

    render(<ProfileProvider><ThemeProbe /></ProfileProvider>);

    await waitFor(() => expect(theme()).toBe('forest'));
  });

  it('swaps the theme when the profile is switched', async () => {
    const dad = makeProfile({ id: 1, name: 'Dad' });
    const kid = makeProfile({ id: 2, name: 'Kid', sort_order: 1 });
    vi.spyOn(api, 'getProfiles').mockResolvedValue([dad, kid]);
    vi.spyOn(api, 'getProfilePrefs').mockImplementation(async (id: number) =>
      id === 1 ? { color_theme: 'noir' } : { color_theme: 'arctic' }
    );

    // Device starts on profile 2.
    localStorage.setItem('prevue_active_profile_id', '2');
    render(<ProfileProvider><ThemeProbe /></ProfileProvider>);

    await waitFor(() => expect(theme()).toBe('arctic'));
  });

  it('falls back to the default theme when the profile has none set', async () => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([makeProfile()]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({});

    render(<ProfileProvider><ThemeProbe /></ProfileProvider>);

    await waitFor(() => expect(theme()).toBe('classic'));
  });

  it('caches the applied theme for the next first paint', async () => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([makeProfile()]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ color_theme: 'midnight' });

    render(<ProfileProvider><ThemeProbe /></ProfileProvider>);

    await waitFor(() => expect(localStorage.getItem('prevue_color_theme')).toBe('midnight'));
  });
});
