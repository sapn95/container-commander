// Vendored VERBATIM from linkward, together with the module it tests.
//
// Copying the tests as well as the code is the point: focus.js is a byte-for-
// byte copy, and this suite is what proves the copy still behaves like the
// original. A vendored module with no vendored tests is a fork nobody has
// noticed yet.
//
// Upstream: https://github.com/sapn95/linkward/blob/main/tests/focus.test.js

// Keeping one number alive across an event page that is torn down whenever the
// browser feels like it.
//
// Everything here is about the two ways this fails quietly:
//   - the number is LOST between the focus change and the tab that follows it,
//     and the rule that reads it never fires — the bug stays;
//   - the number is RESET by something that is not the browser coming to the
//     front, and every navigation starts looking like a hand-off — the rule
//     fires when it must not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function makeArea() {
  const store = {};
  return {
    store,
    get: vi.fn(async (k) => (k in store ? { [k]: store[k] } : {})),
    set: vi.fn(async (o) => Object.assign(store, o)),
  };
}

/**
 * @param {object} over
 * @param {object|null} over.session - storage.session, or null for a browser
 *   without one
 * @param {object|null|Error} over.lastFocused - what windows.getLastFocused says
 */
function makeChrome({ session = makeArea(), lastFocused = { id: 1, focused: true } } = {}) {
  return {
    storage: session ? { session } : {},
    windows: {
      getLastFocused: vi.fn(async () => {
        if (lastFocused instanceof Error) throw lastFocused;
        return lastFocused;
      }),
    },
  };
}

/** A fresh module every time: the cache inside it is module-level on purpose. */
async function load(chrome) {
  globalThis.chrome = chrome;
  vi.resetModules();
  return import('../src/lib/focus.js');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete globalThis.chrome;
});

describe('recording a focus change', () => {
  it('remembers when the browser came to the front', async () => {
    const c = makeChrome();
    const { noteFocusChange, readFocusState } = await load(c);
    await noteFocusChange(3, 5000);
    expect(await readFocusState()).toEqual({ focusedSince: 5000 });
  });

  it('records losing focus as a state of its own, not as "unknown"', async () => {
    // null and missing lead to the same decision today, but they are different
    // facts: one is seeded over by seedFocusState, the other must not be.
    const c = makeChrome();
    const { noteFocusChange, readFocusState, WINDOW_ID_NONE } = await load(c);
    // The value the browsers actually send, not a -1 that happens to match.
    expect(WINDOW_ID_NONE).toBe(-1);
    await noteFocusChange(WINDOW_ID_NONE, 5000);
    expect(await readFocusState()).toEqual({ focusedSince: null });
  });

  it('treats a nonsense window id as a loss of focus', async () => {
    const c = makeChrome();
    const { noteFocusChange, readFocusState } = await load(c);
    await noteFocusChange(undefined, 5000);
    expect(await readFocusState()).toEqual({ focusedSince: null });
  });

  it('restarts the clock on every gain, even between two browser windows', async () => {
    // The tempting optimisation is to keep the old timestamp here, so that
    // moving from one browser window to another does not count as the browser
    // coming to the front. It reads better and it fails much worse: Chrome does
    // not always report the LOSS of focus, and with that guard one missed
    // WINDOW_ID_NONE makes every later gain a no-op. The recorded time then
    // stays hours old and every link handed over by another application looks
    // like something done in here — silently never asked about again.
    //
    // Restarting costs a question if you open a bookmark within a second and a
    // half of switching windows. Bounded and annoying beats unbounded and
    // silent, so this asserts the restart on purpose.
    const c = makeChrome();
    const { noteFocusChange, readFocusState } = await load(c);
    await noteFocusChange(1, 1000);
    await noteFocusChange(2, 9000);
    expect(await readFocusState()).toEqual({ focusedSince: 9000 });
  });

  it('recovers on the next gain when a loss of focus was never reported', async () => {
    // The failure the rule above exists for, played out: the browser goes
    // behind Slack without saying so, and the link comes back with the gain.
    // That gain has to be believed, or the hand-off is never asked about.
    const c = makeChrome();
    const { noteFocusChange, readFocusState } = await load(c);
    await noteFocusChange(1, 1000);
    // …no WINDOW_ID_NONE here. Chrome simply did not send one.
    await noteFocusChange(1, 600_000);
    expect(await readFocusState()).toEqual({ focusedSince: 600_000 });
  });

  it('does restart it after the browser actually went away', async () => {
    const c = makeChrome();
    const { noteFocusChange, readFocusState } = await load(c);
    await noteFocusChange(1, 1000);
    await noteFocusChange(-1, 4000);
    await noteFocusChange(1, 9000);
    expect(await readFocusState()).toEqual({ focusedSince: 9000 });
  });

  it('writes it where it outlives this run of the event page', async () => {
    // The whole reason this module exists. A plain variable is gone by the time
    // the tab it explains shows up.
    const session = makeArea();
    const { noteFocusChange } = await load(makeChrome({ session }));
    await noteFocusChange(1, 1000);
    expect(session.store.focus).toEqual({ focusedSince: 1000 });
  });
});

