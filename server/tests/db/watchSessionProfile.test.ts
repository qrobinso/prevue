import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import * as queries from '../../src/db/queries.js';

describe('watch session profile attribution', () => {
  let db: Database.Database;
  let profileId: number;

  beforeEach(() => {
    db = createTestDb();
    profileId = queries.createProfile(db, { name: 'Joey' }).id;
  });

  it('records the profile id on a session', () => {
    const session = queries.createWatchSession(db, {
      client_id: 'client-1',
      profile_id: profileId,
      channel_id: 1,
      channel_name: 'Channel 1',
    });
    expect(session.profile_id).toBe(profileId);
  });

  it('stores null when no profile is supplied', () => {
    const session = queries.createWatchSession(db, { client_id: 'client-1' });
    expect(session.profile_id).toBeNull();
  });

  it('aggregates unattributed rows correctly in getTopChannels', () => {
    queries.createWatchSession(db, { client_id: 'a', channel_id: 1, channel_name: 'One' });
    queries.createWatchSession(db, {
      client_id: 'b',
      profile_id: profileId,
      channel_id: 1,
      channel_name: 'One',
    });

    const top = queries.getTopChannels(db, '1970-01-01T00:00:00.000Z', 10);
    expect(top).toHaveLength(1);
    expect(top[0].session_count).toBe(2);
  });
});
