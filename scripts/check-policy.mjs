// Validates a policy file, using the extension's OWN validateConfig and
// compile — the same functions the browser runs.
//
// It exists because the interesting question is never "is this JSON" but "will
// the browser accept it, and in what order will it evaluate it". A second
// implementation of that answer is a thing that drifts; there is exactly one
// here and this borrows it.
//
//   node scripts/check-policy.mjs <file.json>
//
// Takes either the managed-storage wrapper or a bare policy, because whoever is
// checking may have only written the inner half yet.

import { readFileSync } from 'node:fs';
import { validateConfig, compile } from '../src/lib/config.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-policy.mjs <file.json>');
  process.exit(2);
}

let raw;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`not readable as JSON: ${err.message}`);
  process.exit(1);
}

// The wrapper is what Firefox reads; the policy is what this validates. Saying
// which one it found is worth a line: a bare policy saved to the managed path
// is ignored by Firefox without a word.
const wrapped = raw?.type === 'storage' && raw?.data?.policy;
const policy = wrapped ? raw.data.policy : raw;
console.log(wrapped ? 'found the native-manifest wrapper' : 'found a bare policy (no wrapper)');

if (!wrapped && raw?.data?.policy === undefined && raw?.rules === undefined) {
  console.error('this has neither data.policy nor rules — is it a policy file at all?');
  process.exit(1);
}

const { ok, errors } = validateConfig(policy);
if (!ok) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const { config } = compile(policy);
console.log(`\nrevision  ${config.revision}`);
console.log(`dryRun    ${config.dryRun}`);
console.log(`\n${config.rules.length} rule(s), in the order they will be evaluated:`);
for (const [i, rule] of config.rules.entries()) {
  const match = rule.match.host ?? rule.match.regex;
  console.log(
    `  ${String(i + 1).padStart(2)}. ${match}  →  ${rule.to}   [${rule.scope}] ${rule.id}`,
  );
}
if (config.never.length) console.log(`\nnever     ${config.never.join(', ')}`);
if (config.authHosts.length) console.log(`authHosts ${config.authHosts.join(', ')}`);
console.log('\nvalid.');
