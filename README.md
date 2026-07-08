# ASCII Web

A Manifest V3 browser extension that converts `<img>` and `<video>` elements on
any page into live ASCII art, using a five-pass WebGL2 shader pipeline modelled
on the [AcerolaFX](https://github.com/GarrettGunnell/AcerolaFX) ASCII shader
(see Acknowledgements). A terminal-browser frontend (`cli/`) shares the same
pipeline.

This is a working starting scaffold, deliberately small and heavily commented so
each piece is easy to understand and extend. It is **not** polished — see
"Known limitations" and "Next steps" below.

## How it works (the pipeline)

The interesting 90% is the shader pipeline in `src/shaders.js`. Each source
frame goes through five GPU passes:

1. **Blur passes** (`BLURX_FRAG`, `BLURY_FRAG`) — two separable Gaussian blurs
   of luminance (sigma and 1.6·sigma) computed together, one axis per pass. The
   vertical pass then takes the Difference-of-Gaussians (narrow − wide) and
   thresholds it into a thin binary line mask along contours — the AcerolaFX
   trick that gives clean line art regardless of local contrast.
2. **Edge pass** (`EDGE_FRAG`) — a Sobel operator on the DoG mask produces an
   edge *magnitude* and a *direction* quantized to four buckets: `|  -  /  \`.
   This is the part that turns outlines into line characters.
3. **Aggregate pass** (`AGG_FRAG`) — collapses the full-resolution image down to
   one texel per character cell. For each cell it computes the average luminance
   (for the fill character) and the dominant edge direction (for the line
   character). Output texture size is the character grid: `cols x rows`.
4. **Composite pass** (`COMP_FRAG`) — runs at full output resolution. For every
   pixel it figures out which cell it belongs to, picks a glyph (a line glyph if
   the cell's edge energy beats the threshold, otherwise a fill-ramp glyph keyed
   to brightness), and stamps that glyph by sampling the atlas.

The glyph atlas (`src/glyph-atlas.js`) is just a strip of characters drawn
white-on-black into a canvas: the fill ramp `  . : - = + * # % @` followed by the
four edge glyphs. The shader navigates it by index.

## Components

| File | Role |
| --- | --- |
| `manifest.json` | MV3 config. Injects the four content scripts on every page; registers the popup. |
| `src/glyph-atlas.js` | Builds the character atlas texture. GL-agnostic (returns a canvas). |
| `src/shaders.js` | All GLSL. The actual ASCII algorithm lives here. |
| `src/ascii-renderer.js` | One shared WebGL2 context: compiles programs, manages framebuffers, runs the five passes, blits the result. |
| `src/content.js` | Orchestrator: finds media, manages positioned canvas overlays, drives the per-video render loop, reads settings. |
| `src/background.js` | MV3 service worker: fetches cross-origin image bytes on request (extension fetches bypass page CORS via `host_permissions`). |
| `popup.html` / `popup.js` | Toggle + cell size / edge strength / colour controls. Writes to `chrome.storage.local`; the content script reacts live. |
| `test/index.html` | Self-contained test page (orientation, diagonals, live video, CORS cases). Serve with `python3 -m http.server 8123 -d test`, don't open via `file://`. |
| `cli/ascii-browse.mjs` | Terminal frontend: headless Chrome + screenshot polling (unchanged frames skipped), the same three pipeline files convert frames via `readCells()`, page text is stamped back over the art as real readable characters (DOM text layer). Fully keyboard-navigable: `o` URL bar, `f` link hints (type the label to click), `e` insert mode (keys forward to the page, Esc exits), `H`/`L` history, `c` colour/grayscale/mono cycle, arrows/PgUp/PgDn scroll; mouse click/wheel also work. Text stamps carry their element's real background when it differs from the page base (buttons/cards read as buttons/cards). `npm install` in `cli/` once, then `node cli/ascii-browse.mjs <url>` (`--mono`, `--invert`, `--no-text`, `--hidpi`, `--braille` for 8x dot-matrix detail, `--pixels` for true-pixel media via kitty/sixel, `--sound` for audio via an invisible Xvfb display (needs `xorg-x11-server-Xvfb`; stays fully in-terminal), `--cell N`, `--fps N`, `--once`). Status bar shows each toggle's live state. |

One shared renderer feeds many cheap 2D-canvas overlays (browsers cap WebGL
contexts at ~16, and a page can have more images than that).

## Install (Chrome / Edge / Brave / any Chromium)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `ascii-web` folder.
4. Open any page with images or a video, click the toolbar icon, tick **Enabled**.

For **Firefox** (109+, MV3): use the Firefox build — `manifest.firefox.json`
swaps the background service worker for an event page (`background.scripts`,
the one MV3 difference that matters) and adds the required `gecko.id`. Build
`dist/ascii-web-firefox-<v>.zip` with `scripts/package.sh`, then load via
`about:debugging` → This Firefox → Load Temporary Add-on (or sign it on AMO
for a permanent install — change the `gecko.id` to your own first). Two
Firefox notes: grant "Access your data for all websites" in about:addons for
the cross-origin image fallback to work, and animated GIFs stay static
(Firefox has no WebCodecs `ImageDecoder`; the code falls back gracefully).

## Packaging

`scripts/package.sh` builds everything into `dist/`:

| Artifact | Install |
| --- | --- |
| `ascii-web-chrome-<v>.zip` | Drag into `chrome://extensions` (dev mode), or upload to the Chrome Web Store. |
| `ascii-web-firefox-<v>.zip` | `about:debugging` → Load Temporary Add-on, or sign on AMO. |
| `ascii-browse-<v>.tgz` | `npm install -g ./dist/ascii-browse-<v>.tgz` → `ascii-browse <url>` anywhere. The tarball bundles the shared pipeline files, so it works standalone (note the `./` — npm misreads a bare `dist/...` path as a GitHub repo). |

`scripts/make-icons.mjs` regenerates the extension icons (uses headless
Chrome, no image tooling needed).

## Install (terminal browser)

The CLI needs Node.js 18+, a Chrome/Chromium binary, and `npm install` once in
`cli/`. Optional extras: **Xvfb** for `--sound` (invisible display so audio
stays in-terminal) and a **kitty-protocol or sixel terminal** for true-pixel
media (`--pixels`; kitty, ghostty, WezTerm, Konsole speak kitty; foot and
xterm speak sixel — GNOME Terminal and Alacritty support neither).

```bash
# Fedora / RHEL
sudo dnf install nodejs chromium xorg-x11-server-Xvfb kitty

# Debian / Ubuntu
sudo apt install nodejs npm chromium xvfb kitty
#   (older Ubuntu: the package may be chromium-browser; Google Chrome works too)

# Arch
sudo pacman -S nodejs npm chromium xorg-server-xvfb kitty

# then, from the repo root:
cd cli && npm install && cd ..
node cli/ascii-browse.mjs https://en.wikipedia.org/wiki/ASCII_art
```

## Tuning

- **Cell size** — pixels per character. 4 = fine and dense, 16 = chunky and fast.
- **Edge strength** — how much edge energy a cell needs before a line glyph
  overrides the fill glyph. Lower = more outlines.
- **Colour** — off = green-on-black monochrome (set in `ascii-renderer.js` via
  `u_fg`/`u_bg`); on = each glyph tinted by its cell's average colour.
- **Line scale / Line sensitivity** — the DoG edge tuning, adjustable live:
  popup sliders in the extension, `--sigma` / `--dog-thresh` in the CLI.
  Bigger scale = only larger features get outlines; lower sensitivity value =
  more lines. (Defaults: 1.2 / 0.015.)
- **Text mode** — overlays become real, selectable `<pre>` characters
  (monochrome) instead of a canvas, using ~1:2 cells to match monospace glyph
  shape. Under the hood this is `renderer.readCells()`, which returns the cell
  grid (chars + per-cell colours) as data — the same seam a terminal frontend
  consumes.

## Known limitations (intentional, for v1)

- **Orientation**: verified correct on real hardware (Chrome, 2026-07-04) —
  output is upright and the `/` `\` diagonals match, with the current
  `UNPACK_FLIP_Y` convention. If a browser/driver ever disagrees, the one-line
  fixes are the dir values in `EDGE_FRAG` and the flip handling in
  `ascii-renderer.js`. `test/index.html` has the test patterns.
- **Cross-origin video**: non-CORS cross-origin *images* work — when the direct
  upload taints, the content script asks the background service worker to fetch
  the bytes (extension fetches bypass page CORS) and renders the decoded
  ImageBitmap instead. Cross-origin *videos* are streams, can't be re-fetched
  that way, and are still skipped (`render()` returns false, with a one-time
  console.debug per element).
- **Aggregate cost**: the aggregate shader loops over every pixel in a cell
  (capped at 24x24). Fine for normal pages; expensive for huge full-screen video
  at tiny cell sizes.
- **Animated images** (GIF/APNG/animated WebP) are re-decoded with WebCodecs'
  `ImageDecoder` — WebGL uploads from an animated `<img>` only ever see the
  first frame, per spec. Files are found by extension, so an animated image
  served from an extensionless URL stays static; browsers without
  `ImageDecoder` (Firefox) fall back to a static first frame.
- No overlay for CSS background images, `<canvas>`, or WebGL game canvases yet.

## Acknowledgements

The ASCII rendering approach — luminance mapped onto a fill-glyph ramp, plus
Difference-of-Gaussians edge detection with directions quantized to `| - / \`
line glyphs — comes from the ASCII effect in
[AcerolaFX](https://github.com/GarrettGunnell/AcerolaFX) by Garrett "Acerola"
Gunnell (MIT licensed), and from his video essay explaining it. This project
is an independent WebGL2 implementation of that technique written from
scratch for the browser; no AcerolaFX code was copied. If code is ever ported
from that repo directly, its copyright notice must be carried along per the
MIT license.

## Next steps (good tasks to hand to Claude Code)

- Terminal frontend polish: tab support, find-in-page, configurable keymap.
- True-pixel media: render image/video boxes via the kitty graphics protocol
  or sixel in supporting terminals, keeping ASCII/braille as the fallback.
- Colour text mode (per-cell `<span>`s or CSS custom highlights — `readCells()`
  already returns the colours).
- Replace the per-cell pixel loop in the aggregate pass with mipmap sampling for
  the luminance average (cheaper at small cell sizes).
- Add background-image and `<canvas>` capture.
- Per-element enable/disable (click an image to toggle it) instead of all-or-none.
- Expose the cell aspect ratio as a setting for canvas mode too (text mode
  already uses ~1:2; canvas cells are square).
