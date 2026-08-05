import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSettings } from './api';
import { setActiveProfileId } from './activeProfile';

// Regression test for the carry-forward finding: inflightGets used to key
// concurrent GET dedup by URL alone, with no profile id in the key. Once
// switchProfile could change the active profile mid-flight, two overlapping
// GETs to the same URL under two different profiles would share one promise
// and cross-serve one profile's response to the other.
describe('api GET request dedup', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('does not share an in-flight GET promise across different active profiles', async () => {
    let resolveProfile1: (value: Response) => void;
    let resolveProfile2: (value: Response) => void;

    const response1 = new Promise<Response>((resolve) => { resolveProfile1 = resolve; });
    const response2 = new Promise<Response>((resolve) => { resolveProfile2 = resolve; });

    fetchMock
      .mockImplementationOnce(() => response1)
      .mockImplementationOnce(() => response2);

    setActiveProfileId(1);
    const call1 = getSettings();

    // Switch profiles before the first request resolves, then issue the same
    // GET again. With the bug, this second call would reuse call1's in-flight
    // promise (keyed by URL alone) instead of issuing a fresh fetch.
    setActiveProfileId(2);
    const call2 = getSettings();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveProfile1!(new Response(JSON.stringify({ owner: 'profile-1' }), { status: 200 }));
    resolveProfile2!(new Response(JSON.stringify({ owner: 'profile-2' }), { status: 200 }));

    await expect(call1).resolves.toEqual({ owner: 'profile-1' });
    await expect(call2).resolves.toEqual({ owner: 'profile-2' });
  });

  it('still dedupes concurrent GETs to the same URL under the same active profile', async () => {
    let resolveOnce: (value: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveOnce = resolve; });
    fetchMock.mockImplementation(() => response);

    setActiveProfileId(1);
    const call1 = getSettings();
    const call2 = getSettings();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveOnce!(new Response(JSON.stringify({ shared: true }), { status: 200 }));

    await expect(call1).resolves.toEqual({ shared: true });
    await expect(call2).resolves.toEqual({ shared: true });
  });
});
