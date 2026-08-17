// The icons, tested against the manifest that references them.
//
// This exists because the two halves drifted apart in the quietest possible
// way: scripts/make-icons.mjs generated a 16 px icon that the manifest never
// mentioned, so it shipped in every build as dead weight, while the two sizes
// Firefox actually asks for — 32 for about:addons, and 32 again for a 2x
// toolbar — were absent and came from a blurry downscale of the 48. Nothing
// failed. Nothing warned. It just looked slightly wrong forever.
//
// So the rule is checked in both directions: every size the manifest names must
// exist and be that size, and every size the generator writes must be named.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const manifest = JSON.parse(readFileSync(join(ROOT, 'src/manifest.json'), 'utf8'));

const declared = {
  ...manifest.icons,
  ...manifest.action.default_icon,
};

// PNG stores width and height as big-endian 32-bit ints at a fixed offset in
// the IHDR chunk, which is always the first one. Reading them directly beats
// trusting the file name, since the file name is exactly what a broken
// generator would still get right.
function pngSize(path) {
  const buf = readFileSync(path);
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('the icon set the manifest promises', () => {
  it('names the sizes Firefox actually draws', () => {
    // about:addons asks for 32 and 64; the toolbar asks for 16 and 32. 48 and
    // 128 stay because AMO and the install prompt use them.
    for (const size of ['16', '32', '48', '64', '128']) {
      expect(Object.keys(manifest.icons)).toContain(size);
    }
    // Without an explicit action icon the toolbar falls back to `icons`, which
    // works but leaves the choice to whatever Firefox picks that release.
    expect(manifest.action.default_icon['16']).toBeTruthy();
    expect(manifest.action.default_icon['32']).toBeTruthy();
  });

  it('has a real PNG of exactly the right size behind every entry', () => {
    for (const [size, rel] of Object.entries(declared)) {
      const { width, height } = pngSize(join(ROOT, 'src', rel));
      expect({ size, width, height }).toEqual({ size, width: Number(size), height: Number(size) });
    }
  });

  it('ships nothing the manifest does not reference', () => {
    const onDisk = readdirSync(join(ROOT, 'src/icons')).filter((f) => f.endsWith('.png'));
    const referenced = new Set(Object.values(declared).map((p) => p.split('/').pop()));
    expect([...onDisk].sort()).toEqual([...referenced].sort());
  });

  it('is square, because AMO rejects a listing icon that is not', () => {
    const { width, height } = pngSize(join(ROOT, 'src/icons/icon-128.png'));
    expect(width).toBe(height);
  });
});
