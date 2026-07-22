import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers/setup.js';
import { JellyfinClient } from '../../src/services/JellyfinClient.js';

const getItemsMock = vi.fn();

vi.mock('@jellyfin/sdk/lib/utils/api/index.js', () => ({
  getItemsApi: () => ({ getItems: getItemsMock }),
  getMediaInfoApi: vi.fn(),
  getSystemApi: vi.fn(),
  getDynamicHlsApi: vi.fn(),
  getImageApi: vi.fn(),
  getUserApi: vi.fn(),
  getPlaystateApi: vi.fn(),
}));

const FAKE_SERVER = {
  id: 45,
  name: 'jellyfin',
  url: 'http://mock:8096',
  access_token: 'tok',
  user_id: 'user-1',
  is_active: 1,
} as any;

function makeItems(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({ Id: `${prefix}-${i}` }));
}

function createClient(): JellyfinClient {
  const db = createTestDb();
  const client = new JellyfinClient(db);
  vi.spyOn(client, 'getActiveServer').mockReturnValue(FAKE_SERVER);
  (client as any).getApi = () => ({});
  (client as any).getUserId = () => 'user-1';
  return client;
}

beforeEach(() => {
  getItemsMock.mockReset();
});

describe('JellyfinClient library sync', () => {
  it('deduplicates concurrent syncLibrary calls (single sync in flight)', async () => {
    const client = createClient();
    let resolveFetch!: (v: any) => void;
    const pending = new Promise((r) => { resolveFetch = r; });
    const fetchSpy = vi
      .spyOn(client as any, 'fetchItems')
      .mockImplementation(() => pending.then(() => []));

    const p1 = client.syncLibrary();
    const p2 = client.syncLibrary();
    resolveFetch(null);
    await Promise.all([p1, p2]);

    // One sync = 2 fetchItems calls (Movie + Episode); a second concurrent
    // syncLibrary must reuse the in-flight sync, not start 2 more.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('skips the unbounded single-request fetch when the library is large', async () => {
    const client = createClient();
    getItemsMock.mockImplementation(async (params: any) => {
      if (params.limit === 0) {
        // Count precheck
        return { data: { Items: [], TotalRecordCount: 20_000 } };
      }
      // Batched pages must always be bounded
      expect(params.limit).toBeGreaterThan(0);
      expect(params.startIndex).toBeDefined();
      const page = makeItems(Math.min(params.limit, 20_000 - params.startIndex), 'm');
      return { data: { Items: page, TotalRecordCount: 20_000 } };
    });

    const items = await (client as any).fetchItems('Movie');
    expect(items.length).toBe(20_000);
    // No call may be unbounded (no limit at all = whole-library request)
    for (const [params] of getItemsMock.mock.calls) {
      expect(params.limit).toBeDefined();
    }
  });

  it('fetches pages in parallel so sync time is not the sum of all pages', async () => {
    const client = createClient();
    let inFlight = 0;
    let maxInFlight = 0;
    getItemsMock.mockImplementation(async (params: any) => {
      if (params.limit === 0) {
        return { data: { Items: [], TotalRecordCount: 10_000 } };
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      const page = makeItems(Math.min(params.limit, 10_000 - params.startIndex), 'm');
      return { data: { Items: page, TotalRecordCount: 10_000 } };
    });

    const items = await (client as any).fetchItems('Movie');
    expect(items.length).toBe(10_000);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('preserves item order across parallel pages', async () => {
    const client = createClient();
    getItemsMock.mockImplementation(async (params: any) => {
      if (params.limit === 0) {
        return { data: { Items: [], TotalRecordCount: 6_000 } };
      }
      // Later pages resolve faster to try to scramble the order
      await new Promise((r) => setTimeout(r, Math.max(0, 30 - params.startIndex / 100)));
      const count = Math.min(params.limit, 6_000 - params.startIndex);
      const page = Array.from({ length: count }, (_, i) => ({ Id: `m-${params.startIndex + i}` }));
      return { data: { Items: page, TotalRecordCount: 6_000 } };
    });

    const items = await (client as any).fetchItems('Movie');
    expect(items.length).toBe(6_000);
    expect(items[0].Id).toBe('m-0');
    expect(items[5_999].Id).toBe('m-5999');
    expect(items.every((it: any, i: number) => it.Id === `m-${i}`)).toBe(true);
  });

  it('stops an in-flight sync when the server disconnects (resetApi)', async () => {
    const client = createClient();
    let pageCalls = 0;
    getItemsMock.mockImplementation(async (params: any, options: any) => {
      if (params.limit === 0) {
        return { data: { Items: [], TotalRecordCount: 50_000 } };
      }
      pageCalls++;
      // Slow pages that reject when the sync is aborted
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5_000);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
      return { data: { Items: makeItems(params.limit, 'm'), TotalRecordCount: 50_000 } };
    });

    const syncPromise = client.syncLibrary();
    // Let the prechecks and first wave of pages start
    await new Promise((r) => setTimeout(r, 30));
    const callsAtCancel = pageCalls;
    expect(callsAtCancel).toBeGreaterThan(0);

    client.resetApi();
    const items = await syncPromise; // must settle promptly, not wait out the 5s pages

    // Cancelled sync must not report a full library or cache partial data
    expect(items.length).toBe(0);
    expect(client.getLibraryItems().length).toBe(0);
    // No new pages may start after cancellation
    await new Promise((r) => setTimeout(r, 30));
    expect(pageCalls).toBe(callsAtCancel);
  }, 10_000);

  it('starts a fresh sync after a cancelled one instead of reusing it', async () => {
    const client = createClient();
    const fetchSpy = vi.spyOn(client as any, 'fetchItems');
    fetchSpy.mockImplementation(() => new Promise(() => {})); // first sync never settles on its own

    void client.syncLibrary();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    client.resetApi(); // disconnect

    fetchSpy.mockImplementation(async () => []);
    await client.syncLibrary();
    // A new sync must have started (2 more fetchItems calls), not reused the cancelled one
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('passes an abort signal to the single-request fetch for small libraries', async () => {
    const client = createClient();
    getItemsMock.mockImplementation(async (params: any) => {
      if (params.limit === 0) {
        return { data: { Items: [], TotalRecordCount: 100 } };
      }
      return { data: { Items: makeItems(100, 'm'), TotalRecordCount: 100 } };
    });

    const items = await (client as any).fetchItems('Movie');
    expect(items.length).toBe(100);

    // The full fetch (non-precheck) must carry an abort signal so it cannot stall forever
    const fullFetchCall = getItemsMock.mock.calls.find(([params]) => params.limit !== 0);
    expect(fullFetchCall).toBeDefined();
    const options = fullFetchCall![1];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
});
