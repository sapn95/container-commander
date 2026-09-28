// Status, and the two affordances that make managed storage honest.

import { hasWatchPermissions, requestWatchPermissions } from '../lib/permissions.js';
import { standDownHosts, allStandingDown } from '../lib/census.js';

const $ = (id) => document.getElementById(id);

const status = await chrome.runtime.sendMessage({ type: 'cc:status' }).catch(() => null);

$('version').textContent =
  `container commander ${chrome.runtime.getManifest?.()?.version ?? ''}`.trim();

if (!status) {
  $('revision').textContent = 'the background page did not answer';
} else if (status.inert) {
  // A missing managed manifest makes storage.managed.get() reject, and that is
  // a fresh install rather than a failure. Saying so plainly was the old
  // behaviour and it was not enough: "no policy installed" is a diagnosis, and
  // a person who has just installed this from the store needs the next step.
  // So the whole setup screen comes out instead.
  $('revision').textContent = 'no policy installed — nothing is being routed';
  $('state').textContent = status.errors?.join('; ') ?? '';
  showSetup();
} else {
  $('revision').textContent = status.config.revision;
  const dry = status.config.dryRun ? ' · dry run: deciding but not enforcing' : '';
  $('state').textContent = `${status.config.rules.length} rule(s)${dry}`;
  showRules(status.config);
}

// Held in a variable rather than read back off `status`, which is the reply to
// one message sent when the page opened and never changes again. Toggling
// against it sent `paused: true` on the first click and `paused: true` again on
// the second, so Pause worked and the Resume it turned into did nothing.
let paused = status?.paused === true;

function showPaused(next) {
  paused = next === true;
  $('pause').textContent = paused ? 'Resume' : 'Pause for this session';
  // The clash block offers the same stop under another name, so it follows the
  // same state. Resuming from Policy below used to leave it reading "Routing
  // stopped here", disabled, over a browser that had started routing again.
  if (!$('clash').hidden) showStandDown();
}

async function setPaused(next) {
  const r = await chrome.runtime.sendMessage({ type: 'cc:pause', paused: next }).catch(() => null);
  // The reply is the authority, not the argument: a background page that did
  // not answer has not paused, and a button that says it did is worse than one
  // that says nothing.
  if (r) showPaused(r.paused);
  return r !== null;
}

showPaused(paused);
$('pause').addEventListener('click', () => setPaused(!paused));

$('reload').addEventListener('click', () => chrome.runtime.reload());

// Asked here rather than read off the status, because it costs two cross-
// extension round trips and the background page holds requests open. Opening
// this page is the moment somebody wants the answer; nothing else pays for it.
showClash(await chrome.runtime.sendMessage({ type: 'cc:peers' }).catch(() => null));

function showClash(peers) {
  // One guard, and it covers the loop below too: clashLine() returns null for an
  // empty list, so a line to print means `clash` is a non-empty list of entries
  // clashes() built, each with its own overlap and routes arrays. The only other
  // reply cc:peers can send is `{clash: [], line: null}`, which stops here.
  if (!peers?.line) return;
  const settled = allStandingDown(peers.clash);
  // Not an alarm once the other add-on has given way. The block still says who
  // else is routing and what is left over, because something IS left over — a
  // host reopened from a bookmark folder matched no rule and is on no published
  // list — but red edges and a heading in the alert colour are for a browser
  // opening two tabs, and it is not doing that any more.
  $('clash').classList.toggle('state', !settled);
  $('clash').classList.toggle('settled', settled);
  document.querySelector('#clash h2').textContent = settled
    ? 'linkward is giving way to this add-on'
    : 'Two add-ons are routing this browser';
  $('clash-standdown').classList.toggle('primary', !settled);
  $('clash').hidden = false;
  $('clash-line').textContent = peers.line;
  wireStandDown(peers.clash);
  const list = $('clash-list');
  list.replaceChildren();
  for (const other of peers.clash) {
    const li = document.createElement('li');
    const who = document.createElement('b');
    who.textContent = [other.name, other.version].filter(Boolean).join(' ');
    li.append(who);
    // The overlap, not its whole rule list. What a person needs in order to act
    // is the hosts BOTH of them claim: those are the tabs arriving in pairs, and
    // they are what to search for in the other add-on's settings.
    const shared = other.overlap.length ? other.overlap : other.routes;
    if (shared.length) {
      const what = document.createElement('span');
      what.className = 'url';
      what.textContent = ` ${other.overlap.length ? 'also routes' : 'routes'} ${shared.join(', ')}`;
      li.append(what);
    }
    list.append(li);
  }
}

