// The two grants, and the one question each of them answers.
//
// Both are optional in the manifest and both are asked for from the add-on's
// own page. The failure they exist to prevent is the same one twice: an
// extension that looks healthy while being structurally unable to do its job,
// because a permission it never got is the only thing standing in the way.

import { describe, it, expect, vi } from 'vitest';
import {
  watchPermissions,
  hasWatchPermissions,
  requestWatchPermissions,
  managementPermission,
  hasManagementPermission,
  requestManagementPermission,
} from '../src/lib/permissions.js';

describe('what is asked for', () => {
  it('asks for the watch permissions together, in one call', () => {
    // permissions.request must run inside a user gesture, and a handler stops
    // being user-initiated the moment it awaits anything — so a second request
    // made after the first resolves always fails. One call or none.
    expect(watchPermissions()).toEqual({
      origins: ['<all_urls>'],
      permissions: ['webRequest', 'webRequestBlocking'],
    });
  });

  it('asks for management on its own', () => {
    // A separate question with a separate answer: this one only decides whether
    // add-ons that do not answer the protocol are visible.
    expect(managementPermission()).toEqual({ permissions: ['management'] });
  });
});

for (const [what, has, request, wanted] of [
  ['watching', hasWatchPermissions, requestWatchPermissions, watchPermissions()],
  ['management', hasManagementPermission, requestManagementPermission, managementPermission()],
]) {
  describe(`the ${what} grant`, () => {
    it('says yes only when the browser says yes', async () => {
      const api = { contains: vi.fn(async () => true) };
      expect(await has(api)).toBe(true);
      expect(api.contains).toHaveBeenCalledWith(wanted);
    });

    it('says no when the browser says no', async () => {
      expect(await has({ contains: async () => false })).toBe(false);
    });

    it('says no when the API is absent', async () => {
      // Reported as missing rather than thrown: a page that cannot ask has not
      // been granted anything, and that is the state it has to act on.
      expect(await has({})).toBe(false);
      expect(await has(undefined)).toBe(false);
    });

    it('says no when the check throws', async () => {
      // False on any doubt. A wrong "yes" hides the very state this reports.
      expect(
        await has({
          contains: async () => {
            throw new Error('nope');
          },
        }),
      ).toBe(false);
    });

    it('asks the browser for exactly that set', async () => {
      const api = { request: vi.fn(async () => true) };
      expect(await request(api)).toBe(true);
      expect(api.request).toHaveBeenCalledWith(wanted);
    });

    it('answers false rather than throwing when the prompt is refused', async () => {
      expect(
        await request({
          request: async () => {
            throw new Error('dismissed');
          },
        }),
      ).toBe(false);
      expect(await request({})).toBe(false);
    });
  });
}
