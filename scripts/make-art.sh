#!/usr/bin/env bash
#
# Regenerates every picture this repository ships: the store screenshot at 1x
# and 2x, and assets/popup.png for the README.
#
# assets/popup.png is a REAL capture. src/popup/popup.js and src/pick/pick.css
# are copied byte for byte into a temp directory, popup.html gains exactly two
# <script> tags — a stub `chrome` object ahead of the module, answering only the
# messages the popup sends, and a one-line height probe after it — and nothing
# else is touched. So the picture is the shipped code laying out example data,
# not a drawing of it. The store screenshot is still a hand-staged redraw and
# says so in its own head; it is captured here because it is what the listing
# uses.
#
# Chrome headless is the whole toolchain. Two traps, both paid for:
#
#   --user-data-dir hangs. Chrome writes the PNG correctly and then never
#   exits. A run that looks fine locally will sit on a CI runner until the job
#   times out. Do not add it, not even to keep a profile out of the way.
#
#   file:// refuses ES modules. popup.js is loaded as type="module", so without
#   --allow-file-access-from-files the load is a CORS failure, popup.js never
#   runs, and the capture is a page that says "reading…". That wall is why
#   docs/store/screenshot.html exists as a redraw in the first place.
#
# Usage: npm run art   (CHROME=/path/to/chrome overrides the binary)

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CHROME=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
[ -x "$CHROME" ] || {
  echo "make-art: no Chrome at $CHROME (set CHROME=...)" >&2
  exit 1
}

# Example data. Same vocabulary as docs/store/screenshot.html on purpose: the
# two pictures are of the same imaginary machine, and example-*.com hostnames
# are what scripts/leak-lint.mjs allows. Never a real host here.
REVISION='policy-2026.08.16-a1b2c3d'

# The popup prints chrome.runtime.getManifest().version, so the stub reads the
# real manifest rather than carrying a number of its own — a picture that
# claims a version the extension does not have is the same lie as a redraw.
# package.json, NOT src/manifest.json. The manifest in src/ carries a
# placeholder; scripts/build.mjs stamps the real version into dist/ at build
# time. Reading the placeholder is how the first run of this script produced a
# README picture captioned 0.1.0 on the day 0.2.0 went to the store.
VERSION=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)
[ -n "$VERSION" ] || {
  echo 'make-art: could not read "version" from package.json' >&2
  exit 1
}

# Chrome's screenshot size is version-specific — scale factors and window
# insets have both moved between releases. Assert it every time: an asset that
# is quietly the wrong size is worse than a build that stops.
assert_size() {
  local file=$1 want_w=$2 want_h=$3 got
  [ -f "$file" ] || {
    echo "make-art: $file was never written — Chrome exited without a screenshot" >&2
    exit 1
  }
  got=$(sips -g pixelWidth -g pixelHeight "$file" | awk '/pixel(Width|Height)/ {print $2}' | paste -sd x -)
  if [ "$got" != "${want_w}x${want_h}" ]; then
    echo "make-art: $file is ${got}, expected ${want_w}x${want_h}" >&2
    exit 1
  fi
  echo "  $(basename "$file")  ${got}  $(wc -c <"$file" | tr -d ' ') bytes"
}

# $1 out, $2 css width, $3 css height, $4 url, rest: extra flags.
# For 2x pass --force-device-scale-factor=2 and KEEP the 1x window size:
# doubling the window instead letterboxes a fixed-size stage.
capture() {
  local out=$1 w=$2 h=$3 url=$4
  shift 4
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --window-size="$w,$h" --screenshot="$out" "$@" "$url" >/dev/null 2>&1
}

