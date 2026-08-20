// The rule builder.
//
// It validates with the extension's OWN validateConfig and orders with its OWN
// compile — not a second implementation of either. A builder that accepted a
// rule the browser then rejected, or showed an order the browser does not use,
// would be worse than no builder: it would be a confident wrong answer.
//
// It has no save button. That is deliberate and it is the same decision the
// rest of this extension is built on: a rule store the add-on can write is a
// store that drifts from wherever it came from, and comes back after you delete
// it. So this composes bytes and hands them over.

import { validateConfig, compile } from '../lib/config.js';

const $ = (id) => document.getElementById(id);

const status = await chrome.runtime.sendMessage({ type: 'cc:status' }).catch(() => null);

/** A revision that says when, because the popup shows it and "which edit is
 *  live" is the only question it has to answer. */
function revision() {
  return `edited-${new Date().toISOString().slice(0, 10)}`;
}

/** Whatever is loaded now, so "add a rule" starts from reality rather than from
 *  a blank page that would quietly delete the other ten.
 *
 *  The fallback carries a REVISION, and that is not cosmetic: validateConfig
 *  refuses a policy without one, compile() then returns null, and the output
 *  panel goes blank — on the one screen where somebody has nothing yet and
 *  needs it most.
 *  dryRun stays on: a first policy that silently starts moving tabs is a bad
 *  introduction. */
const base = status?.config ?? { schema: 1, revision: revision(), dryRun: true, rules: [] };
const rules = [...(base.rules ?? [])];

const containers = await listContainers();
fillTargets(containers);
$('path').textContent = managedPath();
$('back').href = chrome.runtime.getURL('popup/popup.html');

render();

$('add').addEventListener('click', onAdd);
for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', async () => {
    const ok = await navigator.clipboard.writeText($(button.dataset.copy).textContent).then(
      () => true,
      () => false,
    );
    const was = button.textContent;
    button.textContent = ok ? 'Copied' : 'Select it and copy';
    setTimeout(() => {
      button.textContent = was;
    }, 1600);
  });
}

function onAdd() {
  const pattern = $('pattern').value.trim();
  const id = $('id').value.trim() || slug(pattern);
  const kind = $('kind').value;
  const rule = {
    id,
    scope: $('scope').value,
    match: kind === 'host' ? { host: pattern } : { regex: pattern },
    to: $('to').value,
  };

  if (!pattern) return say('Give it an address first.');

  // Validated as part of the WHOLE policy, not on its own: the refusals that
  // matter — a bare pin on an auth host, ask on an external rule, a duplicate
  // id — are all about the rule's relationship to everything else.
  const candidate = { ...base, rules: [...rules, rule] };
  const { ok, errors } = validateConfig(candidate);
  if (!ok) return say(errors.join(' · '));

  rules.push(rule);
  $('pattern').value = '';
  $('id').value = '';
  say(`Added. ${rules.length} rule(s).`);
  render();
}

function say(message) {
  $('say').textContent = message;
}

function render() {
  const { config, errors } = compile({ ...base, rules });
  const list = $('rulelist');
  list.replaceChildren();

  if (!config) {
    $('count').textContent = errors.join(' · ');
    $('out').textContent = '';
    return;
  }

  // Shown in compile()'s order, which is the order the browser will use and not
  // the order they were typed in.
  for (const rule of config.rules) {
    const li = document.createElement('li');
    const match = document.createElement('span');
    match.className = 'match';
    match.textContent = rule.match.host ?? rule.match.regex ?? '';
    const to = document.createElement('span');
    to.className = rule.to === 'ask' ? 'to ask' : 'to';
    to.textContent = rule.to === 'ask' ? ' → ask' : ` → ${rule.to}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `  ${rule.scope} · ${rule.id}`;
    li.append(match, to, meta);
    list.append(li);
  }

  $('count').textContent =
    `${config.rules.length} rule(s), in the order they will be evaluated — first match wins.`;

  $('out').textContent = `${JSON.stringify(
    {
      name: chrome.runtime.id,
      description: 'container commander policy',
      type: 'storage',
      data: { policy: { ...config, revision: revision() } },
    },
    null,
    2,
  )}\n`;
}

function slug(pattern) {
  return (
    String(pattern)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'rule'
  );
}

async function listContainers() {
  try {
    const list = await globalThis.browser?.contextualIdentities?.query({});
    return (list ?? []).map((c) => c.name);
  } catch {
    return [];
  }
}

function fillTargets(names) {
  const select = $('to');
  select.replaceChildren();
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  // Only an internal rule may ask, and validateConfig enforces that — the
  // option is offered and the refusal explains itself rather than being hidden.
  const ask = document.createElement('option');
  ask.value = 'ask';
  ask.textContent = 'ask me (internal only)';
  select.append(ask);
  if (!names.length) say('No containers found — create one in Firefox first.');
}

function managedPath() {
  const id = chrome.runtime.id;
  const ua = navigator.userAgent;
  if (ua.includes('Macintosh')) {
    return `~/Library/Application Support/Mozilla/ManagedStorage/${id}.json`;
  }
  if (ua.includes('Windows')) {
    return `HKEY_CURRENT_USER\\Software\\Mozilla\\ManagedStorage\\${id}`;
  }
  return `~/.mozilla/managed-storage/${id}.json`;
}
