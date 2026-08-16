// The public repo must carry no employer identifiers — enforced as an
// ALLOWLIST, not a denylist.
//
// A denylist of forbidden strings is itself a list of what you are hiding: it
// has to be updated by whoever is about to leak something new, and it fails
// open on everything nobody thought of. An allowlist contains no secrets by
// construction and fails closed. That distinction was an adversarial finding,
// and it is why this file exists rather than a line in a contributing guide.
//
// See docs/adr/0011-employer-neutral-public-repo.md

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist']);
// The lockfile is generated and is nothing but registry URLs. Linting it says
// nothing about what WE wrote, and a linter that shouts about generated files
// is a linter somebody switches off.
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT = new Set(['.js', '.mjs', '.json', '.md', '.yaml', '.yml', '.html', '.css', '.txt']);

// Every hostname shape that may appear anywhere in this repository.
const HOSTS_OK = [
  /^([a-z0-9-]+\.)*example\.(com|org|net)$/,
  /^([a-z0-9-]+\.)*example-(corp|idp|cloud|apps)\.com$/,
  /^([a-z0-9-]+\.)*localhost$/,
  /^127\.0\.0\.1(:\d+)?$/,
  // Named vendor hosts the documentation is allowed to discuss generically.
  /^(addons|developer|bugzilla)\.mozilla\.org$/,
  /^(www\.)?github\.com$/,
  /^developer\.chrome\.com$/,
  /^raw\.githubusercontent\.com$/,
  /^sapn95\.github\.io$/,
  /^users\.noreply\.github\.com$/,
  /^chrome\.google\.com$/,
  // Near-miss fixtures: the suffix matcher must be shown NOT to match these,
  // so the repository has to be allowed to name them.
  /^notexample\.com$/,
  /^example\.com\.evil\.test$/,
];

// GUIDs must be visibly fake.
const GUID_OK = [
  /^0{8}-0{4}-0{4}-0{4}-0{12}$/,
  /^f{8}-f{4}-f{4}-f{4}-f{12}$/i,
  /^(0|1|2|3|4|5|6|7|8|9|a|b|c|d|e|f)\1{7}-.*/i,
];

const HOSTISH = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;
const GUIDISH = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// A dotted token is only a HOSTNAME if its last label is a real TLD. Without
// this the whole repository trips over itself: `tabs.create`, `storage.managed`
// and `sender.id` are all hostname-shaped, and a linter that cries at its own
// documentation is a linter somebody switches off — which is how the thing it
// was guarding gets committed.
const TLDS = new Set([
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'int',
  'mil',
  'info',
  'biz',
  'io',
  'dev',
  'app',
  'cloud',
  'ai',
  'ch',
  'fr',
  'uk',
  'eu',
  'nl',
  'se',
  'dk',
  'fi',
  'es',
  'pt',
  'pl',
  'cz',
  'ru',
  'cn',
  'jp',
  'ca',
  'au',
  'nz',
  'br',
  'za',
  // Deliberately NOT here, despite being real TLDs: `test`, `local` and
  // `localhost` (reserved names that cannot be a corporate host), and the
  // two-letter countries that are also ordinary JavaScript words — at, in, it,
  // me, is, no, de, to, be, do, so, us, co. `entry.at` and `re.test` are not
  // hostnames, and a linter that shouts at its own source is a linter somebody
  // switches off — which is exactly when the thing it guards gets committed.
  // `ch` is kept: it is the one country TLD a leak from here would use.
]);

const isHostname = (token) => TLDS.has(token.split('.').pop().toLowerCase());

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (TEXT.has(extname(name)) && !SKIP_FILES.has(name)) yield full;
  }
}

const problems = [];

for (const file of files(ROOT)) {
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((raw, i) => {
    // Percent-decoded first. `https%3A%2F%2Facme.example%2F` hides a hostname
    // from a naive scan, and an encoded URL is exactly the shape a leak takes
    // in a test fixture — so decoding makes this stricter, not looser.
    let line = raw;
    try {
      line = decodeURIComponent(raw);
    } catch {
      // Not valid percent-encoding. Scan the raw line instead.
    }
    for (const raw of line.match(HOSTISH) ?? []) {
      const host = raw.toLowerCase();
      if (!isHostname(host)) continue;
      if (HOSTS_OK.some((re) => re.test(host))) continue;
      problems.push(`${file}:${i + 1}  host not on the allowlist: ${raw}`);
    }
    for (const guid of line.match(GUIDISH) ?? []) {
      if (GUID_OK.some((re) => re.test(guid))) continue;
      problems.push(`${file}:${i + 1}  GUID is not a documented dummy: ${guid}`);
    }
  });
}

if (problems.length) {
  console.error('leak-lint: tokens that are not on the allowlist\n');
  for (const p of problems) console.error('  ' + p);
  console.error(
    '\nAdd real identifiers to the PRIVATE config repo, or extend the allowlist\n' +
      'in scripts/leak-lint.mjs if the token is genuinely a documented dummy.',
  );
  process.exit(1);
}

console.log('leak-lint: clean');
