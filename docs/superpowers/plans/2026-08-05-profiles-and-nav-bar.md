# Profiles & Top Navigation Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-backed multi-user profiles (own preferences, channel lineup, watch history, optional kids rating ceiling) and a top navigation bar exposing Profile / Guide / Settings, with Settings and Profile as full-screen pages.

**Architecture:** Two SQLite tables (`profiles`, `profile_channels`) plus a nullable `watch_sessions.profile_id`. Per-profile preferences live in a single JSON blob column, merge-patched over a REST API. The active profile is device-local, sent as an `X-Profile-Id` header and resolved server-side with a fallback to the first profile. Channel lineup overrides and kids rating filtering are enforced on the server. On the client, a `ProfileContext` holds the active profile and its preferences; a `usePref` hook replaces ~40 `localStorage` call sites in phase 2.

**Tech Stack:** Express + TypeScript, better-sqlite3, Vitest + supertest (server), React 18 + react-router v7 (client), new: Vitest + @testing-library/react + jsdom (client).

**Spec:** `docs/superpowers/specs/2026-08-05-profiles-and-nav-bar-design.md`

## Global Constraints

- **Strict TypeScript.** No `any`, no `as` casts except where unavoidable. Existing test files use `as any` for mocks; new production code must not.
- **All DB access goes through `server/src/db/queries.ts`** using prepared statements with parameter binding. Never build SQL by string concatenation.
- **Schema lives in `runMigrations()` in `server/src/db/index.ts`.** There are no separate migration files. All statements are `CREATE TABLE IF NOT EXISTS` / additive `ALTER TABLE` guarded by a column check.
- **`server/tests/helpers/setup.ts` carries its own copy of the schema.** Any table added to `db/index.ts` must also be added there, or route tests will fail.
- **API responses** use the existing per-route convention: success returns the resource JSON directly, failure returns `res.status(N).json({ error: message })`.
- **Types are declared in `server/src/types/index.ts` first**, then mirrored by hand in `client/src/types/index.ts`. There is no codegen.
- **Routes are registered in `server/src/index.ts`** via `app.use('/api/profiles', profileRoutes)`.
- **Server module imports use the `.js` extension** (ESM): `import * as queries from '../db/queries.js'`.
- **The nav bar must never render on `/channel/:n`.** Nothing overlays fullscreen video.
- **Kids filtering is enforced server-side.** Client-side filtering alone is decoration.
- **Unknown or missing content rating is blocked for kids profiles.** Fail closed.
- **Never delete the last remaining profile.** Return HTTP 400.
- **Profile resolution never throws.** A missing, malformed, or deleted `X-Profile-Id` resolves to the first profile by `sort_order`.
- **Run `npm run test` from the repo root before every commit.**

---

## Phase 1 — Profiles Exist

Preferences still read from `localStorage` throughout phase 1. Each task below ends with a working, testable deliverable.

---

### Task 1: Profiles schema and core queries

