import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { migrateLocalPrefs } from './prefsMigration';
import * as api from './api';

describe('migrateLocalPrefs', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({});
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('lifts stored localStorage preferences into the profile', async () => {
    localStorage.setItem('prevue_guide_hours', '3');
    localStorage.setItem('prevue_color_theme', 'amber');

    const ran = await migrateLocalPrefs(1);

    expect(ran).toBe(true);
    expect(api.patchProfilePrefs).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ guide_hours: 3, color_theme: 'amber' })
    );
  });

  it('coerces boolean-valued keys', async () => {
    localStorage.setItem('prevue_ticker_enabled', 'false');
    await migrateLocalPrefs(1);
    expect(api.patchProfilePrefs).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ ticker_enabled: false })
    );
  });

  it('sets the guard flag', async () => {
    localStorage.setItem('prevue_guide_hours', '3');
    await migrateLocalPrefs(1);
    expect(localStorage.getItem('prevue_prefs_migrated')).toBe('1');
  });

  it('no-ops on a second run', async () => {
    localStorage.setItem('prevue_guide_hours', '3');
    await migrateLocalPrefs(1);
    const ran = await migrateLocalPrefs(1);

    expect(ran).toBe(false);
    expect(api.patchProfilePrefs).toHaveBeenCalledTimes(1);
  });

  it('marks itself done and skips the request when nothing is stored', async () => {
    const ran = await migrateLocalPrefs(1);
    expect(ran).toBe(false);
    expect(api.patchProfilePrefs).not.toHaveBeenCalled();
    expect(localStorage.getItem('prevue_prefs_migrated')).toBe('1');
  });

  it('does not set the guard flag when the request fails', async () => {
    vi.spyOn(api, 'patchProfilePrefs').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('prevue_guide_hours', '3');

    const ran = await migrateLocalPrefs(1);

    expect(ran).toBe(false);
    expect(localStorage.getItem('prevue_prefs_migrated')).toBeNull();
  });

  it('does not set the guard flag when fetching existing prefs fails', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('prevue_guide_hours', '3');

    const ran = await migrateLocalPrefs(1);

    expect(ran).toBe(false);
    expect(api.patchProfilePrefs).not.toHaveBeenCalled();
    expect(localStorage.getItem('prevue_prefs_migrated')).toBeNull();
  });

  it('skips malformed values instead of writing garbage', async () => {
    localStorage.setItem('prevue_guide_hours', 'not-a-number');
    localStorage.setItem('prevue_guide_dividers', '{not valid json');
    localStorage.setItem('prevue_color_theme', 'amber');

    await migrateLocalPrefs(1);

    const call = (api.patchProfilePrefs as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const patch = call[1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('guide_hours');
    expect(patch).not.toHaveProperty('guide_dividers');
    expect(patch.color_theme).toBe('amber');
  });

  it('does not overwrite a key already present on the profile', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ color_theme: 'graphite' });
    localStorage.setItem('prevue_color_theme', 'amber');

    const ran = await migrateLocalPrefs(1);

    expect(ran).toBe(false);
    expect(api.patchProfilePrefs).not.toHaveBeenCalled();
    expect(localStorage.getItem('prevue_prefs_migrated')).toBe('1');
  });

  it('migrates a key absent server-side', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({});
    localStorage.setItem('prevue_color_theme', 'amber');

    const ran = await migrateLocalPrefs(1);

    expect(ran).toBe(true);
    expect(api.patchProfilePrefs).toHaveBeenCalledWith(1, { color_theme: 'amber' });
  });

  it('patches only the keys absent server-side out of a mix', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ color_theme: 'graphite' });
    localStorage.setItem('prevue_color_theme', 'amber');
    localStorage.setItem('prevue_guide_hours', '3');

    const ran = await migrateLocalPrefs(1);

    expect(ran).toBe(true);
    expect(api.patchProfilePrefs).toHaveBeenCalledWith(1, { guide_hours: 3 });
  });

  it('sets the flag without a PATCH when everything is already present server-side', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ color_theme: 'graphite', guide_hours: 5 });
    localStorage.setItem('prevue_color_theme', 'amber');
    localStorage.setItem('prevue_guide_hours', '3');

    const ran = await migrateLocalPrefs(1);

    expect(ran).toBe(false);
    expect(api.patchProfilePrefs).not.toHaveBeenCalled();
    expect(localStorage.getItem('prevue_prefs_migrated')).toBe('1');
  });
});
