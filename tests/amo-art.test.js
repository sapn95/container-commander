// The things about the AMO uploader that running it does not check, and that a
// live store is a bad place to find out about.
//
// A wrong HS256 signature has exactly one symptom — 401 — and at that point it
// is indistinguishable from a stale secret. The no-credentials path has to be a
// clean exit 0, because release.yml runs this step on every release, including
// the ones where the secrets were never set.
//
// And then the ones this file was extended for. The first version of the
// uploader deleted every screenshot before posting the replacements, and
// treated "AMO has switched uploads off" as a benign exit 0 at BOTH ends of
// that window — so a 503 arriving in the middle left the public listing with no
// screenshots at all, reported a successful release, and waited for a next run
// that the monthly trigger would only ever fire if src/ or scripts/ changed.
// A review caught it. Nothing in the suite would have. Hence:

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signHs256 } from '../scripts/amo-art.mjs';

const SCRIPT = 'scripts/amo-art.mjs';
const FAKE = 'tests/helpers/fake-amo.mjs';
const SCREENSHOTS = ['01-first.png', '02-second.png'];

// The uploader reads dist/ and docs/store/, so it is run from a fixture tree
// rather than from this checkout. Two reasons, and the second is the one that
// bit: `npm run ci` runs the tests BEFORE it packages, so on a clean clone
// there is no dist/ at all and every one of these failed at "dist/ is not
// built" — green here, red the moment CI saw it. And tests/build.test.js
// rebuilds dist/ in a parallel worker, so anything reading it is racing.
let ROOT;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'amo-art-root-'));
  mkdirSync(join(ROOT, 'scripts'), { recursive: true });
  mkdirSync(join(ROOT, 'tests', 'helpers'), { recursive: true });
  mkdirSync(join(ROOT, 'dist', 'icons'), { recursive: true });
  mkdirSync(join(ROOT, 'docs', 'store'), { recursive: true });

  cpSync(SCRIPT, join(ROOT, SCRIPT));
  cpSync(FAKE, join(ROOT, FAKE));
  writeFileSync(
    join(ROOT, 'dist', 'manifest.json'),
    JSON.stringify({ browser_specific_settings: { gecko: { id: 'fixture@example.com' } } }),
  );
  // Real PNG bytes, because the fake asserts on the Content-Type the uploader
  // DECLARES for each part, and a text file would still declare image/png. The
  // point of that assertion is the Blob wrapper, not the file.
  const png = readFileSync('src/icons/icon-128.png');
  writeFileSync(join(ROOT, 'dist', 'icons', 'icon-128.png'), png);
  for (const name of SCREENSHOTS) writeFileSync(join(ROOT, 'docs', 'store', name), png);
  // A sibling that is NOT two-digit-prefixed, to prove the glob is a filter and
  // not just a sort.
  writeFileSync(join(ROOT, 'docs', 'store', 'screenshot-1x.png'), png);
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const withoutCredentials = () => {
  const env = { ...process.env };
  delete env.AMO_JWT_ISSUER;
  delete env.AMO_JWT_SECRET;
  return env;
};

/**
 * Run the uploader against the fake store, and hand back the transcript of what
 * it actually sent alongside its exit code.
 *
 * AMO_ART_PACE_MS collapses the throttle pacer — without it every one of these
 * would take a minute and a half of real time, and a test nobody runs is not a
 * regression test.
 */
function run(scenario, { previews = 2 } = {}) {
  const transcript = join(ROOT, `calls-${scenario}-${previews}.json`);
  let status = 0;
  let stdout;
  try {
    stdout = execFileSync('node', ['--import', `./${FAKE}`, SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        AMO_JWT_ISSUER: 'user:12345:67',
        AMO_JWT_SECRET: 'not-a-real-secret',
        FAKE_AMO_SCENARIO: scenario,
        FAKE_AMO_PREVIEWS: String(previews),
        FAKE_AMO_OUT: transcript,
        AMO_ART_PACE_MS: '0',
      },
    });
  } catch (e) {
    status = e.status;
    stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const calls = JSON.parse(readFileSync(transcript, 'utf8'));
  rmSync(transcript, { force: true });
  return { status, stdout, calls };
}

const methods = (calls) => calls.map((c) => c.method);

describe('the JWS signature', () => {
  it('reproduces the published HS256 test vector', () => {
    // RFC 7515 A.1, verbatim. Header and payload are taken pre-encoded because
    // the example's JSON carries CRLFs that no serialiser here would reproduce,
    // and the key is its JWK octet sequence decoded back to bytes.
    const signingInput =
      'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.' +
      'eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ';
    const key = Buffer.from(
      'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow',
      'base64url',
    );

    expect(signHs256(signingInput, key)).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });
});

