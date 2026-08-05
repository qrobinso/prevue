import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProfilePage from './ProfilePage';
import * as api from '../../services/api';
import * as profileContext from '../../contexts/ProfileContext';
import { ProfileProvider } from '../../contexts/ProfileContext';
import type { Profile } from '../../types';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

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

const CHANDLER: Profile = {
  id: 2,
  name: 'Chandler',
  avatar_glyph: '',
  avatar_color: '#ff5c8a',
  is_kids: false,
  max_rating: null,
  prefs: {},
  sort_order: 1,
  created_at: '2026-01-01T00:00:00.000Z',
};

function mockUseProfile(overrides: Partial<ReturnType<typeof profileContext.useProfile>> = {}) {
  vi.spyOn(profileContext, 'useProfile').mockReturnValue({
    profiles: [JOEY, CHANDLER],
    activeProfile: JOEY,
    loading: false,
    prefs: {},
    setPref: vi.fn(),
    switchProfile: vi.fn().mockResolvedValue(undefined),
    refreshProfiles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

describe('ProfilePage', () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows a visible error when deleting a profile fails, outside the edit form', async () => {
    const user = userEvent.setup();
    mockUseProfile();
    vi.spyOn(api, 'deleteProfile').mockRejectedValue(new Error('Cannot delete the last profile'));

    render(<ProfilePage />);

    const deleteBtn = screen.getByRole('button', { name: /delete chandler/i });
    await user.click(deleteBtn);

    const message = await screen.findByText('Cannot delete the last profile');
    expect(message).toBeInTheDocument();
    // Not rendered inside the create/edit form (which isn't open here).
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('shows a visible error and does not navigate when switching profiles fails', async () => {
    const user = userEvent.setup();
    const switchProfile = vi.fn().mockRejectedValue(new Error('Failed to switch profile'));
    mockUseProfile({ switchProfile });

    render(<ProfilePage />);

    const card = screen.getByRole('button', { name: 'Chandler' });
    await user.click(card);

    await waitFor(() => expect(switchProfile).toHaveBeenCalledWith(2));
    expect(await screen.findByText('Failed to switch profile')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('navigates after a successful profile switch', async () => {
    const user = userEvent.setup();
    const switchProfile = vi.fn().mockResolvedValue(undefined);
    mockUseProfile({ switchProfile });

    render(<ProfilePage />);

    const card = screen.getByRole('button', { name: 'Chandler' });
    await user.click(card);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/'));
  });

  // Exercises the real ProfileProvider (not the useProfile mock above) so this
  // covers the actual switchProfile/refreshProfiles wiring, not just ProfilePage's
  // local error-handling logic. Only the api.ts boundary is mocked.
  it('clears a stale error once a later action succeeds', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getProfiles').mockResolvedValue([JOEY, CHANDLER]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({});
    vi.spyOn(api, 'deleteProfile').mockRejectedValue(new Error('Cannot delete the last profile'));

    render(
      <ProfileProvider>
        <ProfilePage />
      </ProfileProvider>
    );

    // Failing action: delete rejects, error becomes visible.
    const deleteBtn = await screen.findByRole('button', { name: /delete chandler/i });
    await user.click(deleteBtn);
    expect(await screen.findByText('Cannot delete the last profile')).toBeInTheDocument();

    // Succeeding action: switching profiles goes through the real switchProfile/
    // loadProfile path (no api rejection anywhere in it) and should clear the
    // stale error rather than leaving it displayed next to an unrelated success.
    const card = screen.getByRole('button', { name: 'Chandler' });
    await user.click(card);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('Cannot delete the last profile')).not.toBeInTheDocument();
  });
});
