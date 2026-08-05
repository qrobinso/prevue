import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import * as queries from '../../src/db/queries.js';

describe('profile queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates a profile with defaults', () => {
    const p = queries.createProfile(db, { name: 'Joey' });
    expect(p.id).toBeGreaterThan(0);
    expect(p.name).toBe('Joey');
    expect(p.is_kids).toBe(false);
    expect(p.max_rating).toBeNull();
    expect(p.prefs).toEqual({});
    expect(p.avatar_color).toBe('#7c5cff');
  });

  it('creates a kids profile with a rating ceiling', () => {
    const p = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' });
    expect(p.is_kids).toBe(true);
    expect(p.max_rating).toBe('TV-Y7');
  });

  it('lists profiles ordered by sort_order', () => {
    queries.createProfile(db, { name: 'First' });
    queries.createProfile(db, { name: 'Second' });
    const all = queries.getAllProfiles(db);
    expect(all.map(p => p.name)).toEqual(['First', 'Second']);
  });

  it('updates only the supplied fields', () => {
    const p = queries.createProfile(db, { name: 'Joey', avatar_color: '#ff0000' });
    const updated = queries.updateProfile(db, p.id, { name: 'Joseph' });
    expect(updated?.name).toBe('Joseph');
    expect(updated?.avatar_color).toBe('#ff0000');
  });

  it('returns undefined when updating a missing profile', () => {
    expect(queries.updateProfile(db, 999, { name: 'Nobody' })).toBeUndefined();
  });

  it('deletes a profile and reports success', () => {
    const p = queries.createProfile(db, { name: 'Temp' });
    expect(queries.deleteProfile(db, p.id)).toBe(true);
    expect(queries.getProfile(db, p.id)).toBeUndefined();
    expect(queries.deleteProfile(db, p.id)).toBe(false);
  });

  it('counts profiles', () => {
    expect(queries.countProfiles(db)).toBe(0);
    queries.createProfile(db, { name: 'A' });
    queries.createProfile(db, { name: 'B' });
    expect(queries.countProfiles(db)).toBe(2);
  });

  it('seeds exactly one Default profile on an empty database', () => {
    queries.ensureDefaultProfile(db);
    const all = queries.getAllProfiles(db);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Default');
    expect(all[0].is_kids).toBe(false);
  });

  it('is idempotent across repeated boots', () => {
    queries.ensureDefaultProfile(db);
    queries.ensureDefaultProfile(db);
    queries.ensureDefaultProfile(db);
    expect(queries.countProfiles(db)).toBe(1);
  });

  it('does not seed Default when profiles already exist', () => {
    queries.createProfile(db, { name: 'Joey' });
    queries.ensureDefaultProfile(db);
    expect(queries.getAllProfiles(db).map(p => p.name)).toEqual(['Joey']);
  });

  it('tolerates a malformed prefs blob by returning an empty object', () => {
    const p = queries.createProfile(db, { name: 'Broken' });
    db.prepare('UPDATE profiles SET prefs = ? WHERE id = ?').run('not json', p.id);
    expect(queries.getProfile(db, p.id)?.prefs).toEqual({});
  });
});
