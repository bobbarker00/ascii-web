# ASCII Web

A Manifest V3 browser extension that converts `<img>` and `<video>` elements on
any page into live ASCII art, using a five-pass WebGL2 shader pipeline modelled
on the AcerolaFX ASCII shader.

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
| `popup.html` / `popup.js` | Toggle + cell size / edge strength / colour controls. Writes to `chrome.storage.local`; the content script reacts live. |
| `test/index.html` | Self-contained test page (orientation, diagonals, live video, CORS cases). Serve with `python3 -m http.server 8123 -d test`, don't open via `file://`. |

One shared renderer feeds many cheap 2D-canvas overlays (browsers cap WebGL
contexts at ~16, and a page can have more images than that).

## Install (Chrome / Edge / Brave / any Chromium)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `ascii-web` folder.
4. Open any page with images or a video, click the toolbar icon, tick **Enabled**.

For **Firefox**: change `manifest.json`'s `action` key to `browser_action` (or
use a Firefox-specific manifest), then load via `about:debugging` → This Firefox →
Load Temporary Add-on → pick `manifest.json`.

## Tuning

- **Cell size** — pixels per character. 4 = fine and dense, 16 = chunky and fast.
- **Edge strength** — how much edge energy a cell needs before a line glyph
  overrides the fill glyph. Lower = more outlines.
- **Colour** — off = green-on-black monochrome (set in `ascii-renderer.js` via
  `u_fg`/`u_bg`); on = each glyph tinted by its cell's average colour.
- **DoG constants** — `SIGMA1`/`SIGMA2`/`DOG_THRESH` at the top of the blur
  shaders in `shaders.js`. Bigger sigma = only larger features get outlines;
  lower threshold = more lines.

## Known limitations (intentional, for v1)

- **Orientation**: verified correct on real hardware (Chrome, 2026-07-04) —
  output is upright and the `/` `\` diagonals match, with the current
  `UNPACK_FLIP_Y` convention. If a browser/driver ever disagrees, the one-line
  fixes are the dir values in `EDGE_FRAG` and the flip handling in
  `ascii-renderer.js`. `test/index.html` has the test patterns.
- **Cross-origin media**: images/videos served without CORS taint the upload
  and are skipped (`render()` returns false, with a one-time console.debug per
  element). Confirmed against Google Images and YouTube thumbnails. Fixable
  with `host_permissions` + a background fetch — see "Next steps".
- **Aggregate cost**: the aggregate shader loops over every pixel in a cell
  (capped at 24x24). Fine for normal pages; expensive for huge full-screen video
  at tiny cell sizes.
- No overlay for CSS background images, `<canvas>`, or WebGL game canvases yet.

## Next steps (good tasks to hand to Claude Code)

- Fix cross-origin media: add `host_permissions`, fetch the image bytes from
  extension-privileged code (`fetch` → `createImageBitmap`), and upload that
  instead of the tainting element. Covers YouTube/Google Images thumbnails.
- Add a "text mode" output that reads back the per-cell glyph indices and emits a
  real, selectable `<pre>` of characters instead of a canvas.
- Replace the per-cell pixel loop in the aggregate pass with mipmap sampling for
  the luminance average (cheaper at small cell sizes).
- Add background-image and `<canvas>` capture.
- Per-element enable/disable (click an image to toggle it) instead of all-or-none.
- Persist a "fit characters to font aspect ratio" option (cells are square now;
  real terminal cells are ~1:2).
