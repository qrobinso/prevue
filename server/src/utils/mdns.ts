/**
 * mDNS/Bonjour utilities for the _prevue._tcp advertisement.
 */

/** TXT records for the _prevue._tcp advertisement. Pure — exported for testing. */
export function buildPrevueTxt(authEnabled: boolean, version: string): Record<string, string> {
  return { auth_required: authEnabled ? '1' : '0', version };
}
