// Builds dist/ from src/.
//
// There is no bundler and there are no runtime dependencies: the source under
// src/ IS the artifact, and all this does is copy it, stamp the version, and
// optionally zip it. That is deliberate — an extension that decides which
// identity your tabs open in should be readable end to end by whoever reviews
// it, in the store and out of it.
//
// Firefox only. Containers are a Firefox feature, so unlike its two sibling
// extensions there is no second target here.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const flags = new Set(process.argv.slice(2));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'src'), OUT, { recursive: true });

const manifestPath = join(OUT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`built dist/ for v${pkg.version}`);

if (flags.has('--zip')) {
  const zip = join(ROOT, `container-commander-v${pkg.version}.zip`);
  rmSync(zip, { force: true });
  // Zipped from INSIDE dist/, because AMO expects the manifest at the root of
  // the archive and not one directory down.
  execFileSync('zip', ['-qr', zip, '.'], { cwd: OUT });
  console.log(`packaged ${zip.split('/').pop()}`);
}
