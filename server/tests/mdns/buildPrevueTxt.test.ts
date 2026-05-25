import { describe, it, expect } from 'vitest';
import { buildPrevueTxt } from '../../src/utils/mdns.js';

describe('buildPrevueTxt', () => {
  it('sets auth_required to "1" when auth is enabled', () => {
    const txt = buildPrevueTxt(true, '1.1.0');
    expect(txt.auth_required).toBe('1');
    expect(txt.version).toBe('1.1.0');
  });

  it('sets auth_required to "0" when auth is disabled', () => {
    const txt = buildPrevueTxt(false, '1.1.0');
    expect(txt.auth_required).toBe('0');
    expect(txt.version).toBe('1.1.0');
  });

  it('preserves arbitrary version strings', () => {
    expect(buildPrevueTxt(false, '2.0.0-beta').version).toBe('2.0.0-beta');
    expect(buildPrevueTxt(true, '0').version).toBe('0');
  });
});
