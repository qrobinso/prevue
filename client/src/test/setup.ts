import { expect, afterEach } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';

// NOTE: importing '@testing-library/jest-dom/vitest' directly does not work
// here because npm hoists @testing-library/jest-dom to the repo root, where
// it resolves its own 'vitest' import against the root node_modules (v4,
// installed for the server workspace) instead of the client workspace's
// local vitest (v3, installed for this workspace). That mismatched instance
// means `expect.extend()` patches a different `expect` than the one this
// test file actually uses. Extending manually against the locally-resolved
// `vitest` module (imported above) sidesteps the mismatch.
expect.extend(matchers);

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
