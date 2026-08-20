// Status, and the two affordances that make managed storage honest.

import { hasWatchPermissions, requestWatchPermissions } from '../lib/permissions.js';

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
}

$('pause').textContent = status?.paused ? 'Resume' : 'Pause for this session';
$('pause').addEventListener('click', async () => {
  const r = await chrome.runtime
    .sendMessage({ type: 'cc:pause', paused: !status?.paused })
    .catch(() => null);
  $('pause').textContent = r?.paused ? 'Resume' : 'Pause for this session';
});

$('reload').addEventListener('click', () => chrome.runtime.reload());

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

  for (const button of document.querySelectorAll('.copy')) {
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
