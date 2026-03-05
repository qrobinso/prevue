import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, createMockMovie } from '../helpers/setup.js';
import { ScheduleEngine } from '../../src/services/ScheduleEngine.js';
import type { JellyfinItem } from '../../src/types/index.js';

function createMockJellyfin(items: JellyfinItem[]) {
  const itemMap = new Map<string, JellyfinItem>();
  for (const item of items) itemMap.set(item.Id, item);

  return {
    getItem: (id: string) => itemMap.get(id),
    getItemDurationMs: (item: JellyfinItem) =>
      item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000) : 0,
  } as any;
}

describe('ScheduleEngine dead-air fallback', () => {
  it('schedules programs instead of full dead air when only conflict candidates exist', async () => {
    const db: Database.Database = createTestDb();

    const movies: JellyfinItem[] = [
      createMockMovie({
        Id: 'movie-a',
        Name: 'Movie A',
        RunTimeTicks: 72000000000, // 2h
      }),
      createMockMovie({
        Id: 'movie-b',
        Name: 'Movie B',
        RunTimeTicks: 72000000000, // 2h
      }),
    ];

    const engine = new ScheduleEngine(db, createMockJellyfin(movies));
    const itemIds = movies.map(m => m.Id);
    const insert = db.prepare(
      `INSERT INTO channels (number, name, type, genre, item_ids, ai_prompt, sort_order)
       VALUES (?, ?, 'auto', NULL, ?, NULL, ?)`
    );
    const inserted = insert.run(1, 'Conflict Channel', JSON.stringify(itemIds), 1);
    const channel = {
      id: Number(inserted.lastInsertRowid),
      number: 1,
      name: 'Conflict Channel',
      type: 'auto' as const,
      genre: null,
      preset_id: null,
      filter: null,
      item_ids: itemIds,
      ai_prompt: null,
      sort_order: 1,
      created_at: new Date().toISOString(),
    };

    const blockStart = new Date('2026-02-26T09:00:00.000Z');
    const blockEnd = new Date('2026-02-27T09:00:00.000Z');
    const tracker = {
      itemSlots: new Map<string, Array<[number, number]>>(),
      seriesSlots: new Map<string, Array<[number, number, number]>>(),
    };

    // Simulate both movies being "busy" on other channels for the full block.
    tracker.itemSlots.set(movies[0].Id, [[blockStart.getTime(), blockEnd.getTime()]]);
    tracker.itemSlots.set(movies[1].Id, [[blockStart.getTime(), blockEnd.getTime()]]);

    const block = await engine.generateBlock(channel, blockStart, tracker as any);
    const programCount = block.programs.filter(p => p.type === 'program').length;

    expect(programCount).toBeGreaterThan(0);
  });
});