describe('after the event page has been torn down and started again', () => {
  it('reads the number back rather than starting from nothing', async () => {
    const session = makeArea();
    const first = await load(makeChrome({ session }));
    await first.noteFocusChange(1, 1000);

    // A new run of the background: same storage, no memory.
    const second = await load(makeChrome({ session }));
    expect(await second.readFocusState()).toEqual({ focusedSince: 1000 });
  });

  it('does not seed over the number it just read back', async () => {
    // seedFocusState runs on every wake-up. Overwriting a real value with "now"
    // would reset the clock several times a minute and defeat the whole rule.
    const session = makeArea();
    const first = await load(makeChrome({ session }));
    await first.noteFocusChange(1, 1000);

    const c = makeChrome({ session });
    const second = await load(c);
    await second.seedFocusState(50_000);
    expect(await second.readFocusState()).toEqual({ focusedSince: 1000 });
    expect(c.windows.getLastFocused).not.toHaveBeenCalled();
  });

  it('does not seed over a recorded loss of focus either', async () => {
    const session = makeArea();
    const first = await load(makeChrome({ session }));
    await first.noteFocusChange(-1, 1000);

    const c = makeChrome({ session });
    const second = await load(c);
    await second.seedFocusState(50_000);
    expect(await second.readFocusState()).toEqual({ focusedSince: null });
    expect(c.windows.getLastFocused).not.toHaveBeenCalled();
  });
});

describe('seeding, when nothing has been recorded at all', () => {
  it('asks the browser whether it is in front, and starts the clock there', async () => {
    const c = makeChrome({ lastFocused: { id: 1, focused: true } });
    const { seedFocusState, readFocusState } = await load(c);
    await seedFocusState(5000);
    expect(await readFocusState()).toEqual({ focusedSince: 5000 });
  });

  it('records "behind something else" when it is', async () => {
    const c = makeChrome({ lastFocused: { id: 1, focused: false } });
    const { seedFocusState, readFocusState } = await load(c);
    await seedFocusState(5000);
    expect(await readFocusState()).toEqual({ focusedSince: null });
  });

  it('survives a browser that will not answer', async () => {
    for (const lastFocused of [new Error('no windows'), null, {}, { id: 1 }]) {
      const c = makeChrome({ lastFocused });
      const { seedFocusState, readFocusState } = await load(c);
      await expect(seedFocusState(5000)).resolves.toBeDefined();
      // Not "in front for ages": an unanswered question must not become
      // evidence that somebody clicked a bookmark.
      expect(await readFocusState()).toEqual({ focusedSince: null });
    }
  });

  it('keeps a focus change that landed while it was asking the browser', async () => {
    // The listener is armed BEFORE the seed runs, so a real focus change can
    // arrive during the await — and the one that matters is the browser going
    // AWAY. getLastFocused then answers `focused: true` from the moment before
    // it, and a seed that overwrote the loss would record a stretch in front
    // that never happened. Anything handed over later than the grace period
    // would be taken for something done in the browser, and silently not asked
    // about.
    let answer;
    const c = makeChrome();
    c.windows.getLastFocused = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const { seedFocusState, noteFocusChange, readFocusState, WINDOW_ID_NONE } = await load(c);

    const seeding = seedFocusState(5000);
    await Promise.resolve();
    await noteFocusChange(WINDOW_ID_NONE, 5001);
    answer({ id: 1, focused: true });
    await seeding;

    expect(await readFocusState()).toEqual({ focusedSince: null });
  });

  it('keeps a recorded gain that landed during the same await', async () => {
    // The mirror, which is safe either way — but a seed that clobbered it would
    // restart the clock and turn a bookmark back into a question.
    let answer;
    const c = makeChrome({ lastFocused: null });
    c.windows.getLastFocused = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const { seedFocusState, noteFocusChange, readFocusState } = await load(c);

    const seeding = seedFocusState(5000);
    await Promise.resolve();
    await noteFocusChange(1, 1000);
    answer(null);
    await seeding;

    expect(await readFocusState()).toEqual({ focusedSince: 1000 });
  });

  it('survives getLastFocused resolving nothing at all', async () => {
    const c = makeChrome();
    c.windows.getLastFocused = vi.fn(async () => undefined);
    const { seedFocusState, readFocusState } = await load(c);
    await expect(seedFocusState(5000)).resolves.toBeDefined();
    expect(await readFocusState()).toEqual({ focusedSince: null });
  });

  it('survives a browser with no windows API at all', async () => {
    // Firefox for Android, among others.
    const c = makeChrome();
    delete c.windows;
    const { seedFocusState, readFocusState } = await load(c);
    await expect(seedFocusState(5000)).resolves.toBeDefined();
    expect(await readFocusState()).toEqual({ focusedSince: null });
  });
});

