// Status, and the two affordances that make managed storage honest.

const $ = (id) => document.getElementById(id);

const status = await chrome.runtime.sendMessage({ type: 'cc:status' }).catch(() => null);

$('version').textContent =
  `container commander ${chrome.runtime.getManifest?.()?.version ?? ''}`.trim();

if (!status) {
  $('revision').textContent = 'the background page did not answer';
} else if (status.inert) {
  // A missing managed manifest makes storage.managed.get() reject, and that is
  // a fresh install rather than a failure. It is said plainly, because an
  // extension that is silently doing nothing looks exactly like one that is
  // silently doing the wrong thing.
  $('revision').textContent = 'no policy installed — nothing is being routed';
  $('state').textContent = status.errors?.join('; ') ?? '';
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