describe('running it without credentials', () => {
  // execFileSync throws on a non-zero exit, so getting output back at all IS
  // the exit-0 assertion in both of these.

  it('warns instead of reddening a release that has already published', () => {
    const out = execFileSync('node', [SCRIPT], {
      cwd: process.cwd(),
      env: withoutCredentials(),
      encoding: 'utf8',
    });

    expect(out).toContain('::warning::');
    expect(out).toContain('docs/publishing.md');
  });

  it('gets no further than the credential check, so an unbuilt tree is fine too', () => {
    // Run a copy from a directory that has no dist/ and no docs/store/. If the
    // order of the checks ever slips, this throws with ENOENT — which on a
    // release day would read as a broken build rather than an unconfigured one.
    const root = mkdtempSync(join(tmpdir(), 'amo-art-'));
    mkdirSync(join(root, 'scripts'));
    cpSync(join(process.cwd(), SCRIPT), join(root, SCRIPT));

    const out = execFileSync('node', [SCRIPT], {
      cwd: root,
      env: withoutCredentials(),
      encoding: 'utf8',
    });

    expect(out).toContain('::warning::');
  });
});

describe('replacing the screenshots', () => {
  it('posts the new set before deleting the old one', () => {
    // The ordering IS the safety property. Deleting first opens a window in
    // which the live listing has no screenshots, and every way the run can stop
    // inside that window leaves the store page bare.
    const { status, calls } = run('happy');

    expect(status).toBe(0);
    const lastPost = methods(calls).lastIndexOf('POST');
    const firstDelete = methods(calls).indexOf('DELETE');
    expect(firstDelete).toBeGreaterThan(lastPost);
  });

  it('declares image/png on every part it uploads, icon included', () => {
    // AMO validates the DECLARED part type and never sniffs the bytes, so a
    // Buffer appended without a Blob wrapper goes up as application/octet-stream
    // and comes back rejected as not being a PNG.
    const { calls } = run('happy');
    const images = calls.filter((c) => c.parts?.image || c.parts?.icon);

    expect(images.length).toBeGreaterThan(0);
    for (const call of images) {
      expect(call.parts.image ?? call.parts.icon).toBe('image/png');
    }
  });

  it('numbers the positions from zero, ascending', () => {
    // Position is the only ordering AMO honours; left out it falls back to
    // insertion time, which a retry of a half-finished run gets wrong.
    const { calls } = run('happy');
    const posted = calls.filter((c) => c.method === 'POST');

    expect(posted.map((c) => c.parts.position)).toEqual(['0', '1']);
  });

  it('uploads the numbered PNGs and nothing else in the directory', () => {
    // The fixture also holds screenshot-1x.png, which make-art.sh writes as an
    // intermediate. A glob that swept it up would post the same picture to the
    // store twice, at a different size.
    const { calls } = run('happy');
    const posted = calls.filter((c) => c.method === 'POST');

    expect(posted).toHaveLength(SCREENSHOTS.length);
  });
});

describe('stopping early', () => {
  it('is silent and green when nothing has been touched yet', () => {
    // 503 on the icon PATCH: AMO declined, so the listing is exactly as it was.
    // This is the one case where walking away costs nothing.
    const { status, stdout, calls } = run('iconDown');

    expect(status).toBe(0);
    expect(stdout).toContain('::warning::');
    expect(methods(calls)).not.toContain('DELETE');
  });

  it('is loud and red once it has changed something', () => {
    // The regression. A 503 on a screenshot POST arrives after the icon has
    // already gone up, so the listing is half-synced. The old version called the
    // same benign exit here that it called above, and a green step is the one
    // thing that guarantees nobody looks.
    const { status, stdout, calls } = run('postDown');

    expect(status).not.toBe(0);
    expect(stdout).toContain('::error::');
    // and, crucially, it got nowhere near the deletions
    expect(methods(calls)).not.toContain('DELETE');
  });

  it('never deletes anything when an upload is refused outright', () => {
    const { status, calls } = run('badType');

    expect(status).not.toBe(0);
    expect(methods(calls)).not.toContain('DELETE');
  });

  it('leaves the listing alone when the add-on is not published yet', () => {
    const { status, calls } = run('noAddon');

    expect(status).toBe(0);
    expect(methods(calls)).toEqual(['GET', 'GET']);
  });

  it('treats a status probe it cannot read as a reason to stop, not an all-clear', () => {
    // Failing open here would send the full destructive sync at an AMO that has
    // just answered a trivial GET with a proxy error page.
    const { status, calls } = run('siteDown');

    expect(status).toBe(0);
    expect(methods(calls)).toEqual(['GET']);
  });

  it('refuses a sync too big for the hourly throttle before sending anything', () => {
    // Nine existing previews plus the icon and this repo's screenshots is past
    // the ten-an-hour bucket, and the signing step in the same job has already
    // spent two of them. Stopping here costs nothing; stopping halfway does not.
    const { status, stdout, calls } = run('happy', { previews: 9 });

    expect(status).not.toBe(0);
    expect(stdout).toContain('::error::');
    expect(methods(calls)).toEqual(['GET', 'GET']);
  });
});