**Files:**
- Modify: `server/src/db/index.ts` (inside `runMigrations`, after the `settings` table block near line 74)
- Modify: `server/src/db/queries.ts` (append)
- Modify: `server/src/types/index.ts` (append)
- Modify: `server/tests/helpers/setup.ts` (inside the `db.exec` schema string in `createTestDb`)
- Test: `server/tests/db/profiles.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `Profile` interface: `{ id: number; name: string; avatar_glyph: string; avatar_color: string; is_kids: number; max_rating: string | null; prefs: string; sort_order: number; created_at: string }`
  - `ProfileParsed` interface: same but `is_kids: boolean` and `prefs: Record<string, unknown>`
  - `queries.getAllProfiles(db): ProfileParsed[]`
  - `queries.getProfile(db, id: number): ProfileParsed | undefined`
  - `queries.createProfile(db, data: { name: string; avatar_glyph?: string; avatar_color?: string; is_kids?: boolean; max_rating?: string | null }): ProfileParsed`
  - `queries.updateProfile(db, id: number, data: { name?: string; avatar_glyph?: string; avatar_color?: string; is_kids?: boolean; max_rating?: string | null }): ProfileParsed | undefined`
  - `queries.deleteProfile(db, id: number): boolean`
  - `queries.countProfiles(db): number`
  - `queries.ensureDefaultProfile(db): void`

- [ ] **Step 1: Write the failing test**

Create `server/tests/db/profiles.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w server -- tests/db/profiles.test.ts`
Expected: FAIL — `queries.createProfile is not a function`.

- [ ] **Step 3: Add the schema**

In `server/src/db/index.ts`, inside the `db.exec(\`...\`)` template in `runMigrations`, directly after the `settings` table definition, add:

```sql
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatar_glyph TEXT NOT NULL DEFAULT '',
      avatar_color TEXT NOT NULL DEFAULT '#7c5cff',
      is_kids INTEGER NOT NULL DEFAULT 0,
      max_rating TEXT,
      prefs TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_channels (
      profile_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER,
      PRIMARY KEY (profile_id, channel_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );
```

Add the identical two statements to the `db.exec` schema string in `createTestDb` in `server/tests/helpers/setup.ts`. The test helper's `channels` table exists there already, so the foreign key resolves.

- [ ] **Step 4: Add the types**

Append to `server/src/types/index.ts`:

```ts
/** A profile row as stored in SQLite. */
export interface Profile {
  id: number;
  name: string;
  avatar_glyph: string;
  avatar_color: string;
  is_kids: number;
  max_rating: string | null;
  prefs: string;
  sort_order: number;
  created_at: string;
}

/** A profile with JSON/boolean columns deserialized. */
export interface ProfileParsed {
  id: number;
  name: string;
  avatar_glyph: string;
  avatar_color: string;
  is_kids: boolean;
  max_rating: string | null;
  prefs: Record<string, unknown>;
  sort_order: number;
  created_at: string;
}
```

- [ ] **Step 5: Implement the queries**

Append to `server/src/db/queries.ts` (the file already imports `Database` from `better-sqlite3`; add `Profile`/`ProfileParsed` to the existing type import from `../types/index.js`):

```ts
const DEFAULT_AVATAR_COLOR = '#7c5cff';

function parseProfile(row: Profile): ProfileParsed {
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.prefs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      prefs = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed blob: fall back to empty preferences rather than throwing.
  }
  return { ...row, is_kids: row.is_kids === 1, prefs };
}

export function getAllProfiles(db: Database.Database): ProfileParsed[] {
  const rows = db
    .prepare('SELECT * FROM profiles ORDER BY sort_order ASC, id ASC')
    .all() as Profile[];
  return rows.map(parseProfile);
}

export function getProfile(db: Database.Database, id: number): ProfileParsed | undefined {
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined;
  return row ? parseProfile(row) : undefined;
}

export function countProfiles(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM profiles').get() as { count: number };
  return row.count;
}

export function createProfile(
  db: Database.Database,
  data: {
    name: string;
    avatar_glyph?: string;
    avatar_color?: string;
    is_kids?: boolean;
    max_rating?: string | null;
  }
): ProfileParsed {
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM profiles')
    .get() as { max_order: number };

  const result = db
    .prepare(
      `INSERT INTO profiles (name, avatar_glyph, avatar_color, is_kids, max_rating, prefs, sort_order)
       VALUES (?, ?, ?, ?, ?, '{}', ?)`
    )
    .run(
      data.name,
      data.avatar_glyph ?? '',
      data.avatar_color ?? DEFAULT_AVATAR_COLOR,
      data.is_kids ? 1 : 0,
      data.max_rating ?? null,
      maxRow.max_order + 1
    );

  const created = getProfile(db, Number(result.lastInsertRowid));
  if (!created) throw new Error('Failed to create profile');
  return created;
}

export function updateProfile(
  db: Database.Database,
  id: number,
  data: {
    name?: string;
    avatar_glyph?: string;
    avatar_color?: string;
    is_kids?: boolean;
    max_rating?: string | null;
  }
): ProfileParsed | undefined {
  const existing = getProfile(db, id);
  if (!existing) return undefined;

  db.prepare(
    `UPDATE profiles
     SET name = ?, avatar_glyph = ?, avatar_color = ?, is_kids = ?, max_rating = ?
     WHERE id = ?`
  ).run(
    data.name ?? existing.name,
    data.avatar_glyph ?? existing.avatar_glyph,
    data.avatar_color ?? existing.avatar_color,
    (data.is_kids ?? existing.is_kids) ? 1 : 0,
    data.max_rating === undefined ? existing.max_rating : data.max_rating,
    id
  );

  return getProfile(db, id);
}

export function deleteProfile(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Seed a single "Default" profile when none exist. Safe to call on every boot. */
export function ensureDefaultProfile(db: Database.Database): void {
  if (countProfiles(db) > 0) return;
  createProfile(db, { name: 'Default' });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -w server -- tests/db/profiles.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Call the seed on boot**

In `server/src/index.ts`, immediately after the `initDatabase()` call, add:

```ts
queries.ensureDefaultProfile(db);
```

If `server/src/index.ts` does not already import queries, add `import * as queries from './db/queries.js';` at the top.

- [ ] **Step 8: Verify the full suite still passes**

Run: `npm run test`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add server/src/db/index.ts server/src/db/queries.ts server/src/types/index.ts server/src/index.ts server/tests/helpers/setup.ts server/tests/db/profiles.test.ts
git commit -m "feat(profiles): add profiles schema, queries, and Default seed"
```

---

### Task 2: Profiles CRUD API

**Files:**
- Create: `server/src/routes/profiles.ts`
- Modify: `server/src/index.ts` (route registration)
- Test: `server/tests/routes/profiles.test.ts` (create)

**Interfaces:**
- Consumes: `queries.getAllProfiles`, `getProfile`, `createProfile`, `updateProfile`, `deleteProfile`, `countProfiles` from Task 1.
- Produces: `export const profileRoutes: Router` handling `GET /`, `POST /`, `PUT /:id`, `DELETE /:id`. Responses return the profile JSON (`ProfileParsed`) directly; `GET /` returns an array.

- [ ] **Step 1: Write the failing test**

Create `server/tests/routes/profiles.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileRoutes } from '../../src/routes/profiles.js';

function createProfileApp(): { app: Express; db: Database.Database } {
  const db = createTestDb();
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/profiles', profileRoutes);
  return { app, db };
}

describe('profiles API', () => {
  let app: Express;

  beforeEach(() => {
    ({ app } = createProfileApp());
  });

  it('returns an empty list initially', async () => {
    const res = await request(app).get('/api/profiles');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('creates a profile', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Joey' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Joey');
    expect(res.body.is_kids).toBe(false);
  });

  it('rejects a profile with no name', async () => {
    const res = await request(app).post('/api/profiles').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  it('rejects a blank name', async () => {
    const res = await request(app).post('/api/profiles').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('updates a profile', async () => {
    const created = await request(app).post('/api/profiles').send({ name: 'Joey' });
    const res = await request(app)
      .put(`/api/profiles/${created.body.id}`)
      .send({ name: 'Joseph', is_kids: true, max_rating: 'TV-Y7' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Joseph');
    expect(res.body.is_kids).toBe(true);
    expect(res.body.max_rating).toBe('TV-Y7');
  });

  it('returns 404 when updating a missing profile', async () => {
    const res = await request(app).put('/api/profiles/999').send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('deletes a profile when others remain', async () => {
    await request(app).post('/api/profiles').send({ name: 'Keep' });
    const doomed = await request(app).post('/api/profiles').send({ name: 'Doomed' });
    const res = await request(app).delete(`/api/profiles/${doomed.body.id}`);
    expect(res.status).toBe(200);

    const list = await request(app).get('/api/profiles');
    expect(list.body.map((p: { name: string }) => p.name)).toEqual(['Keep']);
  });

  it('refuses to delete the last profile', async () => {
    const only = await request(app).post('/api/profiles').send({ name: 'Only' });
    const res = await request(app).delete(`/api/profiles/${only.body.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('last');

    const list = await request(app).get('/api/profiles');
    expect(list.body).toHaveLength(1);
  });

  it('returns 404 when deleting a missing profile', async () => {
    await request(app).post('/api/profiles').send({ name: 'A' });
    await request(app).post('/api/profiles').send({ name: 'B' });
    const res = await request(app).delete('/api/profiles/999');
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id', async () => {
    const res = await request(app).put('/api/profiles/abc').send({ name: 'X' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w server -- tests/routes/profiles.test.ts`
Expected: FAIL — cannot resolve `../../src/routes/profiles.js`.

- [ ] **Step 3: Implement the routes**

Create `server/src/routes/profiles.ts`:

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';

export const profileRoutes = Router();

/** Parse an :id path param, returning null when it is not a positive integer. */
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/profiles - List all profiles
profileRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    res.json(queries.getAllProfiles(db));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/profiles - Create a profile
profileRoutes.post('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const { name, avatar_glyph, avatar_color, is_kids, max_rating } = req.body;

    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const profile = queries.createProfile(db, {
      name: name.trim(),
      avatar_glyph: typeof avatar_glyph === 'string' ? avatar_glyph : undefined,
      avatar_color: typeof avatar_color === 'string' ? avatar_color : undefined,
      is_kids: is_kids === true,
      max_rating: typeof max_rating === 'string' ? max_rating : null,
    });

    res.status(201).json(profile);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/profiles/:id - Update a profile
profileRoutes.put('/:id', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }

    const { name, avatar_glyph, avatar_color, is_kids, max_rating } = req.body;
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }

    const updated = queries.updateProfile(db, id, {
      name: typeof name === 'string' ? name.trim() : undefined,
      avatar_glyph: typeof avatar_glyph === 'string' ? avatar_glyph : undefined,
      avatar_color: typeof avatar_color === 'string' ? avatar_color : undefined,
      is_kids: typeof is_kids === 'boolean' ? is_kids : undefined,
      max_rating:
        max_rating === undefined ? undefined : typeof max_rating === 'string' ? max_rating : null,
    });

    if (!updated) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/profiles/:id - Delete a profile (never the last one)
profileRoutes.delete('/:id', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }

    if (!queries.getProfile(db, id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    if (queries.countProfiles(db) <= 1) {
      res.status(400).json({ error: 'Cannot delete the last profile' });
      return;
    }

    queries.deleteProfile(db, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 4: Register the routes**

In `server/src/index.ts`, alongside the other `app.use('/api/...')` calls, add:

```ts
import { profileRoutes } from './routes/profiles.js';
// ...
app.use('/api/profiles', profileRoutes);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w server -- tests/routes/profiles.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/profiles.ts server/src/index.ts server/tests/routes/profiles.test.ts
git commit -m "feat(profiles): add profiles CRUD API"
```

---

### Task 3: Preferences merge-patch endpoints

**Files:**
- Modify: `server/src/db/queries.ts` (append)
- Modify: `server/src/routes/profiles.ts` (append routes)
- Test: `server/tests/routes/profilePrefs.test.ts` (create)

**Interfaces:**
- Consumes: `queries.getProfile`, `queries.createProfile` from Task 1; `profileRoutes` and `parseId` from Task 2.
- Produces:
  - `queries.getProfilePrefs(db, id: number): Record<string, unknown> | undefined`
  - `queries.patchProfilePrefs(db, id: number, patch: Record<string, unknown>): Record<string, unknown> | undefined`
  - `GET /api/profiles/:id/prefs` → the prefs object
  - `PUT /api/profiles/:id/prefs` → the merged prefs object

- [ ] **Step 1: Write the failing test**

Create `server/tests/routes/profilePrefs.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileRoutes } from '../../src/routes/profiles.js';
import * as queries from '../../src/db/queries.js';

describe('profile prefs API', () => {
  let app: Express;
  let db: Database.Database;
  let profileId: number;

  beforeEach(() => {
    db = createTestDb();
    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.use('/api/profiles', profileRoutes);
    profileId = queries.createProfile(db, { name: 'Joey' }).id;
  });

  it('starts with empty prefs', async () => {
    const res = await request(app).get(`/api/profiles/${profileId}/prefs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('merges supplied keys and preserves omitted ones', async () => {
    await request(app)
      .put(`/api/profiles/${profileId}/prefs`)
      .send({ guide_hours: 2, color_theme: 'amber' });

    const res = await request(app)
      .put(`/api/profiles/${profileId}/prefs`)
      .send({ guide_hours: 4 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ guide_hours: 4, color_theme: 'amber' });
  });

  it('passes unknown keys through without validation', async () => {
    const res = await request(app)
      .put(`/api/profiles/${profileId}/prefs`)
      .send({ some_future_pref: { nested: true } });
    expect(res.body.some_future_pref).toEqual({ nested: true });
  });

  it('persists prefs across requests', async () => {
    await request(app).put(`/api/profiles/${profileId}/prefs`).send({ ticker: false });
    const res = await request(app).get(`/api/profiles/${profileId}/prefs`);
    expect(res.body).toEqual({ ticker: false });
  });

  it('keeps prefs isolated between profiles', async () => {
    const other = queries.createProfile(db, { name: 'Other' }).id;
    await request(app).put(`/api/profiles/${profileId}/prefs`).send({ guide_hours: 3 });
    const res = await request(app).get(`/api/profiles/${other}/prefs`);
    expect(res.body).toEqual({});
  });

  it('tolerates a malformed stored blob', async () => {
    db.prepare('UPDATE profiles SET prefs = ? WHERE id = ?').run('{{{', profileId);
    const res = await request(app).get(`/api/profiles/${profileId}/prefs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('rejects a non-object patch body', async () => {
    const res = await request(app)
      .put(`/api/profiles/${profileId}/prefs`)
      .send(['not', 'an', 'object']);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a missing profile', async () => {
    const res = await request(app).get('/api/profiles/999/prefs');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w server -- tests/routes/profilePrefs.test.ts`
Expected: FAIL — 404 from an unregistered route.

- [ ] **Step 3: Implement the queries**

Append to `server/src/db/queries.ts`:

```ts
export function getProfilePrefs(
  db: Database.Database,
  id: number
): Record<string, unknown> | undefined {
  return getProfile(db, id)?.prefs;
}

/** Merge-patch a profile's prefs blob: supplied keys overwrite, omitted keys survive. */
export function patchProfilePrefs(
  db: Database.Database,
  id: number,
  patch: Record<string, unknown>
): Record<string, unknown> | undefined {
  const existing = getProfilePrefs(db, id);
  if (existing === undefined) return undefined;

  const merged = { ...existing, ...patch };
  db.prepare('UPDATE profiles SET prefs = ? WHERE id = ?').run(JSON.stringify(merged), id);
  return merged;
}
```

- [ ] **Step 4: Implement the routes**

Append to `server/src/routes/profiles.ts`:

```ts
// GET /api/profiles/:id/prefs - Read a profile's preference blob
profileRoutes.get('/:id/prefs', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }

    const prefs = queries.getProfilePrefs(db, id);
    if (prefs === undefined) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/profiles/:id/prefs - Merge-patch a profile's preference blob
profileRoutes.put('/:id/prefs', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }

    const patch: unknown = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      res.status(400).json({ error: 'Request body must be an object' });
      return;
    }

    const merged = queries.patchProfilePrefs(db, id, patch as Record<string, unknown>);
    if (merged === undefined) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w server -- tests/routes/profilePrefs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run test`

```bash
git add server/src/db/queries.ts server/src/routes/profiles.ts server/tests/routes/profilePrefs.test.ts
git commit -m "feat(profiles): add preference merge-patch endpoints"
```

---

### Task 4: Active profile resolution middleware

**Files:**
- Create: `server/src/middleware/profileResolver.ts`
- Modify: `server/src/index.ts` (mount before `/api` routes)
- Test: `server/tests/middleware/profileResolver.test.ts` (create)

**Interfaces:**
- Consumes: `queries.getProfile`, `queries.getAllProfiles` from Task 1.
- Produces:
  - `resolveProfile(req: Request, db: Database.Database): ProfileParsed | undefined` — pure resolution helper, exported for reuse by later tasks.
  - `profileResolver: RequestHandler` — Express middleware that assigns `req.activeProfile`.
  - Module augmentation adding `activeProfile?: ProfileParsed` to `Express.Request`.

Resolution order: `X-Profile-Id` header, then `?profile_id=` query param, then first profile by `sort_order`. Never throws, never 500s.

- [ ] **Step 1: Write the failing test**

Create `server/tests/middleware/profileResolver.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileResolver } from '../../src/middleware/profileResolver.js';
import * as queries from '../../src/db/queries.js';

function createApp(db: Database.Database): Express {
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use(profileResolver);
  app.get('/probe', (req, res) => {
    res.json({ id: req.activeProfile?.id ?? null, name: req.activeProfile?.name ?? null });
  });
  return app;
}

describe('profileResolver', () => {
  let db: Database.Database;
  let app: Express;
  let first: number;
  let second: number;

  beforeEach(() => {
    db = createTestDb();
    first = queries.createProfile(db, { name: 'First' }).id;
    second = queries.createProfile(db, { name: 'Second' }).id;
    app = createApp(db);
  });

  it('resolves the profile named by the X-Profile-Id header', async () => {
    const res = await request(app).get('/probe').set('X-Profile-Id', String(second));
    expect(res.body.id).toBe(second);
  });

  it('falls back to the first profile when the header is absent', async () => {
    const res = await request(app).get('/probe');
    expect(res.body.id).toBe(first);
  });

  it('falls back to the first profile when the header is malformed', async () => {
    const res = await request(app).get('/probe').set('X-Profile-Id', 'not-a-number');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first);
  });

  it('falls back to the first profile when the id refers to a deleted profile', async () => {
    queries.deleteProfile(db, second);
    const res = await request(app).get('/probe').set('X-Profile-Id', String(second));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first);
  });

  it('accepts a profile_id query param', async () => {
    const res = await request(app).get(`/probe?profile_id=${second}`);
    expect(res.body.id).toBe(second);
  });

  it('prefers the header over the query param', async () => {
    const res = await request(app).get(`/probe?profile_id=${first}`).set('X-Profile-Id', String(second));
    expect(res.body.id).toBe(second);
  });

  it('leaves activeProfile undefined when no profiles exist, without erroring', async () => {
    queries.deleteProfile(db, first);
    queries.deleteProfile(db, second);
    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
    expect(res.body.id).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w server -- tests/middleware/profileResolver.test.ts`
Expected: FAIL — cannot resolve `../../src/middleware/profileResolver.js`.

- [ ] **Step 3: Implement the middleware**

Create `server/src/middleware/profileResolver.ts`:

```ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type Database from 'better-sqlite3';
import * as queries from '../db/queries.js';
import type { ProfileParsed } from '../types/index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      activeProfile?: ProfileParsed;
    }
  }
}

/**
 * Resolve the caller's active profile.
 *
 * Order: X-Profile-Id header, then ?profile_id=, then the first profile by
 * sort_order. Returns undefined only when no profiles exist at all. This must
 * never throw — the app auto-tunes into video on launch and cannot block on
 * profile resolution.
 */
export function resolveProfile(
  req: Request,
  db: Database.Database
): ProfileParsed | undefined {
  const header = req.get('X-Profile-Id');
  const query = typeof req.query.profile_id === 'string' ? req.query.profile_id : undefined;
  const raw = header ?? query;

  if (raw !== undefined) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) {
      const profile = queries.getProfile(db, id);
      if (profile) return profile;
    }
  }

  return queries.getAllProfiles(db)[0];
}

export const profileResolver: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const { db } = req.app.locals;
    if (db) req.activeProfile = resolveProfile(req, db);
  } catch {
    // Resolution is best-effort; downstream handlers treat undefined as unrestricted.
  }
  next();
};
```

- [ ] **Step 4: Mount the middleware**

In `server/src/index.ts`, after `express.json()` and before the `app.use('/api/...')` route registrations:

```ts
import { profileResolver } from './middleware/profileResolver.js';
// ...
app.use('/api', profileResolver);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w server -- tests/middleware/profileResolver.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run test`

```bash
git add server/src/middleware/profileResolver.ts server/src/index.ts server/tests/middleware/profileResolver.test.ts
git commit -m "feat(profiles): resolve active profile from X-Profile-Id"
```

---

### Task 5: Per-profile channel lineup overrides

**Files:**
- Modify: `server/src/db/queries.ts` (append)
- Modify: `server/src/routes/profiles.ts` (append routes)
- Modify: `server/src/routes/channels.ts:116-138` (apply overrides in `GET /`)
- Test: `server/tests/routes/profileLineup.test.ts` (create)

**Interfaces:**
- Consumes: `queries.getProfile` (Task 1), `parseId` (Task 2), `req.activeProfile` (Task 4), existing `queries.getAllChannels`.
- Produces:
  - `LineupOverride` interface: `{ channel_id: number; hidden: boolean; sort_order: number | null }`
  - `queries.getProfileLineup(db, profileId: number): LineupOverride[]`
  - `queries.setProfileLineup(db, profileId: number, entries: LineupOverride[]): LineupOverride[]` — replaces all overrides for that profile in one transaction
  - `applyLineup<T extends { id: number; sort_order: number }>(channels: T[], overrides: LineupOverride[]): T[]` exported from `server/src/db/queries.ts`
  - `GET /api/profiles/:id/lineup`, `PUT /api/profiles/:id/lineup`

- [ ] **Step 1: Write the failing test**

Create `server/tests/routes/profileLineup.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w server -- tests/routes/profileLineup.test.ts`
Expected: FAIL — `queries.getProfileLineup is not a function`.

- [ ] **Step 3: Implement the queries**

Append to `server/src/db/queries.ts`:

```ts
export interface LineupOverride {
  channel_id: number;
  hidden: boolean;
  sort_order: number | null;
}

interface LineupRow {
  channel_id: number;
  hidden: number;
  sort_order: number | null;
}

export function getProfileLineup(db: Database.Database, profileId: number): LineupOverride[] {
  const rows = db
    .prepare(
      `SELECT channel_id, hidden, sort_order
       FROM profile_channels
       WHERE profile_id = ?
       ORDER BY sort_order IS NULL, sort_order ASC, channel_id ASC`
    )
    .all(profileId) as LineupRow[];

  return rows.map(r => ({
    channel_id: r.channel_id,
    hidden: r.hidden === 1,
    sort_order: r.sort_order,
  }));
}

/** Replace every lineup override for a profile in a single transaction. */
export function setProfileLineup(
  db: Database.Database,
  profileId: number,
  entries: LineupOverride[]
): LineupOverride[] {
  const clear = db.prepare('DELETE FROM profile_channels WHERE profile_id = ?');
  const insert = db.prepare(
    `INSERT INTO profile_channels (profile_id, channel_id, hidden, sort_order)
     VALUES (?, ?, ?, ?)`
  );

  db.transaction(() => {
    clear.run(profileId);
    for (const entry of entries) {
      insert.run(profileId, entry.channel_id, entry.hidden ? 1 : 0, entry.sort_order);
    }
  })();

  return getProfileLineup(db, profileId);
}

/**
 * Apply a profile's overrides to the global channel list: drop hidden channels,
 * then order overridden channels first by their override sort_order, with the
 * remainder following in their global order.
 */
export function applyLineup<T extends { id: number; sort_order: number }>(
  channels: T[],
  overrides: LineupOverride[]
): T[] {
  if (overrides.length === 0) return channels;

  const byChannel = new Map(overrides.map(o => [o.channel_id, o]));
  const visible = channels.filter(c => !byChannel.get(c.id)?.hidden);

  return [...visible].sort((a, b) => {
    const aOrder = byChannel.get(a.id)?.sort_order;
    const bOrder = byChannel.get(b.id)?.sort_order;
    if (aOrder != null && bOrder != null) return aOrder - bOrder;
    if (aOrder != null) return -1;
    if (bOrder != null) return 1;
    return a.sort_order - b.sort_order;
  });
}
```

- [ ] **Step 4: Implement the routes**

Append to `server/src/routes/profiles.ts`:

```ts
// GET /api/profiles/:id/lineup - Read a profile's channel lineup overrides
profileRoutes.get('/:id/lineup', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }
    if (!queries.getProfile(db, id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(queries.getProfileLineup(db, id));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/profiles/:id/lineup - Replace a profile's channel lineup overrides
profileRoutes.put('/:id/lineup', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }
    if (!queries.getProfile(db, id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    const body: unknown = req.body;
    if (!Array.isArray(body)) {
      res.status(400).json({ error: 'Request body must be an array of lineup entries' });
      return;
    }

    const entries: queries.LineupOverride[] = [];
    for (const raw of body) {
      if (!raw || typeof raw !== 'object') {
        res.status(400).json({ error: 'Each lineup entry must be an object' });
        return;
      }
      const entry = raw as { channel_id?: unknown; hidden?: unknown; sort_order?: unknown };
      if (!Number.isInteger(entry.channel_id)) {
        res.status(400).json({ error: 'Each lineup entry needs an integer channel_id' });
        return;
      }
      entries.push({
        channel_id: entry.channel_id as number,
        hidden: entry.hidden === true,
        sort_order: Number.isInteger(entry.sort_order) ? (entry.sort_order as number) : null,
      });
    }

    res.json(queries.setProfileLineup(db, id, entries));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 5: Apply overrides in the channel list**

In `server/src/routes/channels.ts`, replace the body of the `GET /` handler at lines 116-138 with:

```ts
channelRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine } = req.app.locals;
    const allChannels = queries.getAllChannels(db);
    const scheduleMeta = queries.getScheduleMetaForAllChannels(db);

    const profile = req.activeProfile;
    const channels = profile
      ? queries.applyLineup(allChannels, queries.getProfileLineup(db, profile.id))
      : allChannels;

    const result = channels.map(ch => {
      const current = (scheduleEngine as ScheduleEngine).getCurrentProgram(ch.id);
      const meta = scheduleMeta.get(ch.id);
      return {
        ...ch,
        current_program: current?.program || null,
        next_program: current?.next || null,
        schedule_generated_at: meta?.schedule_generated_at || null,
        schedule_updated_at: meta?.schedule_updated_at || null,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w server -- tests/routes/profileLineup.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm run test`
Expected: PASS — existing `api.test.ts` channel tests must still pass, since a request with no profile falls through unchanged.

```bash
git add server/src/db/queries.ts server/src/routes/profiles.ts server/src/routes/channels.ts server/tests/routes/profileLineup.test.ts
git commit -m "feat(profiles): per-profile channel lineup overrides"
```

---

### Task 6: Kids rating ceiling

**Files:**
- Create: `server/src/utils/ratingCeiling.ts`
- Modify: `server/src/routes/channels.ts` (`GET /` handler from Task 5)
- Modify: `server/src/routes/schedule.ts` (program list responses)
- Test: `server/tests/utils/ratingCeiling.test.ts` (create)

**Interfaces:**
- Consumes: `RATING_SYSTEMS`, `getRatingInfo`, `normalizeRating` from `server/src/data/ratingSystems.ts`; `req.activeProfile` from Task 4.
- Produces:
  - `getRatingMinAge(code: string): number | null` — searches every rating system for the normalized code, returns its `minAge`, or `null` when unknown.
  - `isRatingWithinCeiling(itemRating: string | undefined | null, maxRating: string | null): boolean` — `true` when unrestricted; `false` for unknown/missing item ratings when a ceiling is set.

- [ ] **Step 1: Write the failing test**

Create `server/tests/utils/ratingCeiling.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w server -- tests/utils/ratingCeiling.test.ts`
Expected: FAIL — cannot resolve `../../src/utils/ratingCeiling.js`.

- [ ] **Step 3: Implement the helper**

Create `server/src/utils/ratingCeiling.ts`:

```ts
import { RATING_SYSTEMS, normalizeRating } from '../data/ratingSystems.js';

/**
 * Look up the minimum recommended age for a rating code across every known
 * rating system. Returns null when the code is not recognized.
 */
export function getRatingMinAge(code: string): number | null {
  const normalized = normalizeRating(code).toUpperCase().trim();

  for (const system of RATING_SYSTEMS) {
    for (const category of system.categories) {
      for (const rating of category.ratings) {
        if (rating.code.toUpperCase().trim() === normalized) {
          return rating.minAge ?? 0;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w server -- tests/utils/ratingCeiling.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Apply the ceiling to programs in the channel list**

In `server/src/routes/channels.ts`, add the import:

```ts
import { isRatingWithinCeiling } from '../utils/ratingCeiling.js';
```

In the `GET /` handler written in Task 5, replace the `result` mapping with a version that nulls out programs above the ceiling and drops channels whose entire current/next pair is blocked:

```ts
    const ceiling = profile?.max_rating ?? null;

    const result = channels
      .map(ch => {
        const current = (scheduleEngine as ScheduleEngine).getCurrentProgram(ch.id);
        const meta = scheduleMeta.get(ch.id);

        const currentProgram = current?.program ?? null;
        const nextProgram = current?.next ?? null;
        const currentAllowed =
          currentProgram === null || isRatingWithinCeiling(currentProgram.rating, ceiling);
        const nextAllowed =
          nextProgram === null || isRatingWithinCeiling(nextProgram.rating, ceiling);

        return {
          ...ch,
          current_program: currentAllowed ? currentProgram : null,
          next_program: nextAllowed ? nextProgram : null,
          schedule_generated_at: meta?.schedule_generated_at || null,
          schedule_updated_at: meta?.schedule_updated_at || null,
          _blocked: ceiling !== null && !currentAllowed,
        };
      })
      .filter(ch => !ch._blocked)
      .map(({ _blocked, ...ch }) => ch);
```

If `ScheduleProgram` in `server/src/types/index.ts` has no `rating` field, add `rating?: string;` to it and populate it in `ScheduleEngine` from `item.OfficialRating` where programs are constructed. Search for the object literal that builds a program with `type: 'movie'` or `type: 'episode'` and add `rating: item.OfficialRating`.

- [ ] **Step 6: Apply the ceiling to the schedule route**

In `server/src/routes/schedule.ts`, add the same import and filter programs out of each returned block:

```ts
import { isRatingWithinCeiling } from '../utils/ratingCeiling.js';
```

In each handler that returns programs, before `res.json(...)`, map the programs through:

```ts
    const ceiling = req.activeProfile?.max_rating ?? null;
    const visible = programs.filter(p => isRatingWithinCeiling(p.rating, ceiling));
```

and return `visible` in place of `programs`.

- [ ] **Step 7: Write the integration test**

Append to `server/tests/routes/profileLineup.test.ts` a new describe block, or create `server/tests/routes/profileKids.test.ts` with the same `createProfileApp` shape used in Task 2, mounting `channelRoutes` and `profileResolver`, asserting:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileResolver } from '../../src/middleware/profileResolver.js';
import { channelRoutes } from '../../src/routes/channels.js';
import * as queries from '../../src/db/queries.js';

describe('kids rating ceiling on /api/channels', () => {
  let app: Express;
  let db: Database.Database;
  let kidsId: number;
  let adultId: number;

  beforeEach(() => {
    db = createTestDb();

    const insert = db.prepare(
      `INSERT INTO channels (number, name, type, sort_order) VALUES (?, ?, 'auto', ?)`
    );
    const kidsChannel = Number(insert.run(1, 'Cartoons', 0).lastInsertRowid);
    const adultChannel = Number(insert.run(2, 'Late Night', 1).lastInsertRowid);

    adultId = queries.createProfile(db, { name: 'Grown Up' }).id;
    kidsId = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' }).id;

    const scheduleEngine = {
      getCurrentProgram: (channelId: number) => ({
        program:
          channelId === kidsChannel
            ? { type: 'episode', rating: 'TV-Y', title: 'Cartoon' }
            : { type: 'movie', rating: 'TV-MA', title: 'Slasher' },
        next: null,
      }),
    };

    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.locals.scheduleEngine = scheduleEngine;
    app.use('/api', profileResolver);
    app.use('/api/channels', channelRoutes);
  });

  it('hides channels airing content above the ceiling', async () => {
    const res = await request(app).get('/api/channels').set('X-Profile-Id', String(kidsId));
    expect(res.status).toBe(200);
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(['Cartoons']);
  });

  it('leaves an unrestricted profile unaffected', async () => {
    const res = await request(app).get('/api/channels').set('X-Profile-Id', String(adultId));
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(['Cartoons', 'Late Night']);
  });

  it('blocks content with no rating for a kids profile', async () => {
    db.prepare('UPDATE channels SET name = ? WHERE number = 1').run('Unrated');
    const res = await request(app).get('/api/channels').set('X-Profile-Id', String(kidsId));
    expect(res.body).toHaveLength(1);
  });
});
```

- [ ] **Step 8: Run the tests and the full suite**

Run: `npm run test -w server -- tests/routes/profileKids.test.ts`
Expected: PASS, 3 tests.

Run: `npm run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/utils/ratingCeiling.ts server/src/routes/channels.ts server/src/routes/schedule.ts server/src/types/index.ts server/src/services/ScheduleEngine.ts server/tests/utils/ratingCeiling.test.ts server/tests/routes/profileKids.test.ts
git commit -m "feat(profiles): enforce kids rating ceiling server-side"
```

---

### Task 7: Watch history profile attribution

**Files:**
- Modify: `server/src/db/index.ts` (additive `ALTER TABLE`)
- Modify: `server/tests/helpers/setup.ts` (add `watch_sessions` with `profile_id`, if absent)
- Modify: `server/src/db/queries.ts:399-425` (`createWatchSession`)
- Modify: `server/src/routes/metrics.ts` (pass `req.activeProfile?.id`)
- Test: `server/tests/db/watchSessionProfile.test.ts` (create)

**Interfaces:**
- Consumes: `req.activeProfile` (Task 4), existing `queries.createWatchSession`, `queries.getTopChannels`.
- Produces: `createWatchSession` accepts an optional `profile_id?: number` field; `WatchSession` gains `profile_id: number | null`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/db/watchSessionProfile.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w server -- tests/db/watchSessionProfile.test.ts`
Expected: FAIL — `profile_id` is not a recognized property.

- [ ] **Step 3: Add the column**

In `server/src/db/index.ts`, after the `db.exec` schema block in `runMigrations`, add a guarded additive migration:

```ts
  // Additive: attribute watch sessions to a profile. Nullable so existing rows survive.
  const watchSessionCols = db
    .prepare("PRAGMA table_info(watch_sessions)")
    .all() as { name: string }[];
  if (!watchSessionCols.some(c => c.name === 'profile_id')) {
    db.exec('ALTER TABLE watch_sessions ADD COLUMN profile_id INTEGER');
  }
```

In `server/tests/helpers/setup.ts`, add a `watch_sessions` table to the schema string that already includes the column (the helper's schema is independent of the production migration):

```sql
    CREATE TABLE IF NOT EXISTS watch_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      profile_id INTEGER,
      channel_id INTEGER,
      channel_name TEXT,
      item_id TEXT,
      title TEXT,
      series_name TEXT,
      content_type TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      duration_seconds REAL DEFAULT 0,
      user_agent TEXT
    );
```

- [ ] **Step 4: Update the query**

In `server/src/db/queries.ts`, add `profile_id: number | null;` to the `WatchSession` interface (near line 395), then change `createWatchSession` to:

```ts
export function createWatchSession(
  db: Database.Database,
  data: {
    client_id: string;
    profile_id?: number;
    channel_id?: number;
    channel_name?: string;
    item_id?: string;
    title?: string;
    series_name?: string;
    content_type?: string;
    user_agent?: string;
  }
): WatchSession {
  const result = db.prepare(
    `INSERT INTO watch_sessions (client_id, profile_id, channel_id, channel_name, item_id, title, series_name, content_type, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.client_id,
    data.profile_id ?? null,
    data.channel_id ?? null,
    data.channel_name ?? null,
    data.item_id ?? null,
    data.title ?? null,
    data.series_name ?? null,
    data.content_type ?? null,
    data.user_agent ?? null
  );
  return db.prepare('SELECT * FROM watch_sessions WHERE id = ?').get(result.lastInsertRowid) as WatchSession;
}
```

- [ ] **Step 5: Pass the profile from the route**

In `server/src/routes/metrics.ts`, find every `queries.createWatchSession(db, { ... })` call and add `profile_id: req.activeProfile?.id,` to the object literal.

- [ ] **Step 6: Run the tests and the full suite**

Run: `npm run test -w server -- tests/db/watchSessionProfile.test.ts`
Expected: PASS, 3 tests.

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/index.ts server/src/db/queries.ts server/src/routes/metrics.ts server/tests/helpers/setup.ts server/tests/db/watchSessionProfile.test.ts
git commit -m "feat(profiles): attribute watch sessions to the active profile"
```

---

### Task 8: Client test infrastructure

**Files:**
- Modify: `client/package.json`
- Create: `client/vitest.config.ts`
- Create: `client/src/test/setup.ts`
- Modify: `package.json` (root `test` script)
- Test: `client/src/test/smoke.test.tsx` (create, then keep as the infra guard)

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm run test -w client` command; `npm run test` at the root runs server then client.

- [ ] **Step 1: Install the dependencies**

```bash
npm install -D -w client vitest@^3 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14 jsdom@^26
```

- [ ] **Step 2: Write the failing test**

Create `client/src/test/smoke.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

function Hello() {
  return <p>hello prevue</p>;
}

describe('client test infrastructure', () => {
  it('renders a component into jsdom', () => {
    render(<Hello />);
    expect(screen.getByText('hello prevue')).toBeInTheDocument();
  });

  it('exposes localStorage', () => {
    localStorage.setItem('probe', 'value');
    expect(localStorage.getItem('probe')).toBe('value');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — no `test` script in the client workspace.

- [ ] **Step 4: Add the config and setup file**

Create `client/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

Create `client/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
```

Add to `client/package.json` scripts:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

Change the root `package.json` scripts:

```json
    "test": "npm run test -w server && npm run test -w client",
    "test:watch": "npm run test:watch -w server",
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm run test -w client`
Expected: PASS, 2 tests.

Run: `npm run test`
Expected: PASS — both workspaces.

- [ ] **Step 6: Commit**

```bash
git add client/package.json client/vitest.config.ts client/src/test/setup.ts client/src/test/smoke.test.tsx package.json package-lock.json
git commit -m "test(client): add vitest, testing-library, and jsdom infrastructure"
```

---

### Task 9: Client profile types, API functions, and X-Profile-Id header

**Files:**
- Modify: `client/src/types/index.ts` (append)
- Modify: `client/src/services/api.ts` (header + new functions)
- Create: `client/src/services/activeProfile.ts`
- Test: `client/src/services/activeProfile.test.ts` (create)

**Interfaces:**
- Consumes: server routes from Tasks 2, 3, 5.
- Produces:
  - `client/src/types/index.ts`: `export interface Profile { id: number; name: string; avatar_glyph: string; avatar_color: string; is_kids: boolean; max_rating: string | null; prefs: Record<string, unknown>; sort_order: number; created_at: string }` and `export interface LineupOverride { channel_id: number; hidden: boolean; sort_order: number | null }`
  - `activeProfile.ts`: `getActiveProfileId(): number | null`, `setActiveProfileId(id: number | null): void`
  - `api.ts`: `getProfiles()`, `createProfile(data)`, `updateProfile(id, data)`, `deleteProfile(id)`, `getProfilePrefs(id)`, `patchProfilePrefs(id, patch)`, `getProfileLineup(id)`, `setProfileLineup(id, entries)`

- [ ] **Step 1: Write the failing test**

Create `client/src/services/activeProfile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getActiveProfileId, setActiveProfileId } from './activeProfile';

describe('activeProfile', () => {
  it('returns null when nothing is stored', () => {
    expect(getActiveProfileId()).toBeNull();
  });

  it('round-trips an id', () => {
    setActiveProfileId(7);
    expect(getActiveProfileId()).toBe(7);
  });

  it('clears the stored id', () => {
    setActiveProfileId(7);
    setActiveProfileId(null);
    expect(getActiveProfileId()).toBeNull();
  });

  it('returns null for a corrupt stored value', () => {
    localStorage.setItem('prevue_active_profile_id', 'not-a-number');
    expect(getActiveProfileId()).toBeNull();
  });

  it('returns null for a non-positive stored value', () => {
    localStorage.setItem('prevue_active_profile_id', '0');
    expect(getActiveProfileId()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — cannot resolve `./activeProfile`.

- [ ] **Step 3: Implement the storage module**

Create `client/src/services/activeProfile.ts`:

```ts
const ACTIVE_PROFILE_KEY = 'prevue_active_profile_id';

/** The device-local active profile id, or null when unset or unreadable. */
export function getActiveProfileId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY);
    if (!raw) return null;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Persist the device-local active profile id. Pass null to clear it. */
export function setActiveProfileId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROFILE_KEY);
    else localStorage.setItem(ACTIVE_PROFILE_KEY, String(id));
  } catch {
    // localStorage unavailable; the id is ephemeral for this session.
  }
}
```

- [ ] **Step 4: Send the header**

In `client/src/services/api.ts`, add the import and extend the header block in `requestOnce` (around line 70):

```ts
import { getActiveProfileId } from './activeProfile';
```

```ts
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }
    const profileId = getActiveProfileId();
    if (profileId !== null) {
      headers['X-Profile-Id'] = String(profileId);
    }
```

- [ ] **Step 5: Add the types and API functions**

Append to `client/src/types/index.ts`:

```ts
export interface Profile {
  id: number;
  name: string;
  avatar_glyph: string;
  avatar_color: string;
  is_kids: boolean;
  max_rating: string | null;
  prefs: Record<string, unknown>;
  sort_order: number;
  created_at: string;
}

export interface LineupOverride {
  channel_id: number;
  hidden: boolean;
  sort_order: number | null;
}
```

Append to `client/src/services/api.ts` (add `Profile` and `LineupOverride` to the existing type import from `../types`):

```ts
// ─── Profiles ─────────────────────────────────────────

export async function getProfiles(): Promise<Profile[]> {
  return request('/profiles');
}

export async function createProfile(data: {
  name: string;
  avatar_glyph?: string;
  avatar_color?: string;
  is_kids?: boolean;
  max_rating?: string | null;
}): Promise<Profile> {
  return request('/profiles', { method: 'POST', body: JSON.stringify(data) });
}

export async function updateProfile(
  id: number,
  data: {
    name?: string;
    avatar_glyph?: string;
    avatar_color?: string;
    is_kids?: boolean;
    max_rating?: string | null;
  }
): Promise<Profile> {
  return request(`/profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export async function deleteProfile(id: number): Promise<{ success: boolean }> {
  return request(`/profiles/${id}`, { method: 'DELETE' });
}

export async function getProfilePrefs(id: number): Promise<Record<string, unknown>> {
  return request(`/profiles/${id}/prefs`);
}

export async function patchProfilePrefs(
  id: number,
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return request(`/profiles/${id}/prefs`, { method: 'PUT', body: JSON.stringify(patch) });
}

export async function getProfileLineup(id: number): Promise<LineupOverride[]> {
  return request(`/profiles/${id}/lineup`);
}

export async function setProfileLineup(
  id: number,
  entries: LineupOverride[]
): Promise<LineupOverride[]> {
  return request(`/profiles/${id}/lineup`, { method: 'PUT', body: JSON.stringify(entries) });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w client`
Expected: PASS, 7 tests.

- [ ] **Step 7: Typecheck, run the full suite, and commit**

Run: `npm run build -w client`
Expected: no TypeScript errors.

Run: `npm run test`

```bash
git add client/src/types/index.ts client/src/services/api.ts client/src/services/activeProfile.ts client/src/services/activeProfile.test.ts
git commit -m "feat(profiles): client profile API and X-Profile-Id header"
```

---

### Task 10: ProfileContext

**Files:**
- Create: `client/src/contexts/ProfileContext.tsx`
- Modify: `client/src/App.tsx` (wrap `AppContent` in the provider)
- Test: `client/src/contexts/ProfileContext.test.tsx` (create)

**Interfaces:**
- Consumes: `getProfiles`, `getProfilePrefs`, `patchProfilePrefs` (Task 9); `getActiveProfileId`, `setActiveProfileId` (Task 9).
- Produces:
  - `ProfileProvider: React.FC<{ children: React.ReactNode }>`
  - `useProfile(): { profiles: Profile[]; activeProfile: Profile | null; loading: boolean; prefs: Record<string, unknown>; setPref: (key: string, value: unknown) => void; switchProfile: (id: number) => Promise<void>; refreshProfiles: () => Promise<void> }`

`setPref` applies optimistically to local state, then flushes to `patchProfilePrefs` on a 400 ms debounce. A failed flush logs via `console.error` and retains the local value.

- [ ] **Step 1: Write the failing test**

Create `client/src/contexts/ProfileContext.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ProfileProvider, useProfile } from './ProfileContext';
import * as api from '../services/api';
import type { Profile } from '../types';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    name: 'Joey',
    avatar_glyph: '',
    avatar_color: '#7c5cff',
    is_kids: false,
    max_rating: null,
    prefs: {},
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function Probe() {
  const { activeProfile, prefs, setPref, switchProfile, loading } = useProfile();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="name">{activeProfile?.name ?? 'none'}</span>
      <span data-testid="hours">{String(prefs.guide_hours ?? 'unset')}</span>
      <button onClick={() => setPref('guide_hours', 4)}>set</button>
      <button onClick={() => void switchProfile(2)}>switch</button>
    </div>
  );
}

describe('ProfileContext', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'getProfiles').mockResolvedValue([
      makeProfile(),
      makeProfile({ id: 2, name: 'Kid', is_kids: true, max_rating: 'TV-Y7', sort_order: 1 }),
    ]);
    vi.spyOn(api, 'getProfilePrefs').mockImplementation(async (id: number) =>
      id === 1 ? { guide_hours: 2 } : { guide_hours: 1 }
    );
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads the first profile when none is stored', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Joey'));
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  it('loads the stored active profile', async () => {
    localStorage.setItem('prevue_active_profile_id', '2');
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Kid'));
  });

  it('exposes the loaded prefs', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));
  });

  it('applies setPref optimistically before the request lands', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));

    act(() => { screen.getByText('set').click(); });
    expect(screen.getByTestId('hours')).toHaveTextContent('4');
    expect(api.patchProfilePrefs).not.toHaveBeenCalled();
  });

  it('debounces the write and sends it once', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));

    act(() => {
      screen.getByText('set').click();
      screen.getByText('set').click();
      screen.getByText('set').click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(api.patchProfilePrefs).toHaveBeenCalledTimes(1);
    expect(api.patchProfilePrefs).toHaveBeenCalledWith(1, { guide_hours: 4 });
  });

  it('retains the local value when the write fails', async () => {
    vi.spyOn(api, 'patchProfilePrefs').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('hours')).toHaveTextContent('2'));

    act(() => { screen.getByText('set').click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(screen.getByTestId('hours')).toHaveTextContent('4');
  });

  it('swaps prefs and persists the id when switching profile', async () => {
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Joey'));

    await act(async () => { screen.getByText('switch').click(); });

    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Kid'));
    expect(screen.getByTestId('hours')).toHaveTextContent('1');
    expect(localStorage.getItem('prevue_active_profile_id')).toBe('2');
  });

  it('falls back to the first profile when the stored id no longer exists', async () => {
    localStorage.setItem('prevue_active_profile_id', '999');
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Joey'));
  });

  it('does not block rendering when the profile fetch fails', async () => {
    vi.spyOn(api, 'getProfiles').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('name')).toHaveTextContent('none');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — cannot resolve `./ProfileContext`.

- [ ] **Step 3: Implement the context**

Create `client/src/contexts/ProfileContext.tsx`:

```tsx
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  getProfiles as apiGetProfiles,
  getProfilePrefs as apiGetProfilePrefs,
  patchProfilePrefs as apiPatchProfilePrefs,
} from '../services/api';
import { getActiveProfileId, setActiveProfileId } from '../services/activeProfile';
import type { Profile } from '../types';

const FLUSH_DEBOUNCE_MS = 400;

interface ProfileContextValue {
  profiles: Profile[];
  activeProfile: Profile | null;
  loading: boolean;
  prefs: Record<string, unknown>;
  setPref: (key: string, value: unknown) => void;
  switchProfile: (id: number) => Promise<void>;
  refreshProfiles: () => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [prefs, setPrefs] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);

  // Keys changed since the last flush, plus the pending timer.
  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIdRef = useRef<number | null>(null);

  activeIdRef.current = activeProfile?.id ?? null;

  const flush = useCallback(() => {
    const id = activeIdRef.current;
    const patch = pendingRef.current;
    pendingRef.current = {};
    if (id === null || Object.keys(patch).length === 0) return;

    apiPatchProfilePrefs(id, patch).catch((err) => {
      // Keep the optimistic local value; the user's change is not reverted under them.
      console.error('[Prevue] Failed to save preferences:', err);
    });
  }, []);

  const setPref = useCallback((key: string, value: unknown) => {
    setPrefs(prev => ({ ...prev, [key]: value }));
    pendingRef.current[key] = value;

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, FLUSH_DEBOUNCE_MS);
  }, [flush]);

  const loadProfile = useCallback(async (profile: Profile) => {
    setActiveProfile(profile);
    setActiveProfileId(profile.id);
    try {
      setPrefs(await apiGetProfilePrefs(profile.id));
    } catch (err) {
      console.error('[Prevue] Failed to load preferences:', err);
      setPrefs({});
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    const list = await apiGetProfiles();
    setProfiles(list);
  }, []);

  const switchProfile = useCallback(async (id: number) => {
    const target = profiles.find(p => p.id === id);
    if (!target) return;
    await loadProfile(target);
  }, [profiles, loadProfile]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const list = await apiGetProfiles();
        if (cancelled) return;
        setProfiles(list);

        const storedId = getActiveProfileId();
        const target = list.find(p => p.id === storedId) ?? list[0];
        if (target) await loadProfile(target);
      } catch (err) {
        console.error('[Prevue] Failed to load profiles:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [loadProfile]);

  // Flush any pending preference writes on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    flush();
  }, [flush]);

  return (
    <ProfileContext.Provider
      value={{ profiles, activeProfile, loading, prefs, setPref, switchProfile, refreshProfiles }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within a ProfileProvider');
  return ctx;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w client`
Expected: PASS, 9 ProfileContext tests.

- [ ] **Step 5: Wrap the app**

In `client/src/App.tsx`, import the provider and place it inside `NotificationProvider` and outside `AppContent`:

```tsx
import { ProfileProvider } from './contexts/ProfileContext';
```

```tsx
        <ProfileProvider>
          <AppContent />
        </ProfileProvider>
```

- [ ] **Step 6: Typecheck, run the full suite, and commit**

Run: `npm run build -w client`
Run: `npm run test`

```bash
git add client/src/contexts/ProfileContext.tsx client/src/contexts/ProfileContext.test.tsx client/src/App.tsx
git commit -m "feat(profiles): add ProfileContext with optimistic debounced prefs"
```

---

### Task 11: NavBar and routed Settings / Profile pages

**Files:**
- Create: `client/src/components/NavBar/NavBar.tsx`
- Create: `client/src/components/NavBar/NavBar.css`
- Create: `client/src/components/Profile/ProfilePage.tsx`
- Create: `client/src/components/Profile/ProfilePage.css`
- Modify: `client/src/App.tsx` (routes, remove `settingsOpen` state)
- Modify: `client/src/components/Guide/Guide.tsx:850-856` (remove the gear button and the `Settings` modal renders at lines 764-765, 781-782, 970-971)
- Modify: `client/src/components/Settings/Settings.tsx` (accept navigation-based close)
- Test: `client/src/components/NavBar/NavBar.test.tsx` (create)

**Interfaces:**
- Consumes: `useProfile` (Task 10).
- Produces:
  - `NavBar: React.FC` — renders three pills (`Profile` / `Guide` / `Settings`); returns `null` on `/channel/:n`.
  - `ProfilePage: React.FC` — profile grid plus a Manage section.
  - `Avatar: React.FC<{ profile: Profile; size?: number }>` exported from `client/src/components/Profile/ProfilePage.tsx`, rendering the monogram on `avatar_color`.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/NavBar/NavBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NavBar from './NavBar';
import { ProfileProvider } from '../../contexts/ProfileContext';
import * as api from '../../services/api';
import type { Profile } from '../../types';

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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProfileProvider>
        <NavBar />
      </ProfileProvider>
    </MemoryRouter>
  );
}

describe('NavBar', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([JOEY]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders on the guide route', async () => {
    renderAt('/');
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /guide/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('shows the active profile name', async () => {
    renderAt('/');
    await waitFor(() => expect(screen.getByText('Joey')).toBeInTheDocument());
  });

  it('renders on the settings route', async () => {
    renderAt('/settings');
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
  });

  it('renders on the profile route', async () => {
    renderAt('/profile');
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
  });

  it('does not render on the player route', () => {
    renderAt('/channel/5');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('marks the current route as active', async () => {
    renderAt('/settings');
    const settingsLink = await screen.findByRole('link', { name: /settings/i });
    expect(settingsLink).toHaveAttribute('aria-current', 'page');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — cannot resolve `./NavBar`.

- [ ] **Step 3: Implement the NavBar**

Create `client/src/components/NavBar/NavBar.tsx`:

```tsx
import { Link, useLocation } from 'react-router-dom';
import { Television, GearSix } from '@phosphor-icons/react';
import { useProfile } from '../../contexts/ProfileContext';
import { Avatar } from '../Profile/ProfilePage';
import './NavBar.css';

/**
 * The floating pill bar above the guide preview: Profile / Guide / Settings.
 * Never rendered over fullscreen video.
 */
export default function NavBar() {
  const location = useLocation();
  const { activeProfile } = useProfile();

  if (/^\/channel\/\d+$/.test(location.pathname)) return null;

  const path = location.pathname;
  const current = (target: string) => (path === target ? 'page' : undefined);

  return (
    <nav className="navbar" aria-label="Main">
      <Link
        to="/profile"
        className={`navbar-pill ${path === '/profile' ? 'navbar-pill-active' : ''}`}
        aria-current={current('/profile')}
      >
        {activeProfile && <Avatar profile={activeProfile} size={20} />}
        <span>{activeProfile?.name ?? 'Profile'}</span>
      </Link>

      <Link
        to="/"
        className={`navbar-pill ${path === '/' ? 'navbar-pill-active' : ''}`}
        aria-current={current('/')}
      >
        <Television size={16} weight="bold" />
        <span>Guide</span>
      </Link>

      <Link
        to="/settings"
        className={`navbar-pill ${path === '/settings' ? 'navbar-pill-active' : ''}`}
        aria-current={current('/settings')}
      >
        <GearSix size={16} weight="bold" />
        <span>Settings</span>
      </Link>
    </nav>
  );
}
```

Create `client/src/components/NavBar/NavBar.css`:

```css
.navbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(20, 20, 24, 0.85);
  backdrop-filter: blur(12px);
}

.navbar-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  transition: background 120ms ease, color 120ms ease;
}

.navbar-pill:hover,
.navbar-pill:focus-visible {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}

.navbar-pill-active {
  color: #111;
  background: #fff;
}

.navbar-pill-active:hover,
.navbar-pill-active:focus-visible {
  color: #111;
  background: #fff;
}
```

- [ ] **Step 4: Implement the Profile page and Avatar**

Create `client/src/components/Profile/ProfilePage.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash, PencilSimple } from '@phosphor-icons/react';
import { useProfile } from '../../contexts/ProfileContext';
import {
  createProfile as apiCreateProfile,
  updateProfile as apiUpdateProfile,
  deleteProfile as apiDeleteProfile,
} from '../../services/api';
import type { Profile } from '../../types';
import './ProfilePage.css';

const AVATAR_COLORS = [
  '#7c5cff', '#ff5c8a', '#22c5a8', '#f5a524',
  '#4c8dff', '#e0554f', '#8bc34a', '#b06cd8',
];

const KIDS_RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'G', 'TV-PG', 'PG'];

/** A profile's monogram rendered on its accent color. */
export function Avatar({ profile, size = 48 }: { profile: Profile; size?: number }) {
  const initial = profile.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className="profile-avatar"
      style={{
        width: size,
        height: size,
        background: profile.avatar_color,
        fontSize: Math.round(size * 0.45),
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const { profiles, activeProfile, switchProfile, refreshProfiles } = useProfile();

  const [editing, setEditing] = useState<Profile | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(AVATAR_COLORS[0]);
  const [isKids, setIsKids] = useState(false);
  const [maxRating, setMaxRating] = useState<string>(KIDS_RATINGS[1]);
  const [error, setError] = useState<string | null>(null);

  const startCreate = () => {
    setEditing(null);
    setCreating(true);
    setName('');
    setColor(AVATAR_COLORS[0]);
    setIsKids(false);
    setMaxRating(KIDS_RATINGS[1]);
    setError(null);
  };

  const startEdit = (profile: Profile) => {
    setCreating(false);
    setEditing(profile);
    setName(profile.name);
    setColor(profile.avatar_color);
    setIsKids(profile.is_kids);
    setMaxRating(profile.max_rating ?? KIDS_RATINGS[1]);
    setError(null);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
    setError(null);
  };

  const save = async () => {
    if (name.trim() === '') {
      setError('Name is required');
      return;
    }

    const payload = {
      name: name.trim(),
      avatar_color: color,
      is_kids: isKids,
      max_rating: isKids ? maxRating : null,
    };

    try {
      if (editing) await apiUpdateProfile(editing.id, payload);
      else await apiCreateProfile(payload);
      await refreshProfiles();
      closeForm();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (profile: Profile) => {
    try {
      await apiDeleteProfile(profile.id);
      await refreshProfiles();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const select = async (profile: Profile) => {
    await switchProfile(profile.id);
    navigate('/');
  };

  return (
    <div className="profile-page">
      <h1 className="profile-page-title">Who's watching?</h1>

      <div className="profile-grid">
        {profiles.map(profile => (
          <button
            key={profile.id}
            className={`profile-card ${profile.id === activeProfile?.id ? 'profile-card-active' : ''}`}
            onClick={() => void select(profile)}
          >
            <Avatar profile={profile} size={72} />
            <span className="profile-card-name">{profile.name}</span>
            {profile.is_kids && <span className="profile-card-badge">KIDS</span>}
          </button>
        ))}
      </div>

      <section className="profile-manage">
        <div className="profile-manage-header">
          <h2>Manage profiles</h2>
          <button className="profile-btn" onClick={startCreate}>
            <Plus size={16} weight="bold" /> Add profile
          </button>
        </div>

        <ul className="profile-manage-list">
          {profiles.map(profile => (
            <li key={profile.id} className="profile-manage-row">
              <Avatar profile={profile} size={32} />
              <span className="profile-manage-name">{profile.name}</span>
              {profile.is_kids && (
                <span className="profile-manage-rating">up to {profile.max_rating}</span>
              )}
              <button
                className="profile-btn"
                onClick={() => startEdit(profile)}
                aria-label={`Edit ${profile.name}`}
              >
                <PencilSimple size={16} weight="bold" />
              </button>
              <button
                className="profile-btn profile-btn-danger"
                onClick={() => void remove(profile)}
                disabled={profiles.length <= 1}
                aria-label={`Delete ${profile.name}`}
                title={profiles.length <= 1 ? 'Cannot delete the last profile' : 'Delete profile'}
              >
                <Trash size={16} weight="bold" />
              </button>
            </li>
          ))}
        </ul>

        {(creating || editing) && (
          <div className="profile-form">
            <label className="profile-form-field">
              <span>Name</span>
              <input value={name} onChange={e => setName(e.target.value)} maxLength={40} />
            </label>

            <div className="profile-form-field">
              <span>Color</span>
              <div className="profile-color-row">
                {AVATAR_COLORS.map(c => (
                  <button
                    key={c}
                    className={`profile-color ${c === color ? 'profile-color-active' : ''}`}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
            </div>

            <label className="profile-form-field profile-form-inline">
              <input type="checkbox" checked={isKids} onChange={e => setIsKids(e.target.checked)} />
              <span>Kids profile</span>
            </label>

            {isKids && (
              <label className="profile-form-field">
                <span>Maximum rating</span>
                <select value={maxRating} onChange={e => setMaxRating(e.target.value)}>
                  {KIDS_RATINGS.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
            )}

            {error && <p className="profile-form-error">{error}</p>}

            <div className="profile-form-actions">
              <button className="profile-btn" onClick={closeForm}>Cancel</button>
              <button className="profile-btn profile-btn-primary" onClick={() => void save()}>
                Save
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
```

Create `client/src/components/Profile/ProfilePage.css`:

```css
.profile-page { padding: 32px; color: #fff; }
.profile-page-title { font-size: 24px; margin-bottom: 24px; }
.profile-grid { display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 48px; }

.profile-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  font-weight: 700;
  flex-shrink: 0;
}

.profile-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: none;
  border: 2px solid transparent;
  border-radius: 12px;
  color: inherit;
  cursor: pointer;
}
.profile-card:hover, .profile-card:focus-visible { border-color: rgba(255,255,255,0.3); }
.profile-card-active { border-color: #fff; }
.profile-card-name { font-size: 14px; font-weight: 600; }
.profile-card-badge { font-size: 10px; letter-spacing: 0.08em; opacity: 0.7; }

.profile-manage { max-width: 640px; }
.profile-manage-header { display: flex; align-items: center; justify-content: space-between; }
.profile-manage-list { list-style: none; padding: 0; margin: 16px 0; }
.profile-manage-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
.profile-manage-name { flex: 1; font-weight: 600; }
.profile-manage-rating { font-size: 12px; opacity: 0.6; }

.profile-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(255,255,255,0.06);
  color: #fff; font-size: 13px; cursor: pointer;
}
.profile-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.profile-btn-primary { background: #fff; color: #111; }
.profile-btn-danger:hover:not(:disabled) { background: rgba(224,85,79,0.25); }

.profile-form { display: flex; flex-direction: column; gap: 16px; margin-top: 24px; }
.profile-form-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.profile-form-inline { flex-direction: row; align-items: center; gap: 8px; }
.profile-form-field input[type="text"],
.profile-form-field input:not([type]),
.profile-form-field select {
  padding: 8px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(0,0,0,0.3); color: #fff;
}
.profile-color-row { display: flex; gap: 8px; }
.profile-color { width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.profile-color-active { border-color: #fff; }
.profile-form-error { color: #ff8a80; font-size: 13px; }
.profile-form-actions { display: flex; gap: 8px; }
```

- [ ] **Step 5: Run the NavBar tests**

Run: `npm run test -w client`
Expected: PASS, 6 NavBar tests.

- [ ] **Step 6: Wire the routes**

In `client/src/App.tsx`:

1. Import `Routes`, `Route` from `react-router-dom`, plus `NavBar` and `ProfilePage`.
2. Delete the `settingsOpen` state (line 64) and the `settingsOpen` prop passed to `Guide` (line 325).
3. Render `<NavBar />` in the app shell above the guide, and add the routes:

```tsx
      <NavBar />
      <Routes>
        <Route path="/settings" element={<Settings onClose={() => navigate('/')} sleepState={sleepState} sleepActions={sleepActions} />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={null} />
      </Routes>
```

The guide stays always-mounted below, as it is today; the `/settings` and `/profile` routes render over it.

4. Change `onOpenSettings` (passed to `Guide`) to `() => navigate('/settings')`, so the existing error-state and empty-state buttons in `Guide.tsx` still work.

- [ ] **Step 7: Remove the modal wiring from Guide**

In `client/src/components/Guide/Guide.tsx`:
- Delete the `guide-settings-btn` block at lines 850-856 and the now-unused `GearSix` import.
- Delete the three `{settingsOpen && onCloseSettings && (<Settings ... />)}` blocks at lines 764-765, 781-782, and 970-971, plus the `Settings` import at line 13 and the `settingsOpen` / `onCloseSettings` props from the props interface and destructuring.
- Delete the two `onOpenSettings()` keyboard handlers at lines 652 and 689 only if they were bound to a settings shortcut key; otherwise leave them — they now navigate.

- [ ] **Step 8: Verify manually**

Run: `npm run dev`
Confirm: the pill bar appears above the preview; clicking **Settings** navigates to a full-screen settings page; clicking the profile pill opens the profile page; tuning a channel (`/channel/N`) hides the bar entirely.

- [ ] **Step 9: Typecheck, run the full suite, and commit**

Run: `npm run build -w client`
Run: `npm run test`

```bash
git add client/src/components/NavBar client/src/components/Profile client/src/App.tsx client/src/components/Guide/Guide.tsx
git commit -m "feat(profiles): add nav bar with routed Settings and Profile pages"
```

---

### Task 12: Remote-control navigation zone for the nav bar

**Files:**
- Modify: `client/src/components/NavBar/NavBar.tsx`
- Test: `client/src/components/NavBar/NavBar.test.tsx` (extend)

**Interfaces:**
- Consumes: `useNavZone`, `moveFocus`, `getFocusableChildren` from `client/src/navigation`.
- Produces: a registered zone with id `'navbar'`; left/right move between pills, down leaves the zone via `getAdjacentZone('down') → 'guide-grid'`.

- [ ] **Step 1: Write the failing test**

Append to `client/src/components/NavBar/NavBar.test.tsx`:

```tsx
  it('moves focus between pills with arrow keys', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const profileLink = await screen.findByRole('link', { name: /joey/i });
    profileLink.focus();
    expect(document.activeElement).toBe(profileLink);

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /guide/i }));
  });
```

Add the import at the top of the file:

```tsx
import userEvent from '@testing-library/user-event';
```

Wrap the renders in `NavigationProvider`:

```tsx
import { NavigationProvider } from '../../navigation';
```

and update `renderAt` to nest `<NavigationProvider>` inside `MemoryRouter` and outside `ProfileProvider`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — focus does not move on ArrowRight.

- [ ] **Step 3: Register the zone**

In `client/src/components/NavBar/NavBar.tsx`, add:

```tsx
import { useRef } from 'react';
import { useNavZone, moveFocus, getFocusableChildren } from '../../navigation';
```

Add a ref on the `<nav>` element and register the zone before the early return is evaluated — hooks must run unconditionally, so compute `hidden` first and use it to gate rendering only:

```tsx
  const navRef = useRef<HTMLElement>(null);
  const hidden = /^\/channel\/\d+$/.test(location.pathname);

  useNavZone({
    id: 'navbar',
    onArrow: (dir) => {
      if (hidden || !navRef.current) return false;
      if (dir === 'left' || dir === 'right') {
        moveFocus(getFocusableChildren(navRef.current), dir);
        return true;
      }
      return false;
    },
    getAdjacentZone: (dir) => (dir === 'down' ? 'guide-grid' : null),
  });

  if (hidden) return null;
```

and attach `ref={navRef}` to the `<nav>`.

If the guide grid's registered zone id is not `'guide-grid'`, use the id found in `client/src/components/Guide/GuideGrid.tsx`'s `useNavZone` call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w client`
Expected: PASS, 7 NavBar tests.

- [ ] **Step 5: Verify manually with a keyboard**

Run: `npm run dev`
Confirm: from the guide grid, pressing Up reaches the nav bar; Left/Right move between the three pills; Enter activates one; Down returns to the grid.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run test`

```bash
git add client/src/components/NavBar
git commit -m "feat(profiles): register nav bar as a remote-control zone"
```

---

## Phase 2 — Preferences Move to the Profile

---

### Task 13: The `usePref` hook

**Files:**
- Create: `client/src/hooks/usePref.ts`
- Test: `client/src/hooks/usePref.test.tsx` (create)

**Interfaces:**
- Consumes: `useProfile` (Task 10).
- Produces: `usePref<T>(key: string, defaultValue: T): [T, (value: T) => void]` — returns `defaultValue` until the prefs blob loads, then the stored value; the setter delegates to `setPref`.

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/usePref.test.tsx`:

```tsx
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — cannot resolve `./usePref`.

- [ ] **Step 3: Implement the hook**

Create `client/src/hooks/usePref.ts`:

```ts
import { useCallback } from 'react';
import { useProfile } from '../contexts/ProfileContext';

/**
 * Read and write one per-profile preference.
 *
 * Mirrors useState's shape so migrating a localStorage call site is mechanical.
 * Returns defaultValue until the profile's prefs blob has loaded, and whenever
 * the stored value's type does not match the default — which keeps a corrupt or
 * stale blob from breaking first render.
 */
export function usePref<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const { prefs, setPref } = useProfile();

  const stored = prefs[key];
  const value =
    stored !== undefined && typeof stored === typeof defaultValue ? (stored as T) : defaultValue;

  const set = useCallback((next: T) => setPref(key, next), [key, setPref]);

  return [value, set];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w client`
Expected: PASS, 5 usePref tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run test`

```bash
git add client/src/hooks/usePref.ts client/src/hooks/usePref.test.tsx
git commit -m "feat(profiles): add usePref hook"
```

---

### Task 14: One-time localStorage preference migration

**Files:**
- Create: `client/src/services/prefsMigration.ts`
- Modify: `client/src/contexts/ProfileContext.tsx` (run after the first profile loads)
- Test: `client/src/services/prefsMigration.test.ts` (create)

**Interfaces:**
- Consumes: `patchProfilePrefs` (Task 9).
- Produces:
  - `MIGRATED_KEYS: readonly string[]` — the `localStorage` keys to lift, without the `prevue_` prefix in the pref name.
  - `migrateLocalPrefs(profileId: number): Promise<boolean>` — returns `true` when a migration ran, `false` when it was already done or there was nothing to migrate.

- [ ] **Step 1: Write the failing test**

Create `client/src/services/prefsMigration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { migrateLocalPrefs } from './prefsMigration';
import * as api from './api';

describe('migrateLocalPrefs', () => {
  beforeEach(() => {
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — cannot resolve `./prefsMigration`.

- [ ] **Step 3: Implement the migration**

Create `client/src/services/prefsMigration.ts`:

```ts
import { patchProfilePrefs } from './api';

const MIGRATED_FLAG = 'prevue_prefs_migrated';

/**
 * localStorage keys lifted into a profile's prefs blob, paired with how to
 * parse the stored string. The pref name is the localStorage key minus the
 * `prevue_` prefix.
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
  { key: 'prevue_program_facts', type: 'boolean' },
  { key: 'prevue_iconic_scenes', type: 'boolean' },
  { key: 'prevue_hidden_gems', type: 'boolean' },
  { key: 'prevue_catch_up', type: 'boolean' },
  { key: 'prevue_sleep_enabled', type: 'boolean' },
  { key: 'prevue_sleep_preset', type: 'number' },
  { key: 'prevue_sleep_winddown', type: 'boolean' },
  { key: 'prevue_sleep_dim', type: 'boolean' },
  { key: 'prevue_guide_filters', type: 'json' },
  { key: 'prevue_guide_dividers', type: 'json' },
  { key: 'prevue_guide_custom_colors', type: 'json' },
  { key: 'prevue_preset_multipliers', type: 'json' },
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
 * Guarded by a flag so it never runs twice and never overwrites preferences the
 * user has since changed on another device. Returns true only when a patch was
 * actually sent.
 */
export async function migrateLocalPrefs(profileId: number): Promise<boolean> {
  try {
    if (localStorage.getItem(MIGRATED_FLAG) === '1') return false;
  } catch {
    return false;
  }

  const patch: Record<string, unknown> = {};
  for (const { key, type } of MIGRATED_KEYS) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return false;
    }
    if (raw === null) continue;

    const value = parseStored(raw, type);
    if (value !== undefined) patch[key.replace(/^prevue_/, '')] = value;
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
```

- [ ] **Step 4: Run it from the context**

In `client/src/contexts/ProfileContext.tsx`, inside the boot `useEffect`, after `await loadProfile(target)`:

```ts
        if (target) {
          await loadProfile(target);
          if (await migrateLocalPrefs(target.id)) {
            setPrefs(await apiGetProfilePrefs(target.id));
          }
        }
```

Add the import:

```ts
import { migrateLocalPrefs } from '../services/prefsMigration';
```

Add a ProfileContext test asserting the migration runs once on boot:

```tsx
  it('runs the localStorage migration once on boot', async () => {
    localStorage.setItem('prevue_guide_hours', '3');
    const patch = vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});

    const { unmount } = render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    unmount();

    patch.mockClear();
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(patch).not.toHaveBeenCalled();
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w client`
Expected: PASS, 6 migration tests plus the new ProfileContext test.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run test`

```bash
git add client/src/services/prefsMigration.ts client/src/services/prefsMigration.test.ts client/src/contexts/ProfileContext.tsx client/src/contexts/ProfileContext.test.tsx
git commit -m "feat(profiles): migrate device localStorage prefs into the profile once"
```

---

### Task 15: Convert display and guide preference call sites

**Files:**
- Modify: `client/src/components/Settings/DisplaySettings.tsx`
- Modify: `client/src/components/Guide/guideFilterUtils.ts`
- Modify: `client/src/utils/guideCustomization.ts`
- Modify: consumers that call the exported getters (`Guide.tsx`, `App.tsx`, `PreviewPanel.tsx`, `GuideGrid.tsx`)
- Test: `client/src/components/Settings/DisplaySettings.test.tsx` (create)

**Interfaces:**
- Consumes: `usePref` (Task 13).
- Produces: `DisplaySettings` reads and writes every display preference through `usePref`. The module-level getters (`getGuideHours`, `getVisibleChannels`, `getAutoScroll`, `getAutoScrollSpeed`, `getPreviewStyle`, `getTickerEnabled`, `applyPreviewBg`) are **removed**; consumers call `usePref` directly with the same key and default.

Preference keys keep their current names minus the `prevue_` prefix, exactly matching `MIGRATED_KEYS` in Task 14 — e.g. `prevue_guide_hours` → `guide_hours`.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/Settings/DisplaySettings.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DisplaySettings from './DisplaySettings';
import { ProfileProvider } from '../../contexts/ProfileContext';
import * as api from '../../services/api';
import type { Profile } from '../../types';

const JOEY: Profile = {
  id: 1, name: 'Joey', avatar_glyph: '', avatar_color: '#7c5cff',
  is_kids: false, max_rating: null, prefs: {}, sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('DisplaySettings persistence', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([JOEY]);
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ guide_hours: 2 });
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
    localStorage.setItem('prevue_prefs_migrated', '1');
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders the stored guide hours from the profile, not localStorage', async () => {
    localStorage.setItem('prevue_guide_hours', '4');
    render(<ProfileProvider><DisplaySettings panel="guide" /></ProfileProvider>);
    await waitFor(() => {
      expect(screen.getByLabelText(/guide hours/i)).toHaveValue('2');
    });
  });

  it('writes a changed preference to the profile', async () => {
    const user = userEvent.setup();
    render(<ProfileProvider><DisplaySettings panel="guide" /></ProfileProvider>);
    await waitFor(() => expect(screen.getByLabelText(/guide hours/i)).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText(/guide hours/i), '3');

    await waitFor(() =>
      expect(api.patchProfilePrefs).toHaveBeenCalledWith(1, expect.objectContaining({ guide_hours: 3 }))
    );
  });
});
```

Adjust the query selectors to whatever accessible labels `DisplaySettings` actually renders; if the guide-hours control has no accessible name, add `aria-label="Guide hours"` to it as part of this task.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — the component still reads `localStorage`.

- [ ] **Step 3: Convert DisplaySettings**

In `client/src/components/Settings/DisplaySettings.tsx`, replace each `useState` + `localStorage` pair with `usePref`. For example, the guide-hours pair at lines 492-507 becomes:

```tsx
import { usePref } from '../../hooks/usePref';

// inside the component:
const [guideHours, setGuideHours] = usePref('guide_hours', DEFAULT_GUIDE_HOURS);
```

and the handler becomes `setGuideHours(clamp(value, MIN_GUIDE_HOURS, MAX_GUIDE_HOURS))`.

Delete each exported getter (`getGuideHours`, `getVisibleChannels`, `getAutoScroll`, `getAutoScrollSpeed`, `getPreviewStyle`, `getTickerEnabled`) and its `localStorage` constant once no consumer imports it. Keep the `window.dispatchEvent(new CustomEvent(...))` calls: other components still listen for those events, and removing them is out of scope.

- [ ] **Step 4: Convert the consumers**

In `client/src/components/Guide/Guide.tsx` (line 11), remove the getter imports and read the same values via `usePref` with the identical keys and defaults:

```tsx
const [guideHours] = usePref('guide_hours', 1);
const [visibleChannels] = usePref('visible_channels', 5);
const [autoScroll] = usePref('auto_scroll', true);
const [autoScrollSpeed] = usePref('auto_scroll_speed', 'normal');
const [previewStyle] = usePref('preview_style', 'default');
const [tickerEnabled] = usePref('ticker_enabled', true);
```

Repeat for `App.tsx` (`applyPreviewBg` / `getGuideFilters`), `PreviewPanel.tsx` (`video_fit`, `subtitle_index`), and `GuideGrid.tsx` if it imports any getter.

Convert `client/src/components/Guide/guideFilterUtils.ts` and `client/src/utils/guideCustomization.ts` the same way: these are plain modules, not components, so change their exported functions to take the prefs bag as an argument and have callers pass `usePref` values in — do not call hooks from them.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w client`
Expected: PASS.

- [ ] **Step 6: Verify manually**

Run: `npm run dev`
Confirm: changing a display setting persists across a page reload; switching to a second profile shows that profile's settings; switching back restores the first profile's.

- [ ] **Step 7: Typecheck, run the full suite, and commit**

Run: `npm run build -w client`
Run: `npm run test`

```bash
git add client/src/components/Settings/DisplaySettings.tsx client/src/components/Settings/DisplaySettings.test.tsx client/src/components/Guide client/src/utils/guideCustomization.ts client/src/App.tsx
git commit -m "refactor(profiles): read display and guide prefs from the profile"
```

---

### Task 16: Convert the remaining preference call sites

**Files:**
- Modify: `client/src/components/Settings/GeneralSettings.tsx` (AI toggles)
- Modify: `client/src/components/Settings/ChannelSettings.tsx` (preset multipliers)
- Modify: `client/src/hooks/useSleepTimer.ts`
- Modify: `client/src/components/Player/Player.tsx` (subtitle index, video fit)
- Test: `client/src/hooks/useSleepTimer.test.tsx` (create)

**Interfaces:**
- Consumes: `usePref` (Task 13).
- Produces: no remaining `localStorage.getItem`/`setItem` calls outside `clientIdentity.ts`, `activeProfile.ts`, `prefsMigration.ts`, and the API-key handling in `api.ts`.

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/useSleepTimer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useSleepTimer } from './useSleepTimer';
import { ProfileProvider } from '../contexts/ProfileContext';
import * as api from '../services/api';
import type { Profile } from '../types';

const JOEY: Profile = {
  id: 1, name: 'Joey', avatar_glyph: '', avatar_color: '#7c5cff',
  is_kids: false, max_rating: null, prefs: {}, sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

function Probe() {
  const { state, actions } = useSleepTimer();
  return (
    <div>
      <span data-testid="enabled">{String(state.enabled)}</span>
      <button onClick={() => actions.setEnabled(true)}>enable</button>
    </div>
  );
}

describe('useSleepTimer persistence', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProfiles').mockResolvedValue([JOEY]);
    vi.spyOn(api, 'patchProfilePrefs').mockResolvedValue({});
    localStorage.setItem('prevue_prefs_migrated', '1');
  });

  afterEach(() => vi.restoreAllMocks());

  it('reads the enabled flag from the profile', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({ sleep_enabled: true });
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('true'));
  });

  it('writes the enabled flag to the profile', async () => {
    vi.spyOn(api, 'getProfilePrefs').mockResolvedValue({});
    render(<ProfileProvider><Probe /></ProfileProvider>);
    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('false'));

    act(() => { screen.getByText('enable').click(); });
    expect(screen.getByTestId('enabled')).toHaveTextContent('true');
  });
});
```

Adjust the destructuring to match `useSleepTimer`'s actual return shape (`SleepTimerState` / `SleepTimerActions` as declared in the hook).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w client`
Expected: FAIL — the hook still reads `localStorage`.

- [ ] **Step 3: Convert the call sites**

For each file, replace the `useState(() => localStorage.getItem(KEY))` pattern with `usePref`, using these keys and defaults:

```tsx
// GeneralSettings.tsx
const [programFacts, setProgramFacts] = usePref('program_facts', false);
const [iconicScenes, setIconicScenes] = usePref('iconic_scenes', false);
const [hiddenGems, setHiddenGems] = usePref('hidden_gems', false);
const [catchUp, setCatchUp] = usePref('catch_up', false);

// ChannelSettings.tsx
const [presetMultipliers, setPresetMultipliers] = usePref<Record<string, number>>('preset_multipliers', {});

// useSleepTimer.ts
const [enabled, setEnabled] = usePref('sleep_enabled', false);
const [preset, setPreset] = usePref('sleep_preset', 60);
const [winddown, setWinddown] = usePref('sleep_winddown', true);
const [dim, setDim] = usePref('sleep_dim', true);

// Player.tsx
const [subtitleIndex, setSubtitleIndex] = usePref('subtitle_index', '');
const [videoFit, setVideoFit] = usePref('video_fit', 'contain');
```

Delete each now-unused `*_KEY` constant and its `localStorage` reads and writes.

- [ ] **Step 4: Verify no stragglers remain**

Run:

```bash
grep -rn "localStorage" client/src --include='*.ts' --include='*.tsx' | grep -v -E "clientIdentity|activeProfile|prefsMigration|api\.ts|test"
```

Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w client`
Expected: PASS.

- [ ] **Step 6: Verify manually**

Run: `npm run dev`
Confirm: sleep timer settings, AI toggles, and player subtitle/fit choices persist per profile and swap when the profile is switched.

- [ ] **Step 7: Typecheck, run the full suite, and commit**

Run: `npm run build -w client`
Run: `npm run test`

```bash
git add client/src/components/Settings/GeneralSettings.tsx client/src/components/Settings/ChannelSettings.tsx client/src/hooks/useSleepTimer.ts client/src/hooks/useSleepTimer.test.tsx client/src/components/Player/Player.tsx
git commit -m "refactor(profiles): move remaining prefs onto the profile"
```

---

### Task 17: Documentation

**Files:**
- Modify: `docs/API.md`
- Modify: `docs/FEATURES.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `server/src/openapi.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code interfaces.

- [ ] **Step 1: Document the API**

Add a `## Profiles` section to `docs/API.md` covering the eight endpoints from Tasks 2, 3, and 5, with request and response examples, the `X-Profile-Id` header, and the last-profile-delete 400.

- [ ] **Step 2: Add the OpenAPI paths**

In `server/src/openapi.ts`, add path entries for `/api/profiles`, `/api/profiles/{id}`, `/api/profiles/{id}/prefs`, and `/api/profiles/{id}/lineup`, following the shape of the existing entries.

- [ ] **Step 3: Document the feature**

Add a `## Profiles` section to `docs/FEATURES.md`: what a profile owns, what stays global, the kids rating ceiling, and that there are no PINs.

In `docs/ARCHITECTURE.md`, document the `profiles` / `profile_channels` tables and the active-profile resolution chain.

- [ ] **Step 4: Update CLAUDE.md**

Add to the Repository Structure tree: `client/src/contexts/`, `server/src/middleware/profileResolver.ts`, `server/src/routes/profiles.ts`.

Under Testing Strategy, replace "Client Tests — None currently" with the client Vitest setup and how to run it.

Add to Common Gotchas: *Per-profile preferences live in the `profiles.prefs` JSON blob and are read via `usePref`, never `localStorage`. Only client identity, the active profile id, and the migration guard flag still use `localStorage`.*

- [ ] **Step 5: Verify the OpenAPI spec loads**

Run: `npm run dev:server`, then open `http://localhost:3080/api-docs`.
Confirm: the Profiles section renders without a spec error.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run test`

```bash
git add docs CLAUDE.md server/src/openapi.ts
git commit -m "docs: document profiles, the nav bar, and client tests"
```

---

## Self-Review Notes

Checked against the spec:

- **Data model, migration, active profile resolution, API, kids profiles, client architecture, avatars, sequencing, testing** — each maps to a task above (Tasks 1, 1+14, 4, 2/3/5, 6, 9/10/11/13, 11, phase split, throughout).
- **Watch history profile-scoped** — Task 7.
- **Channel lineup profile-specific** — Task 5 (server) and Task 5's `applyLineup`. Note: per-profile lineup *editing UI* is not in this plan. The API and enforcement exist; the Settings → Channels UI for hiding and reordering per profile is a follow-up. This is called out here rather than left implicit.
- **Out of scope confirmed absent:** no PIN, no launch-blocking picker, no avatar upload, no per-profile server config, no cross-device active-profile sync.
