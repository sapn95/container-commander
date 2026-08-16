// When the browser last came to the front.
//
// One number, and everything about keeping it is the awkward part. The MV3
// background is an event page: it is torn down when idle and started again for
// whatever it listens for. A focus change and the tab that follows it are two
// separate wake-ups, and a plain variable does not survive between them — which
// would mean the state is unknown on almost every hand-off, and the rule that
// reads it would never fire.
//
// So it goes in `storage.session`: cleared when the browser closes, which is
// exactly the lifetime this has, and never written to disk. In memory as well,
// because within one run of the event page a round trip through storage on a
// blocking request is latency somebody can feel.

/** chrome.windows.WINDOW_ID_NONE — every browser window has lost focus. */
export const WINDOW_ID_NONE = -1;

const KEY = 'focus';

const area = () => (globalThis.chrome && chrome.storage ? chrome.storage.session : null);

// `undefined` means "nothing recorded yet", which is a different answer from
// `{focusedSince: null}` ("the browser is behind something else") and has to
// stay different: the first is seeded below, the second is the truth.
let cached;

/** Off storage, so it can be anything at all. */
function clean(value) {
  if (!value || typeof value !== 'object') return undefined;
  return { focusedSince: Number.isFinite(value.focusedSince) ? value.focusedSince : null };
}

async function write(state) {
  cached = state;
  const a = area();
  // Storage can be absent — an older browser, or one that does not do
  // `session`. The cache alone is still worth something: it lasts for as long
  // as this run of the event page does, which covers the common case of a focus
  // change and the tab that follows it arriving together.
  try {
    if (a) await a.set({ [KEY]: state });
  } catch {
    // Nothing to do and nothing to say: the next read falls back to the cache.
  }
  return state;
}

/** The state, from the cache or from where it outlives this run. */
export async function readFocusState() {
  if (cached) return cached;
  const a = area();
  if (!a) return {};
  let stored;
  try {
    stored = await a.get(KEY);
  } catch {
    return {};
  }
  const value = clean(stored?.[KEY]);
  // Not cached when there is nothing there: caching "unknown" would stop the
  // seed below from ever filling it in.
  if (value) cached = value;
  return value ?? {};
}

/**
 * Record a windows.onFocusChanged.
 *
 * @param {number} windowId - or WINDOW_ID_NONE when the browser lost focus
 */
export async function noteFocusChange(windowId, now = Date.now()) {
  if (!Number.isFinite(windowId) || windowId === WINDOW_ID_NONE) {
    return write({ focusedSince: null });
  }
  // EVERY gain restarts the clock, including moving from one browser window to
  // another. That is not free — it means being asked about a bookmark opened
  // within a second and a half of switching windows — and it is still right.
  //
  // The alternative is to keep the old timestamp when the browser is believed
  // to be in front already, so that a window switch does not count. It reads
  // better and it fails much worse, because the LOSS of focus is the half that
  // is not reliable:
  //
  //   Firefox  bugzilla.mozilla.org/show_bug.cgi?id=1391942 — open since 2017:
  //            leaving a non-browser window (Library, Page Info, the Browser
  //            Console) for another application does not fire WINDOW_ID_NONE.
  //   Chrome   minimising a window has been reported not to fire it either, and
  //            the behaviour differs per platform.
  //
  // With that guard in place, one missed WINDOW_ID_NONE means every later gain
  // is discarded as "already in front", the recorded time stays hours old, and
  // from then on every link handed over by another application looks like
  // something done in here and is silently never asked about — until the next
  // loss of focus that does report itself.
  //
  // Bounded and annoying beats unbounded and silent.
  return write({ focusedSince: now });
}

/**
 * Fill the state in when there is none — the first run after the browser
 * started, before anybody has switched anything.
 *
 * ONLY when there is none. This runs on every wake-up of the event page, and
 * overwriting a real value here would restart the clock several times a minute
 * and make every navigation look like it had just arrived from outside.
 */
export async function seedFocusState(now = Date.now()) {
  const current = await readFocusState();
  if ('focusedSince' in current) return current;
  let window;
  try {
    window = await globalThis.chrome?.windows?.getLastFocused?.({});
  } catch {
    window = null;
  }
  // Read again, because the listener is registered BEFORE this runs and a real
  // focus change can land while getLastFocused is outstanding. What the browser
  // reported beats what this was about to guess.
  //
  // One interleaving fails unsafely, which is why this is not just tidiness: a
  // WINDOW_ID_NONE arrives during the await, getLastFocused answers `focused:
  // true` from before it, and the seed overwrites "gone" with "in front since
  // now". The state then claims a stretch in front that never happened, and a
  // link handed over later than the grace period is silently not asked about.
  const arrived = await readFocusState();
  if ('focusedSince' in arrived) return arrived;
  // `focused` is false when the browser is running behind something else, and
  // undefined on a browser that does not answer. Treating undefined as "not
  // focused" is the safe way round: it records nothing about how long anything
  // has been in front, so the rule that reads it stays out of the way and
  // linkward goes on asking exactly as it did before.
  return write({ focusedSince: window?.focused ? now : null });
}
