import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { usePref } from './usePref';
import { ProfileProvider } from '../contexts/ProfileContext';
import * as api from '../services/api';
import type { Profile } from '../types';

const JOEY: Profile = {
  id: 1, name: 'Joey', avatar_glyph: '', avatar_color: '#7c5cff',
  is_kids: false, max_rating: null, prefs: {}, sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

function Probe() {
  const [hours, setHours] = usePref('guide_hours', 1);
  return (
    <div>
      <span data-testid="value">{String(hours)}</span>
      <button onClick={() => setHours(4)}>set</button>
    </div>
  );
}

function ArrayProbe() {
  const [filter] = usePref<string[]>('guide_filter', []);
  return <span data-testid="value">{JSON.stringify(filter)}</span>;
}

function ObjectProbe() {
  const [multipliers] = usePref<Record<string, number>>('preset_multipliers', {});
  return <span data-testid="value">{JSON.stringify(multipliers)}</span>;
}

describe('usePref', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([JOEY]);
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns the default before the prefs fetch resolves', () => {
    vi.spyOn(api, 'getProfilePrefs').mockReturnValue(new Promise(() => {}));
    render(<ProfileProvider><Probe /></ProfileProvider>);
    expect(screen.getByTestId('value')).toHaveTextContent('1');
  });

  it('returns the stored value once loaded', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ guide_hours: 3 });
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('3'));
  });

  it('returns the default when the key is absent', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ other_key: 9 });
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('1'));
  });

  it('returns the default when the stored value has the wrong type', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ guide_hours: 'four' });
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('1'));
  });

  it('updates optimistically when set', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ guide_hours: 3 });
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('3'));

    act(() => { screen.getByText('set').click(); });
    expect(screen.getByTestId('value')).toHaveTextContent('4');
  });

  it('returns the default when null is stored under an array default', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ guide_filter: null });
    render(<ProfileProvider><ArrayProbe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[]'));
  });

  it('returns the default when null is stored under an object default', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ preset_multipliers: null });
    render(<ProfileProvider><ObjectProbe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('{}'));
  });

  it('returns the default when an object is stored under an array default', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ guide_filter: { foo: 1 } });
    render(<ProfileProvider><ArrayProbe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[]'));
  });

  it('returns the default when an array is stored under an object default', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ preset_multipliers: ['a', 'b'] });
    render(<ProfileProvider><ObjectProbe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('{}'));
  });

  it('returns a correct array value as-is', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ guide_filter: ['action', 'comedy'] });
    render(<ProfileProvider><ArrayProbe /></ProfileProvider>);
    await waitFor(() =>
      expect(screen.getByTestId('value')).toHaveTextContent('["action","comedy"]')
    );
  });

  it('returns a correct object value as-is', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ preset_multipliers: { horror: 2 } });
    render(<ProfileProvider><ObjectProbe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('{"horror":2}'));
  });
});
