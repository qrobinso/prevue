import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DisplaySettings from './DisplaySettings';
import { ProfileProvider } from '../../contexts/ProfileContext';
import * as api from '../../services/api';
import type { Profile } from '../../types';

const JOEY: Profile = {
  id: 1, name: 'Joey', avatar_glyph: '', avatar_color: '#7c5cff',
  is_kids: false, max_rating: null, prefs: {}, sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('DisplaySettings persistence', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([JOEY]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ guide_hours: 2 });
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
    vi.spyOn(api, 'getSettings').mockResolvedValue({});
    localStorage.setItem('prevue_prefs_migrated', '1');
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders the stored guide hours from the profile, not localStorage', async () => {
    localStorage.setItem('prevue_guide_hours', '4');
    render(<ProfileProvider><DisplaySettings panel="guide" /></ProfileProvider>);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Guide hours: 2' })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByRole('button', { name: 'Guide hours: 4' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('writes a changed preference to the profile', async () => {
    const user = userEvent.setup();
    render(<ProfileProvider><DisplaySettings panel="guide" /></ProfileProvider>);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Guide hours: 2' })).toHaveAttribute('aria-pressed', 'true'),
    );

    await user.click(screen.getByRole('button', { name: 'Guide hours: 3' }));

    await waitFor(() =>
      expect(api.patchProfilePrefs).toHaveBeenCalledWith(1, expect.objectContaining({ guide_hours: 3 })),
    );
  });
});