/**
 * The one decision this popup can carry out, and the paste-ready version of the
 * one it cannot.
 *
 * Standing down is pausing. That is the whole of it: routingState() reports
 * `routing: false` while paused, so the peer's own warning clears on its next
 * census too, and the pair really is over rather than merely quieter here. It
 * lasts until Firefox restarts, which the note under the button says, because a
 * fix that silently expires overnight is how this bug got a second life.
 */
function wireStandDown(clash) {
  const button = $('clash-standdown');

  // Built from the peers on screen, so the snippet and the sentence above it
  // are describing the same census rather than two reads a second apart.
  const hosts = standDownHosts(clash);
  $('clash-never').textContent = hosts.length
    ? JSON.stringify({ never: hosts }, null, 2)
    : '// The other add-on published no hosts, so there is nothing to name here.\n' +
      '// Pause above, or switch its interception off.';
  wireCopyButtons();

  showStandDown();

  button.addEventListener('click', async () => {
    button.disabled = true;
    // setPaused reports the new state, and showPaused redraws this block from
    // it — so the success path needs nothing here. Only the failure does.
    if (await setPaused(true)) return;
    button.disabled = false;
    $('clash-standdown-note').textContent =
      'The background page did not answer, so nothing was paused. Try again, or use Pause under ' +
      'Policy below.';
  });
}

/**
 * Draw the stand-down from whatever the pause state now is.
 *
 * One function for both directions, because the two used to be written
 * separately and the resume half was simply missing: Pause under Policy would
 * start routing again while this block still read "Routing stopped here".
 */
function showStandDown() {
  const button = $('clash-standdown');
  button.disabled = paused;
  button.textContent = paused ? 'Routing stopped here' : 'Stop routing here';
  $('clash-standdown-note').textContent = paused
    ? 'Paused until Firefox restarts, so the other add-on has these tabs to itself. Resume is ' +
      'under Policy below. To make it last, see the policy edit above.'
    : 'Pauses container commander until Firefox restarts, so the other add-on keeps the tabs to ' +
      'itself. To decide it the other way round, switch interception off in that add-on instead — ' +
      'nothing here can do it for you.';
}

// Checked after the status, shown above it. Without this grant the extension is
// structurally unable to decide anything, so it outranks every other thing this
// page could be telling you — including "no policy installed".
if (!(await hasWatchPermissions())) {
  $('grant').hidden = false;
  $('log-empty').textContent = 'Nothing can be decided until watching is turned on, above.';
}

$('grant-button').addEventListener('click', async (event) => {
  // FIRST, before any await. A handler stops being user-initiated the moment it
  // awaits anything, and permissions.request then fails with no explanation.
  const granted = await requestWatchPermissions();
  event.target.disabled = true;
  if (granted) {
    // permissions.onAdded arms the listener in the background page already, so
    // there is nothing to restart — but the page in front of you is now stale.
    $('grant-note').textContent = 'Granted. Reloading this page…';
    location.reload();
    return;
  }
  event.target.disabled = false;
  $('grant-note').textContent =
    'Firefox refused, or the request was dismissed. Nothing will be decided until it is allowed — ' +
    'you can also grant it in about:addons under this add-on, on the Permissions tab.';
});

const entries = status?.log ?? [];
$('log-empty').hidden = entries.length > 0;
for (const e of entries) {
  const li = document.createElement('li');
  const host = document.createElement('span');
  host.className = 'host';
  // textContent: these are addresses somebody visited.
  host.textContent = e.url;
  const verdict = document.createElement('span');
  verdict.className = 'verdict';
  verdict.textContent = `${e.decision.action}·${e.decision.rung}`;
  verdict.title = e.decision.reason ?? '';
  li.append(host, verdict);
  $('log').append(li);
}

/**
 * The path Firefox reads the policy from, which is per-platform and is the one
 * thing a reader cannot guess.
 *
 * Derived from the user agent because an extension has no OS API. Wrong is
 * survivable here — the file is named on screen either way and the linked doc
 * lists all three — where a missing path is not.
 */
