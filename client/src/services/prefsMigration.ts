import { getProfilePrefs, patchProfilePrefs } from './api';

const MIGRATED_FLAG = 'prevue_prefs_migrated';

/**
 * localStorage keys lifted into a profile's prefs blob, paired with how to
 * parse the stored string. The pref name is the localStorage key minus the
 * `prevue_` prefix.
 *
 * This list was verified against every `localStorage.getItem`/`setItem` call
 * in the client (see task-14-report.md for the full audit). Keys that are
 * inherently device-local (client id, active profile id, this migration
 * flag, playback volume/mute) are intentionally excluded.
 */
const MIGRATED_KEYS: readonly { key: string; type: 'string' | 'number' | 'boolean' | 'json' }[] = [
  { key: 'prevue_guide_hours', type: 'number' },
  { key: 'prevue_channel_count', type: 'number' },
  { key: 'prevue_visible_channels', type: 'number' },
  { key: 'prevue_color_theme', type: 'string' },
  { key: 'prevue_preview_style', type: 'string' },
  { key: 'prevue_clock_format', type: 'string' },
  { key: 'prevue_video_quality', type: 'string' },
  { key: 'prevue_video_fit', type: 'string' },
  { key: 'prevue_subtitle_index', type: 'string' },
  { key: 'prevue_auto_scroll', type: 'boolean' },
  { key: 'prevue_auto_scroll_speed', type: 'string' },
  { key: 'prevue_ticker_enabled', type: 'boolean' },
  { key: 'prevue_ticker_speed', type: 'string' },
  { key: 'prevue_promo_overlay', type: 'boolean' },
  { key: 'prevue_starting_soon', type: 'boolean' },
  { key: 'prevue_guide_colors_enabled', type: 'boolean' },
  { key: 'prevue_guide_color_movie', type: 'string' },
  { key: 'prevue_guide_color_episode', type: 'string' },
  { key: 'prevue_guide_ratings', type: 'boolean' },
  { key: 'prevue_guide_year', type: 'boolean' },
  { key: 'prevue_guide_resolution', type: 'boolean' },
  { key: 'prevue_guide_hdr', type: 'boolean' },
  { key: 'prevue_guide_artwork', type: 'boolean' },
  { key: 'prevue_guide_tomato', type: 'boolean' },
  { key: 'prevue_program_facts_enabled', type: 'boolean' },
  { key: 'prevue_iconic_scenes_enabled', type: 'boolean' },
  { key: 'prevue_hidden_gems_enabled', type: 'boolean' },
  { key: 'prevue_catch_up_enabled', type: 'boolean' },
  { key: 'prevue_sleep_enabled', type: 'boolean' },
  { key: 'prevue_sleep_preset', type: 'number' },
  { key: 'prevue_sleep_winddown_min', type: 'number' },
  { key: 'prevue_sleep_dim_sec', type: 'number' },
  { key: 'prevue_guide_filter', type: 'json' },
  { key: 'prevue_guide_dividers', type: 'json' },
  { key: 'prevue_channel_colors', type: 'json' },
  { key: 'prevue_preset_multipliers', type: 'json' },
  { key: 'prevue_audio_language', type: 'string' },
  { key: 'prevue_auto_tune', type: 'boolean' },
  { key: 'prevue_last_channel_number', type: 'number' },
  { key: 'prevue_last_channel_color', type: 'string' },
];

function parseStored(raw: string, type: 'string' | 'number' | 'boolean' | 'json'): unknown {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return raw === 'true';
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    default:
      return raw;
  }
}

/**
 * Copy this device's existing localStorage preferences into a profile once.
 *
 * Guarded by a flag so it never runs twice. First-migration-wins: a key
 * already present on the profile (set by an earlier migration on another
 * device, or by the user directly) is never overwritten by this device's
 * local value -- only keys the profile doesn't have yet are patched in.
 * Returns true only when a patch was actually sent.
 */
export async function migrateLocalPrefs(profileId: number): Promise<boolean> {
  try {
    if (localStorage.getItem(MIGRATED_FLAG) === '1') return false;
  } catch {
    return false;
  }

  const local: Record<string, unknown> = {};
  for (const { key, type } of MIGRATED_KEYS) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return false;
    }
    if (raw === null) continue;

    const value = parseStored(raw, type);
    if (value !== undefined) local[key.replace(/^prevue_/, '')] = value;
  }

  if (Object.keys(local).length === 0) {
    try {
      localStorage.setItem(MIGRATED_FLAG, '1');
    } catch { /* storage unavailable */ }
    return false;
  }

  let existing: Record<string, unknown>;
  try {
    existing = await getProfilePrefs(profileId);
  } catch (err) {
    // Leave the flag unset so the migration retries on the next launch.
    console.error('[Prevue] Preference migration failed:', err);
    return false;
  }

  const patch: Record<string, unknown> = {};
  for (const [prefKey, value] of Object.entries(local)) {
    if (!(prefKey in existing)) patch[prefKey] = value;
  }

  if (Object.keys(patch).length === 0) {
    try {
      localStorage.setItem(MIGRATED_FLAG, '1');
    } catch { /* storage unavailable */ }
    return false;
  }

  try {
    await patchProfilePrefs(profileId, patch);
  } catch (err) {
    // Leave the flag unset so the migration retries on the next launch.
    console.error('[Prevue] Preference migration failed:', err);
    return false;
  }

  try {
    localStorage.setItem(MIGRATED_FLAG, '1');
  } catch { /* storage unavailable */ }

  return true;
}
