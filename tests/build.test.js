// What the built artefact promises the store, and what it does not.
//
// A manifest that declares a permission nothing uses is silent at runtime and
// surfaces weeks later as a review rejection; one that is missing a permission
// the code needs is silent until the feature is used. Neither is visible in any
// other test, so the manifest is checked against the code that reads it.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let manifest;

beforeAll(() => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT });
  manifest = JSON.parse(readFileSync(join(ROOT, 'dist', 'manifest.json'), 'utf8'));
}, 60_000);

describe('the manifest', () => {
  it('carries the gecko id that AMO and the managed-storage filename both need', () => {
    // Load-bearing twice over: it is the AMO identity AND the name of the file
    // the policy is delivered in — ManagedStorage/<id>.json.
    expect(manifest.browser_specific_settings.gecko.id).toBe(
      'container-commander@sapn95.github.io',
    );
  });

  it('takes its version from package.json rather than a second source of truth', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
  });

  it('asks for the interception permissions only at runtime, never at install', () => {
    // Nothing is granted until somebody switches it on, so an install that is
    // never configured holds nothing at all.
    for (const p of ['webRequest', 'webRequestBlocking', '<all_urls>']) {
      expect(manifest.optional_permissions).toContain(p);
      expect(manifest.permissions ?? []).not.toContain(p);
    }
  });

  it('never asks for a permission that would let it write a durable rule store', () => {
    // There is no writable rule store, on purpose: a store nothing can write is
    // a store nothing can resurrect. See ADR-0002.
    expect(JSON.stringify(manifest)).not.toMatch(/"unlimitedStorage"/);
  });

  it('names Android its own minimum, which is not the desktop one', () => {
    // data_collection_permissions landed on desktop at 140 and on Android at
    // 142. Raising the desktop minimum to match would lock out desktop users on
    // 140 and 141 for a key their browser already understands, and leaving it
    // out warns on every single submission.
    const { gecko, gecko_android: android } = manifest.browser_specific_settings;
    expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
    expect(Number.parseFloat(android.strict_min_version)).toBeGreaterThan(
      Number.parseFloat(gecko.strict_min_version),
    );
  });

  it('puts the panel on the button and keeps the settings in a tab', () => {
    // A popup is too narrow for a rule list and a decision log, and that has not
    // changed. What changed is what the button is FOR: opening the options page
    // duplicated about:addons, while the human override — the one gesture that
    // has to be reachable when a rule is wrong — was buried under a right-click
    // on a tab strip. The panel is small enough for a popup because it asks one
    // question.
    expect(manifest.action.default_popup).toBe('switch/switch.html');
    expect(manifest.options_ui.open_in_tab).toBe(true);
  });

  it('asks for activeTab rather than reading the address off <all_urls>', () => {
    // The panel needs the address of the tab you are looking at, and nothing
    // else. activeTab is granted by the click that opens the panel, carries no
    // warning in Firefox — so an update does not stall waiting for consent —
    // and, most of the point, it means the override still works on a profile
    // that never granted the watching permission.
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.optional_permissions).toContain('<all_urls>');
  });

  it('declares the background as an event page, which is what Firefox runs', () => {
    expect(manifest.background.scripts).toBeTruthy();
    expect(manifest.background.service_worker).toBeUndefined();
  });
});
