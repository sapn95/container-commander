// Config validation, compilation and loading.
//
// Shared by the extension AND by the config repo's compiler, so a config that
// compiles is a config the browser will accept, and a config the compiler
// refuses can never reach a browser at all.
//
// Several of the refusals below are the only thing standing between a tired
// evening edit and a repeat of the failure catalogue — and they are refusals
// rather than conventions on purpose. A convention is a comment somebody edits
// past at 23:00 while fixing something else.

import { hostMatches } from './engine.js';

/** The schema version this build speaks. N and N-1 are accepted. */
export const SCHEMA = 1;

const isArray = Array.isArray;
const isString = (v) => typeof v === 'string' && v.length > 0;

/**
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateConfig(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['config is not an object'] };
  }

  // FIRST, before anything else can produce a confusing secondary error: a
  // schema mismatch has a specific remedy and deserves to say which side is
  // behind rather than a generic "invalid config".
  const schema = raw.schema;
  if (schema !== SCHEMA && schema !== SCHEMA - 1) {
    const which =
      Number(schema) > SCHEMA
        ? `config is schema ${schema}, extension supports ${SCHEMA} — update the extension`
        : `config is schema ${schema}, extension supports ${SCHEMA} — recompile the config`;
    return { ok: false, errors: [`schema: ${which}`] };
  }

  if (!isString(raw.revision)) errors.push('revision: missing');

  const authHosts = isArray(raw.authHosts) ? raw.authHosts : [];
  const claimedHosts = isArray(raw.claimedHosts) ? raw.claimedHosts : [];
  const rules = isArray(raw.rules) ? raw.rules : [];
  if (!isArray(raw.rules)) errors.push('rules: must be an array');

  const seen = new Set();
  for (const [i, rule] of rules.entries()) {
    const at = `rules[${i}]`;
    if (!rule || typeof rule !== 'object') {
      errors.push(`${at}: not an object`);
      continue;
    }
    if (!isString(rule.id)) errors.push(`${at}: missing id`);
    else if (seen.has(rule.id)) errors.push(`${at}: duplicate id "${rule.id}"`);
    else seen.add(rule.id);

    // No DEFAULT scope. Guessing one is how a rule meant for outside hand-offs
    // starts firing on things done inside the browser. `any` is allowed but
    // must be written down: the thing worth refusing is a rule whose author
    // never considered the question, not one who answered "both".
    if (!['external', 'internal', 'any'].includes(rule.scope)) {
      errors.push(`${at}: scope must be "external", "internal" or "any"`);
    }

    if (!isString(rule.to)) errors.push(`${at}: missing to`);

    // Asking on an outside hand-off is linkward's monopoly. Two pickers on one
    // territory is the confirm-page race, rebuilt deliberately out of our own
    // parts.
    // `any` includes external, so it may not ask either.
    if (rule.scope !== 'internal' && rule.to === 'ask') {
      errors.push(`${at}: only an internal rule may ask — outside links are linkward's`);
    }

    const m = rule.match;
    if (!m || typeof m !== 'object') {
      errors.push(`${at}: missing match`);
      continue;
    }
    if (isString(m.regex)) {
      try {
        new RegExp(m.regex);
      } catch (err) {
        // Caught at compile time rather than in the hot path, where a throw is
        // holding up somebody's page.
        errors.push(`${at}: regex does not compile — ${err.message}`);
      }
    } else if (isString(m.host)) {
      // The identity-provider yank: the shared sign-in host has no correct
      // fixed answer, so any fixed answer is wrong two thirds of the time. A
      // path- or regex-scoped rule on the same host stays allowed.
      if (!isString(m.path) && authHosts.some((h) => hostMatches(m.host, h))) {
        errors.push(`${at}: bare pin on auth host "${m.host}" — scope it by path or regex`);
      }
      if (claimedHosts.some((h) => hostMatches(m.host, h))) {
        errors.push(`${at}: "${m.host}" is claimed by a launcher — a rule cannot outrank a claim`);
      }
    } else {
      errors.push(`${at}: match needs a host or a regex`);
    }
  }

  const folders = raw.bookmarks?.folders;
  if (folders !== undefined) {
    if (!isArray(folders)) errors.push('bookmarks.folders: must be an array');
    else {
      for (const [i, f] of folders.entries()) {
        // Bookmark ids are per profile: a config keyed by them only works on
        // the machine that wrote it, which is configuration drift in a hat.
        if (f && f.id !== undefined) {
          errors.push(`bookmarks.folders[${i}]: use a folder path, not an id`);
        } else if (!isString(f?.path)) {
          errors.push(`bookmarks.folders[${i}]: missing path`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Order rules by specificity so the ENGINE never sorts.
 *
 * Ordering is a property of the compiled artefact, which is what makes the
 * order the verifier tests byte-identically the order the browser executes.
 */
function specificity(rule) {
  const m = rule.match ?? {};
  if (isString(m.regex)) return [3, m.regex.length];
  const labels = isString(m.host) ? m.host.replace(/^\*\./, '').split('.').length : 0;
  const path = isString(m.path) ? m.path.length : 0;
  return [path ? 2 : 1, labels * 1000 + path];
}

export function compile(raw) {
  const { ok, errors } = validateConfig(raw);
  if (!ok) return { config: null, errors };

  const rules = [...(raw.rules ?? [])].sort((a, b) => {
    const [ta, wa] = specificity(a);
    const [tb, wb] = specificity(b);
    if (ta !== tb) return tb - ta;
    if (wa !== wb) return wb - wa;
    // Ties broken by id, so compilation is deterministic: the same input has to
    // produce byte-identical output or two machines cannot be compared.
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    config: {
      schema: raw.schema,
      revision: raw.revision,
      dryRun: raw.dryRun === true,
      focusGraceMs: raw.focusGraceMs ?? 1500,
      internalMarginMs: raw.internalMarginMs ?? raw.focusGraceMs ?? 1500,
      claimTtlMs: raw.claimTtlMs ?? 10_000,
      freshMs: raw.freshMs ?? 5000,
      authHosts: raw.authHosts ?? [],
      never: raw.never ?? [],
      rules,
      bookmarks: raw.bookmarks ?? { folders: [], onConflict: 'leave' },
      peers: raw.peers ?? [],
    },
    errors: [],
  };
}

const MANAGED_KEY = 'policy';

/**
 * Read the policy from managed storage.
 *
 * Two platform facts shape this, both verified rather than assumed:
 *   - a MISSING native manifest makes storage.managed.get() *reject*. That is a
 *     fresh install, not a failure, so it becomes inert mode — and the caller
 *     still arms the claim receiver, so a peer is never broken by our config.
 *   - managed storage is read once per extension start. There is no onChanged
 *     and no watcher, which is why the popup shows the revision and its age
 *     instead of pretending to be live.
 */
export async function loadConfig(api = globalThis.chrome) {
  let raw;
  try {
    const got = await api?.storage?.managed?.get(MANAGED_KEY);
    raw = got?.[MANAGED_KEY];
  } catch {
    return { config: null, inert: true, errors: ['no managed policy installed'] };
  }
  if (!raw) return { config: null, inert: true, errors: ['no managed policy installed'] };

  const { config, errors } = compile(raw);
  if (!config) return { config: null, inert: true, errors };
  return { config, inert: false, errors: [] };
}
