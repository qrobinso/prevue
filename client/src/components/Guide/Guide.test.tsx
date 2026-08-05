import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Guide from './Guide';
import { NavigationProvider } from '../../navigation';
import { NotificationProvider } from '../../notifications';
import * as profileContext from '../../contexts/ProfileContext';
import * as scheduleHook from '../../hooks/useSchedule';
import * as api from '../../services/api';
import type { Profile } from '../../types';
import type { ChannelWithProgram } from '../../services/api';

// Guide pulls in a lot of heavy children (grid, preview, ticker, modals) that
// aren't relevant to header-button behaviour — stub them out.
vi.mock('./GuideGrid', () => ({ default: () => <div data-testid="guide-grid-stub" /> }));
vi.mock('./PreviewPanel', () => ({ default: () => <div data-testid="preview-panel-stub" /> }));
vi.mock('./Ticker', () => ({ default: () => null }));
vi.mock('./ChannelSearch', () => ({ default: () => null }));
vi.mock('./GuideFilter', () => ({ default: () => null }));
vi.mock('./AIFilterModal', () => ({ default: () => null }));
vi.mock('./ProgramInfoModal', () => ({ default: () => null }));

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

const CHANNEL: ChannelWithProgram = {
  id: 1,
  number: 1,
  name: 'Test Channel',
  type: 'auto',
  genre: null,
  preset_id: null,
  item_ids: ['1'],
  ai_prompt: null,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  current_program: null,
  next_program: null,
  schedule_generated_at: null,
  schedule_updated_at: null,
};

function mockUseProfile(overrides: Partial<ReturnType<typeof profileContext.useProfile>> = {}) {
  vi.spyOn(profileContext, 'useProfile').mockReturnValue({
    profiles: [JOEY],
    activeProfile: JOEY,
    loading: false,
    prefs: {},
    setPref: vi.fn(),
    switchProfile: vi.fn().mockResolvedValue(undefined),
    refreshProfiles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

function mockUseSchedule() {
  vi.spyOn(scheduleHook, 'useSchedule').mockReturnValue({
    channels: [CHANNEL],
    scheduleByChannel: new Map(),
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
}

function renderGuideAt(path: string, onOpenSettings: () => void = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NavigationProvider>
        <NotificationProvider>
          <Routes>
            <Route
              path="/"
              element={<Guide onTune={vi.fn()} onOpenSettings={onOpenSettings} />}
            />
            <Route path="/channel/:id" element={<div data-testid="player-route" />} />
          </Routes>
        </NotificationProvider>
      </NavigationProvider>
    </MemoryRouter>
  );
}

describe('Guide header — Profile / Settings buttons', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    mockUseProfile();
    mockUseSchedule();
    vi.spyOn(api, 'getAIStatus').mockResolvedValue({ available: false });
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders a Settings button that invokes onOpenSettings (App wires this to navigate to /settings)', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    renderGuideAt('/', onOpenSettings);

    const settingsBtn = await screen.findByRole('button', { name: /^settings$/i });
    await user.click(settingsBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('renders a Profile button exposing the active profile name in its accessible name', async () => {
    renderGuideAt('/');
    const profileBtn = await screen.findByRole('button', { name: /profile: joey/i });
    expect(profileBtn).toBeInTheDocument();
  });

  it('navigates to /profile when the Profile button is clicked', async () => {
    const user = userEvent.setup();
    renderGuideAt('/');

    const profileBtn = await screen.findByRole('button', { name: /profile: joey/i });
    await user.click(profileBtn);
    expect(navigateMock).toHaveBeenCalledWith('/profile');
  });

  it('renders a neutral placeholder instead of crashing when activeProfile is null', async () => {
    mockUseProfile({ activeProfile: null });
    renderGuideAt('/');

    const profileBtn = await screen.findByRole('button', { name: /^profile$/i });
    expect(profileBtn).toBeInTheDocument();
  });
});