function managedPath() {
  const id = chrome.runtime.id;
  const ua = navigator.userAgent;
  if (ua.includes('Macintosh')) {
    return {
      path: `~/Library/Application Support/Mozilla/ManagedStorage/${id}.json`,
      note: 'macOS. Create the ManagedStorage folder if it is not there yet.',
    };
  }
  if (ua.includes('Windows')) {
    return {
      path: `HKEY_CURRENT_USER\\Software\\Mozilla\\ManagedStorage\\${id}`,
      note: 'Windows keeps this in the registry: a key of that name whose default value is the full path to your .json file.',
    };
  }
  return {
    path: `~/.mozilla/managed-storage/${id}.json`,
    note: 'Linux. Create the managed-storage folder if it is not there yet.',
  };
}

/** A policy that is valid, does one obvious thing, and enforces nothing. */
function samplePolicy() {
  return JSON.stringify(
    {
      name: chrome.runtime.id,
      description: 'container commander policy',
      type: 'storage',
      data: {
        policy: {
          schema: 1,
          revision: 'hand-written-1',
          dryRun: true,
          rules: [{ id: 'example', scope: 'any', match: { host: 'example.com' }, to: 'Work' }],
        },
      },
    },
    null,
    2,
  );
}

function showSetup() {
  const { path, note } = managedPath();
  $('managed-path').textContent = path;
  $('managed-note').textContent = note;
  $('sample').textContent = samplePolicy();
  $('setup').hidden = false;

  wireCopyButtons();
}

/** Shared by the setup screen and the rule list. */
function wireCopyButtons() {
  for (const button of document.querySelectorAll('.copy')) {
    if (button.dataset.wired) continue;
    button.dataset.wired = '1';
    button.addEventListener('click', async () => {
      const text = $(button.dataset.copy).textContent;
      // The clipboard can be refused, and a button that silently did nothing
      // would be this screen making the same mistake twice.
      const ok = await navigator.clipboard.writeText(text).then(
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
}

/** What a rule matches on, as the shortest true description of it. */
function matchOf(rule) {
  const m = rule.match ?? {};
  if (m.host) return { kind: 'host', text: m.host + (m.path ? m.path : '') };
  if (m.regex) return { kind: 'regex', text: m.regex };
  return { kind: '?', text: '(nothing)' };
}

function showRules(config) {
  const list = $('rulelist');
  list.replaceChildren();

  for (const rule of config.rules ?? []) {
    const { kind, text } = matchOf(rule);
    const li = document.createElement('li');

    const match = document.createElement('span');
    match.className = 'match';
    // textContent throughout: a rule is a string from a file, and this page has
    // no business interpreting any of it as markup.
    match.textContent = text;
    match.title = `${kind}: ${text}`;

    const arrow = document.createElement('span');
    arrow.className = rule.to === 'ask' ? 'to ask' : 'to';
    arrow.textContent = rule.to === 'ask' ? ' → ask' : ` → ${rule.to}`;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `  ${rule.scope} · ${rule.id}`;

    li.append(match, arrow, meta);
    list.append(li);
  }

  // never and authHosts are rules in every sense that matters — they decide
  // outcomes — and leaving them off the page would make the list above look
  // like the whole policy when it is not.
  const lists = $('lists');
  lists.replaceChildren();
  const dl = document.createElement('dl');
  dl.className = 'hostlist';
  const section = (label, hosts, why) => {
    if (!hosts?.length) return;
    const dt = document.createElement('dt');
    dt.textContent = `${label} — ${why}`;
    const dd = document.createElement('dd');
    dd.textContent = hosts.join(', ');
    dl.append(dt, dd);
  };
  section('Never', config.never, 'no rule may act on these');
  section('Auth hosts', config.authHosts, 'shared by every identity, so never pinned by hostname');
  section(
    'Bookmark folders',
    (config.bookmarks?.folders ?? []).map((f) => `${f.path} → ${f.to}`),
    'the weakest signal, and only for entries begun in the browser',
  );
  if (dl.children.length) lists.append(dl);

  $('rules-path').textContent = managedPath().path;
  // Optional-chained on purpose. The link is the least important thing on this
  // page and the rule list is the most, so a browser that cannot answer must
  // cost the link and not the list.
  const builder = chrome.runtime.getURL?.('edit/edit.html');
  if (builder) $('builder').href = builder;
  else $('builder').remove();
  $('rules-section').hidden = false;
  wireCopyButtons();
}
