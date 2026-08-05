import { describe, it, expect } from 'vitest';
import { getRatingMinAge, isRatingWithinCeiling } from '../../src/utils/ratingCeiling.js';

describe('getRatingMinAge', () => {
  it('resolves a US TV rating', () => {
    expect(getRatingMinAge('TV-Y7')).toBe(7);
  });

  it('resolves a US movie rating', () => {
    expect(getRatingMinAge('PG-13')).toBe(13);
  });

  it('normalizes alias forms', () => {
    expect(getRatingMinAge('TVY7')).toBe(getRatingMinAge('TV-Y7'));
    expect(getRatingMinAge('Rated PG-13')).toBe(13);
  });

  it('returns null for an unknown code', () => {
    expect(getRatingMinAge('BANANA')).toBeNull();
  });
});

describe('isRatingWithinCeiling', () => {
  it('allows everything when no ceiling is set', () => {
    expect(isRatingWithinCeiling('TV-MA', null)).toBe(true);
    expect(isRatingWithinCeiling(undefined, null)).toBe(true);
    expect(isRatingWithinCeiling('BANANA', null)).toBe(true);
  });

  it('allows a rating below the ceiling', () => {
    expect(isRatingWithinCeiling('TV-Y', 'TV-Y7')).toBe(true);
  });

  it('allows a rating equal to the ceiling', () => {
    expect(isRatingWithinCeiling('TV-Y7', 'TV-Y7')).toBe(true);
  });

  it('blocks a rating above the ceiling', () => {
    expect(isRatingWithinCeiling('TV-MA', 'TV-Y7')).toBe(false);
    expect(isRatingWithinCeiling('R', 'PG')).toBe(false);
  });

  it('compares across systems by minimum age', () => {
    expect(isRatingWithinCeiling('G', 'TV-Y7')).toBe(true);
    expect(isRatingWithinCeiling('PG-13', 'TV-Y7')).toBe(false);
  });

  it('blocks a missing rating when a ceiling is set', () => {
    expect(isRatingWithinCeiling(undefined, 'TV-Y7')).toBe(false);
    expect(isRatingWithinCeiling(null, 'TV-Y7')).toBe(false);
    expect(isRatingWithinCeiling('', 'TV-Y7')).toBe(false);
    expect(isRatingWithinCeiling('   ', 'TV-Y7')).toBe(false);
  });

  it('blocks an unknown rating when a ceiling is set', () => {
    expect(isRatingWithinCeiling('BANANA', 'TV-Y7')).toBe(false);
  });

  it('blocks everything when the ceiling code itself is unknown', () => {
    expect(isRatingWithinCeiling('TV-Y', 'BANANA')).toBe(false);
  });
});