echo "make-art: store screenshot (staged redraw, docs/store/screenshot.html)"
STORE_URL="file://$ROOT/docs/store/screenshot.html"
# 01-popup.png is the one the listing carries, at 2x. The 1x is kept for
# anywhere that wants the plain size, and its name deliberately does NOT begin
# with two digits: scripts/amo-art.mjs uploads every /^\d{2}-.+\.png$/ in this
# directory as a screenshot, so a numbered sibling would post the same picture
# to the store twice.
capture "$ROOT/docs/store/screenshot-1x.png" 1280 800 "$STORE_URL"
assert_size "$ROOT/docs/store/screenshot-1x.png" 1280 800
capture "$ROOT/docs/store/01-popup.png" 1280 800 "$STORE_URL" --force-device-scale-factor=2
assert_size "$ROOT/docs/store/01-popup.png" 2560 1600

echo "make-art: README popup (real capture, src/popup/*)"
mkdir -p "$ROOT/assets"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pick" "$STAGE/popup"
cp "$ROOT/src/pick/pick.css" "$STAGE/pick/pick.css"
cp "$ROOT/src/popup/popup.js" "$STAGE/popup/popup.js"

# The harness. Only what popup.js actually calls — a stub that answered more
# than that would be a second, wrong implementation of the background page.
cat >"$STAGE/popup/cc-stub.js" <<STUB
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '$VERSION' }),
    reload: () => {},
    sendMessage: async (msg) => {
      if (msg && msg.type === 'cc:pause') return { paused: msg.paused };
      return {
        inert: false,
        errors: [],
        paused: false,
        // dryRun stays off so the log can show a reopen: under dry run the
        // engine returns leave/dry-run for everything, and a picture with
        // both would be showing a state the code cannot produce.
        config: { revision: '$REVISION', dryRun: false, rules: new Array(11).fill(null) },
        // Newest first, the order background.js keeps. Six rungs of the
        // ladder, including the ones whose answer was to do nothing — that
        // is the product.
        log: [
          {
            url: 'https://flow.example-corp.com/browse/X-1',
            decision: { action: 'reopen', rung: 4, container: 'work' },
          },
          {
            url: 'https://login.example-idp.com/oauth2/authorize',
            decision: { action: 'leave', rung: 2, reason: 'started-by-document' },
          },
          {
            url: 'https://console.example-cloud.com/home',
            decision: { action: 'leave', rung: 1, reason: 'claim:pending' },
          },
          {
            url: 'https://eu-1.console.example-cloud.com/ec2',
            decision: { action: 'leave', rung: 4, reason: 'never-host' },
          },
          {
            url: 'https://docs.example.com/handbook/travel',
            decision: { action: 'leave', rung: 2, reason: 'user-container-entry' },
          },
          {
            url: 'https://intranet.example.com/expenses',
            decision: { action: 'leave', rung: 0, reason: 'method:POST' },
          },
        ],
      };
    },
  },
};
STUB

# One classic script ahead of the module, so the stub exists before popup.js
# runs, and one module after it to report the rendered height. Both are added
# to the COPY; the markup they bracket is the shipped file, byte for byte.
cat >"$STAGE/popup/cc-measure.js" <<'MEASURE'
document.title = `cc-height:${Math.ceil(document.body.getBoundingClientRect().bottom)}`;
MEASURE
sed -e 's|<script type="module" src="popup.js">|<script src="cc-stub.js"></script><script type="module" src="popup.js">|' \
  -e 's|</body>|<script type="module" src="cc-measure.js"></script></body>|' \
  "$ROOT/src/popup/popup.html" >"$STAGE/popup/popup.html"

# 600 CSS px: main is max-width 560 and body pads 20 either side, so the page
# is exactly as wide as its content and there are no margins to crop off.
POPUP_URL="file://$STAGE/popup/popup.html"
DOM=$("$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
  --allow-file-access-from-files --window-size=600,2000 --dump-dom "$POPUP_URL" 2>/dev/null)

# Proof that the real popup.js ran: the revision only reaches the DOM by way of
# the message handler. Without this check a silently dead module would still
# measure and still capture — just of an empty page.
case "$DOM" in
*"$REVISION"*) ;;
*)
  echo 'make-art: popup.js did not render the stubbed status; refusing to capture' >&2
  exit 1
  ;;
