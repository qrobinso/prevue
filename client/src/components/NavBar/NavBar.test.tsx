import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NavBar from './NavBar';
import { ProfileProvider } from '../../contexts/ProfileContext';
import * as api from '../../services/api';
import type { Profile } from '../../types';

const JOEY: Profile = {
  id: 1,
  name: 'Joey',
  avatar_glyph: '',
  avatar_color: '#7c5cff',
  is_kids: false,
  max_rating: null,
  prefs: {},
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProfileProvider>
        <NavBar />
      </ProfileProvider>
    </MemoryRouter>
  );
}

describe('NavBar', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([JOEY]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders on the guide route', async () => {
    renderAt('/');
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /guide/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('shows the active profile name', async () => {
    renderAt('/');
    await waitFor(() => expect(screen.getByText('Joey')).toBeInTheDocument());
  });

  it('renders on the settings route', async () => {
    renderAt('/settings');
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
  });

  it('renders on the profile route', async () => {
    renderAt('/profile');
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
  });

  it('does not render on the player route', () => {
    renderAt('/channel/5');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('marks the current route as active', async () => {
    renderAt('/settings');
    const settingsLink = await screen.findByRole('link', { name: /settings/i });
    expect(settingsLink).toHaveAttribute('aria-current', 'page');
  });
});
