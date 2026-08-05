import { RATING_SYSTEMS, normalizeRating } from '../data/ratingSystems.js';

/**
 * Look up the minimum recommended age for a rating code across every known
 * rating system. Returns null when the code is not recognized OR when the
 * code is recognized but has no defined minAge (e.g. "NR" / "Unrated").
 *
 * Fail-closed: a code with no minAge is NOT the same as "safe for everyone."
 * Jellyfin/Plex tag unrated content with codes like these routinely, and
 * treating an unknown minimum age as 0 would let unrated adult content pass
 * a kids ceiling. Callers must treat null the same as "unknown."
 */
export function getRatingMinAge(code: string): number | null {
  const normalized = normalizeRating(code).toUpperCase().trim();

  for (const system of RATING_SYSTEMS) {
    for (const category of system.categories) {
      for (const rating of category.ratings) {
        if (rating.code.toUpperCase().trim() === normalized) {
          return rating.minAge ?? null;
        }
      }
    }
  }

  return null;
}

/**
 * Whether an item's rating falls at or below a profile's ceiling.
 *
 * A null ceiling means unrestricted. When a ceiling is set, missing and
 * unrecognized ratings are blocked — a content ceiling must fail closed.
 */
export function isRatingWithinCeiling(
  itemRating: string | undefined | null,
  maxRating: string | null
): boolean {
  if (maxRating === null) return true;

  const ceilingAge = getRatingMinAge(maxRating);
  if (ceilingAge === null) return false;

  if (!itemRating || itemRating.trim() === '') return false;

  const itemAge = getRatingMinAge(itemRating);
  if (itemAge === null) return false;

  return itemAge <= ceilingAge;
}