esac

HEIGHT=$(printf '%s' "$DOM" | sed -n 's/.*cc-height:\([0-9]*\).*/\1/p' | head -1)
[ -n "$HEIGHT" ] || {
  echo 'make-art: could not measure the popup height' >&2
  exit 1
}

# Measured rather than hard-coded, because the popup grows a line whenever the
# status text does, and a fixed viewport would clip it without saying so.
capture "$ROOT/assets/popup.png" 600 "$HEIGHT" "$POPUP_URL" \
  --allow-file-access-from-files --force-device-scale-factor=2
assert_size "$ROOT/assets/popup.png" 1200 $((HEIGHT * 2))

echo "make-art: store picker (real capture, src/pick/*)"
# The listing's second screenshot, and the only other screen this extension has.
# It is worth its slot precisely because it is rare: RUNG 5 fires only when a
# rule asks it to, so a reader who sees this and nothing else would assume being
# asked is the normal case — which is the misunderstanding the whole ladder
# exists to prevent. The note at the foot of the page says so, and it is in shot.
cp "$ROOT/src/pick/pick.js" "$STAGE/pick/pick.js"

cat >"$STAGE/pick/cc-stub.js" <<'STUB'
// Only contextualIdentities is needed to RENDER; tabs and runtime are reached
// solely from the click handlers, which a screenshot never fires.
globalThis.browser = {
  contextualIdentities: {
    query: async () => [
      { name: 'work', cookieStoreId: 'firefox-container-1', colorCode: '#37adff' },
      { name: 'personal', cookieStoreId: 'firefox-container-2', colorCode: '#51cd00' },
      { name: 'admin', cookieStoreId: 'firefox-container-3', colorCode: '#ff4bda' },
    ],
  },
};
globalThis.chrome = globalThis.browser;
STUB

sed -e 's|<script type="module" src="pick.js">|<script src="cc-stub.js"></script><script type="module" src="pick.js">|' \
  -e 's|</body>|<script type="module" src="../popup/cc-measure.js"></script></body>|' \
  "$ROOT/src/pick/pick.html" >"$STAGE/pick/pick.html"

# The address is a query parameter because the page is web-accessible and reads
# its input from there; preselect is what a rule offered, shown ticked.
PICK_URL="file://$STAGE/pick/pick.html?url=https%3A%2F%2Fconsole.example-cloud.com%2Fhome&preselect=work"
PICK_DOM=$("$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
  --allow-file-access-from-files --window-size=640,2000 --dump-dom "$PICK_URL" 2>/dev/null)

# Same proof as the popup: the container names only reach the DOM through
# pick.js, so finding one means the shipped module really ran.
case "$PICK_DOM" in
*'personal'*) ;;
*)
  echo 'make-art: pick.js did not render the stubbed containers; refusing to capture' >&2
  exit 1
  ;;
esac

# 640 wide and cropped to the measured content height, which lands on 1.60:1 —
# the exact ratio of AMO's 320x200 gallery card, so it fills the card instead of
# letterboxing. The page really does sit at the top-left of a full-height tab, so
# a fixed 1280x800 shot would not be wrong; it would just be two thirds empty,
# and two thirds of nothing is most of what a reader of the card would see.
# Nothing about the page is restyled to achieve this. Only the viewport moves.
PICK_H=$(printf '%s' "$PICK_DOM" | sed -n 's/.*cc-height:\([0-9]*\).*/\1/p' | head -1)
[ -n "$PICK_H" ] || {
  echo 'make-art: could not measure the picker height' >&2
  exit 1
}
capture "$ROOT/docs/store/02-picker.png" 640 "$PICK_H" "$PICK_URL" \
  --allow-file-access-from-files --force-device-scale-factor=2
assert_size "$ROOT/docs/store/02-picker.png" 1280 $((PICK_H * 2))
