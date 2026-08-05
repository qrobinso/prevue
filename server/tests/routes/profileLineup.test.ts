import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileRoutes } from '../../src/routes/profiles.js';
import * as queries from '../../src/db/queries.js';

function seedChannels(db: Database.Database): number[] {
  const insert = db.prepare(
    `INSERT INTO channels (number, name, type, sort_order) VALUES (?, ?, 'auto', ?)`
  );
  return [1, 2, 3].map(n => Number(insert.run(n, `Channel ${n}`, n - 1).lastInsertRowid));
}

describe('profile lineup API', () => {
  let app: Express;
  let db: Database.Database;
  let profileId: number;
  let channelIds: number[];

  beforeEach(() => {
    db = createTestDb();
    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.use('/api/profiles', profileRoutes);
    profileId = queries.createProfile(db, { name: 'Joey' }).id;
    channelIds = seedChannels(db);
  });

  it('returns an empty lineup when no overrides exist', async () => {
    const res = await request(app).get(`/api/profiles/${profileId}/lineup`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('stores and returns overrides', async () => {
    const res = await request(app)
      .put(`/api/profiles/${profileId}/lineup`)
      .send([{ channel_id: channelIds[0], hidden: true, sort_order: null }]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ channel_id: channelIds[0], hidden: true, sort_order: null }]);
  });

  it('replaces the whole override set on each PUT', async () => {
    await request(app)
      .put(`/api/profiles/${profileId}/lineup`)
      .send([{ channel_id: channelIds[0], hidden: true, sort_order: null }]);

    const res = await request(app)
      .put(`/api/profiles/${profileId}/lineup`)
      .send([{ channel_id: channelIds[1], hidden: true, sort_order: null }]);

    expect(res.body).toEqual([{ channel_id: channelIds[1], hidden: true, sort_order: null }]);
  });

  it('rejects a non-array body', async () => {
    const res = await request(app)
      .put(`/api/profiles/${profileId}/lineup`)
      .send({ channel_id: channelIds[0] });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a missing profile', async () => {
    const res = await request(app).get('/api/profiles/999/lineup');
    expect(res.status).toBe(404);
  });

  it('cascades override deletion when the profile is deleted', async () => {
    await request(app)
      .put(`/api/profiles/${profileId}/lineup`)
      .send([{ channel_id: channelIds[0], hidden: true, sort_order: null }]);
    queries.createProfile(db, { name: 'Other' });
    queries.deleteProfile(db, profileId);

    const rows = db
      .prepare('SELECT COUNT(*) as count FROM profile_channels WHERE profile_id = ?')
      .get(profileId) as { count: number };
    expect(rows.count).toBe(0);
  });

  it('cascades override deletion when the channel is deleted', async () => {
    await request(app)
      .put(`/api/profiles/${profileId}/lineup`)
      .send([{ channel_id: channelIds[0], hidden: true, sort_order: null }]);
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelIds[0]);

    expect(queries.getProfileLineup(db, profileId)).toEqual([]);
  });
});

describe('applyLineup', () => {
  const channels = [
    { id: 1, sort_order: 0 },
    { id: 2, sort_order: 1 },
    { id: 3, sort_order: 2 },
  ];

  it('returns the global lineup unchanged when there are no overrides', () => {
    expect(queries.applyLineup(channels, [])).toEqual(channels);
  });

  it('removes hidden channels', () => {
    const result = queries.applyLineup(channels, [
      { channel_id: 2, hidden: true, sort_order: null },
    ]);
    expect(result.map(c => c.id)).toEqual([1, 3]);
  });

  it('reorders by override sort_order, keeping un-overridden channels after', () => {
    const result = queries.applyLineup(channels, [
      { channel_id: 3, hidden: false, sort_order: 0 },
      { channel_id: 1, hidden: false, sort_order: 1 },
    ]);
    expect(result.map(c => c.id)).toEqual([3, 1, 2]);
  });

  it('ignores overrides for channels that no longer exist', () => {
    const result = queries.applyLineup(channels, [
      { channel_id: 99, hidden: true, sort_order: null },
    ]);
    expect(result.map(c => c.id)).toEqual([1, 2, 3]);
  });
});