describe('when storage.session is not there', () => {
  it('says it knows nothing rather than throwing into a blocking handler', async () => {
    // readFocusState is awaited inside the one place in this extension where a
    // thrown error is holding up somebody's page.
    const { readFocusState } = await load(makeChrome({ session: null }));
    expect(await readFocusState()).toEqual({});
  });

  it('still remembers for as long as this run of the event page lasts', async () => {
    // Which covers the ordinary case: the focus change and the tab that follows
    // it arrive within the same wake-up.
    const { noteFocusChange, readFocusState } = await load(makeChrome({ session: null }));
    await noteFocusChange(1, 1000);
    expect(await readFocusState()).toEqual({ focusedSince: 1000 });
  });

  it('does not let a failing write take the value with it', async () => {
    const session = makeArea();
    session.set = vi.fn(async () => {
      throw new Error('QUOTA_BYTES quota exceeded');
    });
    const { noteFocusChange, readFocusState } = await load(makeChrome({ session }));
    await expect(noteFocusChange(1, 1000)).resolves.toEqual({ focusedSince: 1000 });
    expect(await readFocusState()).toEqual({ focusedSince: 1000 });
  });

  it('does not let a failing read throw either', async () => {
    const session = makeArea();
    session.get = vi.fn(async () => {
      throw new Error('storage is not available');
    });
    const { readFocusState } = await load(makeChrome({ session }));
    expect(await readFocusState()).toEqual({});
  });
});

describe('what is already in storage', () => {
  it('ignores a value some other version or bug left there', async () => {
    for (const junk of ['yes', 42, [], { focusedSince: 'soon' }, { focusedSince: NaN }]) {
      const session = makeArea();
      session.store.focus = junk;
      const { readFocusState } = await load(makeChrome({ session }));
      const state = await readFocusState();
      // Either "unknown" or "not in front" — never a number that would make
      // linkward skip a link it should have asked about.
      expect(state.focusedSince == null).toBe(true);
    }
  });

  it('keeps a real number', async () => {
    const session = makeArea();
    session.store.focus = { focusedSince: 1234 };
    const { readFocusState } = await load(makeChrome({ session }));
    expect(await readFocusState()).toEqual({ focusedSince: 1234 });
  });

  it('reads storage once and then answers from memory', async () => {
    // This is awaited on every intercepted request, inside a blocking listener.
    const session = makeArea();
    session.store.focus = { focusedSince: 1234 };
    const { readFocusState } = await load(makeChrome({ session }));
    await readFocusState();
    await readFocusState();
    await readFocusState();
    expect(session.get).toHaveBeenCalledTimes(1);
  });
});
