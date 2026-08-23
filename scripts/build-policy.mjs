// Builds the managed-storage file from a DIRECTORY of policy fragments.
//
// One file is fine until there are two sources for it. Work rules that a config
// repository generates and personal rules written by hand cannot share a file
// without one overwriting the other every time either is regenerated — and the
// loser is silent, because a policy that lost half its rules is still a valid
// policy.
//
// So the source of truth is a directory. Each file is a fragment; this merges
// them in name order and writes the one file Firefox reads. Still read-only from
// the browser's side: the extension cannot write any of this, which is what
// keeps it from drifting.
//
//   build-policy.mjs                 print what would be written
//   build-policy.mjs --apply         write it
//   build-policy.mjs --from <dir>    somewhere other than the default
//
// Numbers in the file names are the merge order and are worth using: 10-work,
// 20-personal. Order decides nothing about rule PRECEDENCE — the compiler sorts
// by specificity — but it does decide who wins a scalar like dryRun.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateConfig, compile, SCHEMA } from '../src/lib/config.js';

const EXTENSION_ID = 'container-commander@sapn95.github.io';
const SOURCE = join(homedir(), '.config', 'container-commander');

/** Where Firefox looks. Per platform, and the one thing nobody can guess. */
function managedPath() {
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library/Application Support/Mozilla/ManagedStorage',
      `${EXTENSION_ID}.json`,
    );
  }
  if (process.platform === 'win32') {
    return null; // a registry key, not a path — see docs/configuration.md
  }
  return join(homedir(), '.mozilla/managed-storage', `${EXTENSION_ID}.json`);
}

const flags = new Set(process.argv.slice(2));
const fromIndex = process.argv.indexOf('--from');
const source = fromIndex > -1 ? process.argv[fromIndex + 1] : SOURCE;

const FRAGMENT = /\.json$/i;

/** Every fragment, in name order, each carried with its file name for errors. */
function fragments(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FRAGMENT.test(f) && !f.startsWith('.'))
    .sort()
    .map((file) => {
      const path = join(dir, file);
      let raw;
      try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        fail(`${file}: not readable as JSON — ${err.message}`);
      }
      // A fragment may be a bare policy or the full native-manifest wrapper, so
      // that a file which already works on its own can be dropped in unchanged.
      return { file, policy: raw?.type === 'storage' && raw?.data?.policy ? raw.data.policy : raw };
    });
}

const union = (parts) => [...new Set(parts.flat().filter(Boolean))];

/**
 * Merge, and refuse rather than resolve.
 *
 * Two fragments claiming the same rule id is not something to pick a winner
 * for: it means two files believe they own the same rule, and silently keeping
 * one of them is how a rule disappears from a policy nobody edited.
 */
function merge(parts) {
  const seen = new Map();
  const rules = [];
  for (const { file, policy } of parts) {
    for (const rule of policy?.rules ?? []) {
      if (seen.has(rule.id)) {
        fail(`duplicate rule id "${rule.id}" in ${file} — already defined in ${seen.get(rule.id)}`);
      }
      seen.set(rule.id, file);
      rules.push(rule);
    }
  }

  const last = (key, fallback) => {
    for (let i = parts.length - 1; i >= 0; i--) {
      const value = parts[i].policy?.[key];
      if (value !== undefined) return value;
    }
    return fallback;
  };

  return {
    schema: SCHEMA,
    revision: revisionFor(parts),
    // The safe direction wins a disagreement: if ANY fragment asks for dry run,
    // the merged policy is in dry run. Enforcing because one file forgot to say
    // so is the wrong way round.
    dryRun: parts.some((p) => p.policy?.dryRun === true),
    authHosts: union(parts.map((p) => p.policy?.authHosts ?? [])),
    never: union(parts.map((p) => p.policy?.never ?? [])),
    rules,
    bookmarks: last('bookmarks', { folders: [], onConflict: 'leave' }),
    ...['focusGraceMs', 'internalMarginMs', 'claimTtlMs', 'freshMs', 'peers'].reduce((acc, key) => {
      const value = last(key, undefined);
      if (value !== undefined) acc[key] = value;
      return acc;
    }, {}),
  };
}

/**
 * A revision that identifies the INPUTS, not the moment.
 *
 * The popup shows this string and the only question it has to answer is "is
 * what I edited what is running". A timestamp answers "when was it built",
 * which is a different question and looks the same.
 */
function revisionFor(parts) {
  const digest = createHash('sha256')
    .update(parts.map((p) => `${p.file}:${JSON.stringify(p.policy)}`).join('\n'))
    .digest('hex')
    .slice(0, 7);
  const names = parts.map((p) => p.file.replace(/\.json$/i, '')).join('+');
  return `${names}@${digest}`;
}

function fail(message) {
  console.error(`build-policy: ${message}`);
  process.exit(1);
}

const parts = fragments(source);
if (!parts.length) {
  console.error(`build-policy: no .json fragments in ${source}`);
  console.error('Create one — see docs/configuration.md — or pass --from <dir>.');
  process.exit(1);
}

const merged = merge(parts);
const { ok, errors } = validateConfig(merged);
if (!ok) {
  console.error(`build-policy: the merged policy is not valid:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

const { config } = compile(merged);
console.log(`${parts.length} fragment(s) from ${source}:`);
for (const p of parts) console.log(`  ${p.file}  ${(p.policy?.rules ?? []).length} rule(s)`);
console.log(`\nrevision ${config.revision}`);
console.log(`dryRun   ${config.dryRun}`);
console.log(`\n${config.rules.length} rule(s), in the order they will be evaluated:`);
for (const [i, r] of config.rules.entries()) {
  console.log(
    `  ${String(i + 1).padStart(2)}. ${r.match.host ?? r.match.regex}  ->  ${r.to}   [${r.scope}] ${r.id}`,
  );
}

// Printed with the rules, because they decide outcomes exactly as much as a
// rule does — a host on `never` is a rule that always wins. Leaving them off the
// plan would make the rule list look like the whole policy.
if (config.never.length) console.log(`\nnever      ${config.never.join(', ')}`);
if (config.authHosts.length) console.log(`authHosts  ${config.authHosts.join(', ')}`);
const folders = config.bookmarks?.folders ?? [];
if (folders.length) {
  console.log(`bookmarks  ${folders.map((f) => `${f.path} -> ${f.to}`).join(', ')}`);
}

const target = managedPath();
if (!target) fail('on Windows the managed manifest is a registry key — see docs/configuration.md');

if (!flags.has('--apply')) {
  console.log(`\nwould write ${target}`);
  console.log('re-run with --apply to write it, then press Reload policy in the add-on.');
  process.exit(0);
}

mkdirSync(join(target, '..'), { recursive: true });
writeFileSync(
  target,
  `${JSON.stringify(
    {
      name: EXTENSION_ID,
      description: 'container commander policy',
      type: 'storage',
      data: { policy: merged },
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwrote ${target}`);
console.log('Managed storage is read when the add-on starts — press Reload policy in the add-on.');
