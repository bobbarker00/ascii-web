#!/usr/bin/env node
// ascii-browse: a terminal frontend for the ASCII Web pipeline.
//
// Architecture (the same pipeline as the extension, different display):
//   - headless Chrome renders the real page in one tab
//   - page.screenshot() polling captures frames; identical captures are
//     skipped, so an idle page costs one JPEG encode and no conversion.
//     (CDP screencast looked cleaner but delivers no frames for a
//     backgrounded tab, and our renderer tab backgrounds the page tab.)
//   - a second blank tab runs the extension's own shader files
//     (glyph-atlas.js, shaders.js, ascii-renderer.js) on those frames;
//     readCells() hands back the cell grid
//   - a DOM text layer stamps the page's real text over the art as readable
//     characters at their true positions (ASCII-art'd text is gibberish);
//     dark CSS colours are lifted so they stay visible on a dark terminal
//   - the merged grid is written as ANSI truecolor frames
//
// Usage:
//   ascii-browse <url> [--cell 8] [--threshold 0.08] [--sigma 1.2]
//                      [--dog-thresh 0.015] [--fps 10]
//                      [--mono] [--gray] [--invert] [--no-text] [--hidpi]
//                      [--braille] [--pixels auto|kitty|sixel|off]
//                      [--sound] [--once]
//
// --sigma / --dog-thresh: DoG edge tuning (same knobs as the extension's
//   "Line scale" / "Line sensitivity" sliders). Bigger sigma = only larger
//   features get outlines; lower threshold = more lines.
//
// --pixels: render <img>/<video>/<canvas> regions as true pixels via the
//           kitty graphics protocol or sixel where the terminal supports it
//           (auto-detected; ASCII/braille remains the fallback and fills
//           everything else). 'p' toggles at runtime.
//
// --invert  flips the fill ramp ("paper mode"): right for mostly-white sites.
// --no-text disables the DOM text overlay (pure art mode).
// --hidpi   captures at 2x device pixels: ~4x source detail per cell, slower.
// --braille renders imagery as braille dot-matrix cells (2x4 dots per cell =
//           8x the spatial detail of one ASCII glyph); the DOM text layer
//           still stamps normal readable characters on top. Trades the ASCII
//           aesthetic for detail.
// --sound   audio while staying in the terminal: Chrome's audio stack is
//           independent of its display stack, so a headful Chrome pointed at
//           an invisible Xvfb virtual display plays through PipeWire/Pulse
//           with no window anywhere. Needs the Xvfb binary (Fedora:
//           dnf install xorg-x11-server-Xvfb); without it, falls back to a
//           visible window you can minimize.
// --once    renders a single frame to stdout and exits (no TTY needed).
//
// Keys (normal mode): q quit · o open URL · / find in page (type to search,
// Tab/Shift-Tab cycle matches, Enter clicks the current match, Esc done) ·
// f link hints (type the label to click; works on links/buttons/inputs —
// selecting an input enters insert mode) · e insert mode (keys forward to
// the page; Esc exits) · H/L history back/forward · wheel/↑↓/PgUp/PgDn/space
// scroll · g/G top/bottom · t text overlay · i invert · b braille · c cycle
// colour/grayscale/mono. Mouse click/wheel work in every mode.

import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// In the repo, the pipeline lives in ../src (shared with the extension); an
// installed npm package carries a bundled copy in ./shared (see prepack).
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = existsSync(join(HERE, '..', 'src', 'shaders.js'))
  ? join(HERE, '..', 'src')
  : join(HERE, 'shared');
const PIPELINE_FILES = ['glyph-atlas.js', 'shaders.js', 'ascii-renderer.js'];

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = {
  cell: 8, threshold: 0.08, sigma: 1.2, dogThresh: 0.015, fps: 10,
  mono: false, gray: false, invert: false, noText: false, hidpi: false,
  braille: false, sound: false, once: false, pixels: 'auto'
};
let url = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--mono') opt.mono = true;
  else if (a === '--gray') opt.gray = true;
  else if (a === '--invert') opt.invert = true;
  else if (a === '--no-text') opt.noText = true;
  else if (a === '--hidpi') opt.hidpi = true;
  else if (a === '--braille') opt.braille = true;
  else if (a === '--sound') opt.sound = true;
  else if (a === '--once') opt.once = true;
  else if (a === '--pixels') opt.pixels = argv[++i] || 'auto';
  else if (a === '--cell') opt.cell = Math.max(2, Math.min(12, +argv[++i] || 8));
  else if (a === '--threshold') opt.threshold = +argv[++i] || 0.08;
  else if (a === '--sigma') opt.sigma = Math.max(0.4, Math.min(4, +argv[++i] || 1.2));
  else if (a === '--dog-thresh') opt.dogThresh = +argv[++i] || 0.015;
  else if (a === '--fps') opt.fps = Math.max(1, Math.min(30, +argv[++i] || 10));
  else if (!a.startsWith('-') && !url) url = a;
  else {
    console.error('unknown option: ' + a);
    process.exit(1);
  }
}
if (!url) {
  console.error('usage: ascii-browse <url> [--cell 8] [--threshold 0.08] [--fps 10] [--mono] [--invert] [--no-text] [--hidpi] [--once]');
  process.exit(1);
}
if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
// Braille packs a 2x4 dot matrix per cell, so a cell must split evenly into
// half-width subcells at least 2px wide.
if (opt.cell % 2) opt.cell += 1;
if (opt.braille && opt.cell < 4) opt.cell = 4;
// 'color' | 'gray' | 'mono' — cycled at runtime with 'c'.
opt.colorMode = opt.mono ? 'mono' : (opt.gray ? 'gray' : 'color');

// ---- find a Chrome ----------------------------------------------------------
function chromePath() {
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome', 'brave-browser', 'microsoft-edge']) {
    try {
      const p = execSync('command -v ' + name, { shell: '/bin/bash', stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
      if (p) return p;
    } catch (e) { /* not installed, keep looking */ }
  }
  return null;
}

let xvfbProc = null;

function binPath(name) {
  try {
    return execSync('command -v ' + name, { shell: '/bin/bash', stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch (e) {
    return null;
  }
}

async function launch() {
  const args = [
    // Software WebGL2: newer Chrome needs the flag to allow SwiftShader.
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    // Headless counts no input as "no user gesture": videos never start
    // without this.
    '--autoplay-policy=no-user-gesture-required'
  ];
  if (!opt.sound) args.push('--mute-audio');

  // --sound needs headful Chrome (headless has no audio output path), but
  // headful doesn't need a *visible* display: an Xvfb virtual display keeps
  // everything in the terminal while audio flows to the system mixer.
  let env;
  if (opt.sound) {
    const xvfb = binPath('Xvfb');
    if (xvfb) {
      const display = ':' + (90 + (process.pid % 40)); // dodge collisions
      xvfbProc = spawn(xvfb, [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
      xvfbProc.unref();
      await new Promise((r) => setTimeout(r, 400)); // let the server come up
      env = Object.assign({}, process.env, { DISPLAY: display });
    } else {
      process.stderr.write('--sound: Xvfb not found (dnf install xorg-x11-server-Xvfb); using a visible window\n');
    }
  }

  const common = { headless: !opt.sound, args, env };
  try {
    return await puppeteer.launch(Object.assign({ channel: 'chrome' }, common));
  } catch (e) {
    const p = chromePath();
    if (!p) throw new Error('no Chrome/Chromium found on PATH: ' + e.message);
    return await puppeteer.launch(Object.assign({ executablePath: p }, common));
  }
}

// ---- terminal geometry ------------------------------------------------------
// One terminal cell = cell x 2*cell CSS pixels (monospace glyphs are ~1:2).
// --hidpi captures at deviceScaleFactor 2, so the shader sees 2*cell x 4*cell
// device pixels per terminal cell — more detail for the same layout.
const CW = opt.cell;
const CH = opt.cell * 2;
const DSF = opt.hidpi ? 2 : 1;
const STATUS_ROWS = opt.once ? 0 : 1;

function termGrid() {
  const cols = Math.max(20, process.stdout.columns || 80);
  const rows = Math.max(10, (process.stdout.rows || 24) - STATUS_ROWS);
  return { cols, rows };
}

// ---- main -------------------------------------------------------------------
const browser = await launch();
let quitting = false;

async function quit(code) {
  if (quitting) return;
  quitting = true;
  if (!opt.once) {
    // kitty images, colours, mouse reporting off, cursor, main screen
    try { if (pixelMode === 'kitty') process.stdout.write('\x1b_Ga=d,d=A\x1b\\'); }
    catch (e) { /* quit before pixel detection ran */ }
    process.stdout.write('\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  await browser.close().catch(() => {});
  if (xvfbProc) xvfbProc.kill();
  process.exit(code || 0);
}
process.on('SIGINT', () => quit(130));
process.on('SIGTERM', () => quit(143));

const page = await browser.newPage();
// Sites sniff "HeadlessChrome" in the UA and serve degraded players.
const ua = await browser.userAgent();
await page.setUserAgent(ua.replace(/HeadlessChrome/gi, 'Chrome'));

let grid = termGrid();
async function applyViewport() {
  await page.setViewport({
    width: grid.cols * CW,
    height: grid.rows * CH,
    deviceScaleFactor: DSF
  });
}
await applyViewport();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
  process.stderr.write('warning: navigation incomplete: ' + e.message + '\n');
});

// Renderer tab: about:blank + the extension's pipeline files.
const rendererPage = await browser.newPage();
for (const f of PIPELINE_FILES) {
  await rendererPage.addScriptTag({ content: readFileSync(join(SRC_DIR, f), 'utf8') });
}
await rendererPage.evaluate(() => {
  window.__r = new window.__AsciiWeb.AsciiRenderer(); // throws if WebGL2 missing

  // Sixel encoder (fixed 6x6x6 palette, RLE). Lives in the renderer tab so
  // the heavy per-pixel work happens in the browser process, not our loop.
  window.__sixel = function (d, w, h) {
    const idx = new Uint8Array(w * h);
    for (let p = 0, q = 0; p < w * h; p++, q += 4) {
      idx[p] = Math.round(d[q] / 51) * 36 + Math.round(d[q + 1] / 51) * 6 + Math.round(d[q + 2] / 51);
    }
    let out = '\x1bP0;1;0q"1;1;' + w + ';' + h;
    for (let i = 0; i < 216; i++) {
      out += '#' + i + ';2;' + (((i / 36 | 0) % 6) * 20) + ';' + (((i / 6 | 0) % 6) * 20) + ';' + ((i % 6) * 20);
    }
    for (let y0 = 0; y0 < h; y0 += 6) {
      const bandH = Math.min(6, h - y0);
      const masks = new Map(); // colour -> per-column dot bitmask
      for (let dy = 0; dy < bandH; dy++) {
        const base = (y0 + dy) * w;
        for (let x = 0; x < w; x++) {
          const ci = idx[base + x];
          let m = masks.get(ci);
          if (!m) { m = new Uint8Array(w); masks.set(ci, m); }
          m[x] |= 1 << dy;
        }
      }
      let firstColor = true;
      for (const [ci, m] of masks) {
        out += (firstColor ? '' : '$') + '#' + ci;
        firstColor = false;
        let prev = -1, run = 0;
        for (let x = 0; x <= w; x++) {
          const bits = x < w ? m[x] : -1;
          if (bits === prev) { run++; continue; }
          if (run > 0) {
            const ch = String.fromCharCode(63 + prev);
            out += run > 3 ? '!' + run + ch : ch.repeat(run);
          }
          prev = bits;
          run = 1;
        }
      }
      out += '-';
    }
    return out + '\x1b\\';
  };
});
// Keep the page tab frontmost: background tabs get rAF throttled to ~1fps,
// which crawls every animation on the page. The renderer tab doesn't care —
// its WebGL work is driven synchronously by our evaluate() calls.
await page.bringToFront();

// Atlas layout constants (fill-ramp size etc.), needed to turn glyph indices
// back into "ink" for braille dots.
const atlasInfo = await rendererPage.evaluate(() => {
  const a = window.__AsciiWeb.createAtlas(16);
  return { fillCount: a.fillCount, edgeBase: a.edgeBase };
});

// When the DOM text layer is on, hide the page's own text in the capture:
// the edge detector otherwise fires on rendered glyphs, leaving "static"
// around every line of text. Layout and media are unaffected — words come
// exclusively from the DOM layer.
async function setTextHidden(hidden) {
  await page.evaluate((on) => {
    let el = document.getElementById('__ascii_hide_text');
    if (on && !el) {
      el = document.createElement('style');
      el.id = '__ascii_hide_text';
      el.textContent = 'body * { color: transparent !important; text-shadow: none !important; }';
      document.documentElement.appendChild(el);
    } else if (!on && el) {
      el.remove();
    }
  }, hidden).catch(() => {});
}
await setTextHidden(!opt.noText);
// Navigations wipe injected styles; re-apply. Also keep the status-bar URL
// honest — clicks and hint-follows navigate without going through goto().
page.on('framenavigated', (fr) => {
  if (!fr.parentFrame()) {
    url = fr.url();
    setTextHidden(!opt.noText);
  }
});

// ---- frame conversion (runs in the renderer tab) ------------------------------
// ASCII mode: one shader cell per terminal cell (aspect 2).
// Braille mode: square subcells at half the cell width — a terminal cell
// covers exactly 2x4 of them, one per braille dot.
async function convert(b64, scroll) {
  const braille = opt.braille;
  const mediaReq = mediaGeometry(scroll); // null unless true-pixel mode is active
  const f = await rendererPage.evaluate(async (b64, cell, threshold, invert, braille, mediaReq, dog) => {
    const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
    // flipY baked in: WebGL ignores UNPACK_FLIP_Y for ImageBitmap sources.
    const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
    const g = window.__r.readCells(bmp, bmp.width, bmp.height, {
      cellSize: braille ? cell / 2 : cell,
      cellAspect: braille ? 1 : 2,
      edgeThreshold: threshold,
      invert: invert,
      dogSigma: dog.sigma,
      dogThresh: dog.thresh
    });
    bmp.close();
    if (!g) return null;
    // Binary payloads as base64 — far cheaper to serialize than JSON arrays.
    const b64ify = (arr) => {
      let bin = '';
      for (let i = 0; i < arr.length; i += 8192) {
        bin += String.fromCharCode.apply(null, arr.subarray(i, i + 8192));
      }
      return btoa(bin);
    };

    // True-pixel crops: cut each media box out of an *unflipped* decode of
    // the same frame; kitty gets PNG base64, sixel gets the escape string.
    let media = null;
    if (mediaReq) {
      media = [];
      const up = await createImageBitmap(blob);
      for (const b of mediaReq.boxes) {
        const oc = new OffscreenCanvas(b.outW || b.sw, b.outH || b.sh);
        const ctx = oc.getContext('2d');
        ctx.drawImage(up, b.sx, b.sy, b.sw, b.sh, 0, 0, oc.width, oc.height);
        let data;
        if (mediaReq.mode === 'kitty') {
          const png = new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
          data = b64ify(png);
        } else {
          data = window.__sixel(ctx.getImageData(0, 0, oc.width, oc.height).data, oc.width, oc.height);
        }
        media.push({ col: b.col, row: b.row, cols: b.cols, rows: b.rows, mode: mediaReq.mode, data: data });
      }
      up.close();
    }

    return {
      cols: g.cols,
      rows: g.rows,
      text: g.text,
      colors: b64ify(g.colors),
      glyphs: braille ? b64ify(g.glyphs) : null,
      media: media
    };
  }, b64, CW * DSF, opt.threshold, opt.invert, braille, mediaReq,
  // sigma is in source pixels, so it scales with capture density like cellSize
  { sigma: opt.sigma * DSF, thresh: opt.dogThresh });
  if (f) f.braille = braille; // pin the mode used, in case 'b' toggles mid-frame
  return f;
}

// ---- DOM text layer -----------------------------------------------------------
// Extract every visible word with its document position and CSS colour, then
// group words into visual lines (clustered by y-centre). Runs ~1/s (positions
// are document-relative, so scrolling doesn't invalidate them).
let textLines = []; // [{ y, words: [...x-sorted] }], sorted by y
let mediaBoxes = []; // visible <img>/<video>/<canvas> rects, document CSS px
let lastExtract = 0;

async function extractMedia() {
  mediaBoxes = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('img, video, canvas').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      out.push({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
    });
    // biggest first; the per-frame cap keeps the payload sane
    return out.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 4);
  }).catch(() => mediaBoxes);
}

async function extractText() {
  const raw = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();

    // Effective background: nearest ancestor with a non-transparent
    // background-color. Only reported when it differs from the page's base
    // background — that targets buttons/cards/highlights without giving
    // every paragraph a solid slab.
    const bgCache = new Map();
    function effBg(start) {
      if (bgCache.has(start)) return bgCache.get(start);
      let n = start;
      let v = null;
      while (n && n !== document.documentElement) {
        const p = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(n).backgroundColor);
        if (p && (p[4] === undefined || +p[4] > 0.5)) { v = [+p[1], +p[2], +p[3]]; break; }
        n = n.parentElement;
      }
      bgCache.set(start, v);
      return v;
    }
    const baseP = document.body &&
      /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    const baseBg = baseP ? [+baseP[1], +baseP[2], +baseP[3]] : [255, 255, 255];
    function distinctBg(el) {
      const bg = effBg(el);
      if (!bg) return null;
      const d = Math.abs(bg[0] - baseBg[0]) + Math.abs(bg[1] - baseBg[1]) + Math.abs(bg[2] - baseBg[2]);
      return d >= 48 ? bg : null;
    }

    let node;
    while ((node = walker.nextNode())) {
      const s = node.nodeValue;
      if (!s || !s.trim()) continue;
      const el = node.parentElement;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      if (parseFloat(cs.fontSize) < 7) continue; // sub-legible fine print: skip
      const m2 = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color);
      const col = m2 ? [+m2[1], +m2[2], +m2[3]] : [220, 220, 220];
      // Styling cues the terminal can reproduce: bold for headings/bold text,
      // underline for links (otherwise nothing looks clickable).
      const bold = +cs.fontWeight >= 600 || parseFloat(cs.fontSize) >= 20 ? 1 : 0;
      const link = el.closest('a[href]') ? 1 : 0;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(s))) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const r = range.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        out.push({ t: m[0], x: r.left + scrollX, y: r.top + scrollY + r.height / 2, c: col, b: bold, u: link, fs: parseFloat(cs.fontSize), bg: distinctBg(el) });
        if (out.length >= 8000) return out; // safety cap on huge pages
      }
    }
    // Form fields: their values/placeholders aren't text nodes, so the walk
    // above never sees them — without this, typing would be invisible. The
    // focused field gets a caret mark.
    document.querySelectorAll('input, textarea').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      let v = el.value || el.placeholder || '';
      if (el === document.activeElement) v += '▏';
      if (!v) return;
      const m2 = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color);
      out.push({
        t: v.slice(0, 200),
        x: r.left + scrollX + 2,
        y: r.top + scrollY + r.height / 2,
        c: m2 ? [+m2[1], +m2[2], +m2[3]] : [220, 220, 220],
        b: 0,
        u: 0,
        fs: parseFloat(cs.fontSize),
        bg: distinctBg(el)
      });
    });
    return out;
  }).catch(() => null);
  if (!raw) return; // mid-navigation; keep the old words until the next pass

  // Dark CSS text (e.g. Wikipedia body copy) is invisible on a dark terminal:
  // lift low-luminance colours most of the way to white, keeping some hue.
  // Words with their own background keep true colours — dark-on-light there
  // is the intended contrast.
  for (const w of raw) {
    if (w.bg) continue;
    const luma = 0.299 * w.c[0] + 0.587 * w.c[1] + 0.114 * w.c[2];
    if (luma < 120) {
      w.c = w.c.map((v) => Math.round(v + (255 - v) * 0.75));
    }
  }

  // Cluster into visual lines: words whose y-centres are within ~half a cell
  // belong to the same line (side-by-side columns merge into one row-line,
  // which is fine — they occupy different column ranges).
  raw.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const w of raw) {
    if (!cur || Math.abs(w.y - cur.y) > CH * 0.6) {
      cur = { y: w.y, words: [w] };
      lines.push(cur);
    } else {
      cur.words.push(w);
    }
  }
  for (const ln of lines) ln.words.sort((a, b) => a.x - b.x);
  textLines = lines;

  // Re-run any active search against the fresh word objects (highlight sets
  // hold references, which extraction just replaced).
  if (mode === 'find' && findQuery) {
    computeFindMatches();
    if (findCurrent >= findMatches.length) findCurrent = 0;
    redraw();
  }
}

// ---- modes ----------------------------------------------------------------------
// normal: browse keys. insert: keys forward to the page (Esc exits).
// hint: visible clickables wear labels; typing a label clicks it.
// url: the status bar becomes an address input (Enter navigates).
let mode = 'normal';
let hints = [];     // [{ label, x, y }] in document CSS pixels
let hintPrefix = '';
let urlInput = '';
let findQuery = '';
let findMatches = []; // [{ x, y, words: [word refs] }] in document CSS pixels
let findCurrent = 0;

// Search the extracted text lines (i.e. exactly what's stampable on screen)
// for the query, case-insensitive, spanning word boundaries within a line.
function computeFindMatches() {
  findMatches = [];
  const q = findQuery.toLowerCase();
  if (!q) return;
  for (const ln of textLines) {
    let txt = '';
    const map = []; // char index in txt -> word index (-1 = separator)
    ln.words.forEach((w, wi) => {
      if (txt) { txt += ' '; map.push(-1); }
      for (let k = 0; k < w.t.length; k++) map.push(wi);
      txt += w.t;
    });
    const lower = txt.toLowerCase();
    let idx = 0;
    while ((idx = lower.indexOf(q, idx)) !== -1) {
      const wset = new Set();
      for (let k = idx; k < idx + q.length; k++) {
        if (map[k] >= 0) wset.add(ln.words[map[k]]);
      }
      if (wset.size) {
        const words = [...wset];
        findMatches.push({ x: words[0].x, y: words[0].y, words });
      }
      idx += q.length;
      if (findMatches.length >= 200) return;
    }
  }
}

function scrollToFindMatch() {
  const m = findMatches[findCurrent];
  if (!m) return;
  page.evaluate((y, vh) => {
    if (y < scrollY + vh * 0.15 || y > scrollY + vh * 0.85) {
      window.scrollTo(0, Math.max(0, y - vh / 2));
    }
  }, m.y, grid.rows * CH).catch(() => {});
}

const HINT_ALPHABET = 'asdfghjklqwertyuiopzxcvbnm';

async function startHints() {
  const found = await page.evaluate(() => {
    const els = document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"], [contenteditable="true"]');
    const out = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      out.push({ x: r.left + r.width / 2 + scrollX, y: r.top + r.height / 2 + scrollY });
      if (out.length >= 400) break;
    }
    return out;
  }).catch(() => []);
  found.forEach((h, i) => {
    h.label = found.length <= HINT_ALPHABET.length
      ? HINT_ALPHABET[i]
      : HINT_ALPHABET[(i / HINT_ALPHABET.length) | 0] + HINT_ALPHABET[i % HINT_ALPHABET.length];
  });
  hints = found;
  hintPrefix = '';
  mode = found.length ? 'hint' : 'normal';
  redraw();
}

async function clickHint(h) {
  const sc = await page.evaluate(() => ({ sx: scrollX, sy: scrollY })).catch(() => null);
  if (!sc) return;
  await page.mouse.click(h.x - sc.sx, h.y - sc.sy).catch(() => {});
  // Landing on an editable element goes straight to insert mode.
  setTimeout(async () => {
    const editable = await page.evaluate(() => {
      const el = document.activeElement;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }).catch(() => false);
    if (editable) { mode = 'insert'; redraw(); }
  }, 150);
}

// Forward a raw stdin chunk to the page as keystrokes.
const KEY_SEQS = [
  ['\x1b[A', 'ArrowUp'], ['\x1b[B', 'ArrowDown'],
  ['\x1b[C', 'ArrowRight'], ['\x1b[D', 'ArrowLeft'],
  ['\x1b[3~', 'Delete'], ['\x1b[H', 'Home'], ['\x1b[F', 'End']
];

async function forwardKeys(s) {
  let run = '';
  const flush = async () => {
    if (run) { const r = run; run = ''; await page.keyboard.type(r).catch(() => {}); }
  };
  let i = 0;
  outer: while (i < s.length) {
    for (const [seq, key] of KEY_SEQS) {
      if (s.startsWith(seq, i)) {
        await flush();
        await page.keyboard.press(key).catch(() => {});
        i += seq.length;
        continue outer;
      }
    }
    const ch = s[i++];
    if (ch === '\r') { await flush(); await page.keyboard.press('Enter').catch(() => {}); }
    else if (ch === '\x7f' || ch === '\b') { await flush(); await page.keyboard.press('Backspace').catch(() => {}); }
    else if (ch === '\t') { await flush(); await page.keyboard.press('Tab').catch(() => {}); }
    else if (ch >= ' ') run += ch;
  }
  await flush();
}

// ---- drawing ------------------------------------------------------------------
// ASCII 0x21-0x7E have fullwidth twins at +0xFEE0; they occupy two terminal
// cells, which is how headline-sized text gets rendered physically bigger.
function toFullwidth(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 0x21 && c <= 0x7e) return String.fromCharCode(c + 0xfee0);
  if (ch === ' ') return '　';
  return ch;
}

// Both modes reduce to the same terminal-cell shape: a char grid + a colour
// buffer, which the word overlay and ANSI emitter share.
function cellsFromAscii(f) {
  return {
    cols: f.cols,
    rows: f.rows,
    chars: f.text.split('\n').map((l) => l.split('')),
    colors: Buffer.from(f.colors, 'base64')
  };
}

// Pack 2x4 subcells into one braille char per terminal cell. "Ink" comes from
// the glyph index the pipeline chose for the subcell: edge glyphs are always
// ink, fill glyphs by ramp position. Cell colour = average of its 8 subcells.
const BRAILLE_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]; // [y][x]
// Ordered (Bayer) dither thresholds per dot position: midtones become dot
// texture instead of being crushed to solid/empty by a single 0.5 cut.
const BRAILLE_DITHER = [[0.5, 8.5], [12.5, 4.5], [3.5, 11.5], [15.5, 7.5]]; // /16, [y][x]

function cellsFromBraille(f) {
  const cols = f.cols >> 1;
  const rows = f.rows >> 2;
  const glyphs = Buffer.from(f.glyphs, 'base64');
  const sub = Buffer.from(f.colors, 'base64');
  const chars = [];
  const colors = Buffer.alloc(cols * rows * 3);
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      let bits = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const si = (y * 4 + sy) * f.cols + (x * 2 + sx);
          const gi = glyphs[si];
          const ink = gi >= atlasInfo.edgeBase ? 1 : gi / (atlasInfo.fillCount - 1);
          if (ink >= BRAILLE_DITHER[sy][sx] / 16) bits |= BRAILLE_BITS[sy][sx];
          r += sub[si * 3]; g += sub[si * 3 + 1]; b += sub[si * 3 + 2];
        }
      }
      row.push(String.fromCharCode(0x2800 + bits));
      const o = (y * cols + x) * 3;
      colors[o] = r >> 3; colors[o + 1] = g >> 3; colors[o + 2] = b >> 3;
    }
    chars.push(row);
  }
  return { cols, rows, chars, colors };
}

function composeFrame(f, scroll) {
  const cells = f.braille ? cellsFromBraille(f) : cellsFromAscii(f);
  const chars = cells.chars;
  const colors = cells.colors;
  const overrides = new Map(); // cellIndex -> word/hint object

  // Find-mode highlight sets, checked by identity in the emitter.
  let findAll = null;
  let findCur = null;
  if (mode === 'find' && findMatches.length) {
    findAll = new Set();
    for (const m of findMatches) for (const w of m.words) findAll.add(w);
    findCur = new Set(findMatches[Math.min(findCurrent, findMatches.length - 1)].words);
  }

  // Cells under a true-pixel image go blank: kitty draws at z=-1 beneath the
  // text layer (spaces reveal it, words/hints still stamp on top), and sixel
  // paints over them after the text writes.
  if (f.media) {
    for (const m of f.media) {
      for (let y = m.row; y < Math.min(m.row + m.rows, cells.rows); y++) {
        for (let x = m.col; x < Math.min(m.col + m.cols, cells.cols); x++) {
          chars[y][x] = ' ';
        }
      }
    }
  }

  if (!opt.noText) {
    // Line-level mapping: each visual text line claims one terminal row.
    // Lines are processed top-to-bottom; when two lines prefer the same row
    // (line-height tighter than a cell), the later one shifts down a row —
    // it's only dropped when even that would displace it more than one row.
    // Within a line, words can't collide beyond rounding, so the column
    // cursor only guards a one-cell gap.
    let lastRow = -1;
    for (const ln of textLines) {
      const preferred = Math.floor((ln.y - scroll.sy) / CH);
      const row = Math.max(preferred, lastRow + 1);
      if (row < 0 || row >= cells.rows || row - preferred > 1) {
        if (preferred > lastRow) lastRow = preferred; // keep monotonic on drops
        continue;
      }
      lastRow = row;
      // Within a line, words flow: each sits at its true column when free,
      // else directly after its predecessor. Pages usually pack more chars
      // per width than the terminal has cells, so lines may run long — they
      // truncate at the right edge (losing a tail beats dropping words from
      // the middle of a sentence).
      let cursor = 0;
      for (const w of ln.words) {
        // Headline-sized text renders as fullwidth forms (２ cells per char,
        // universally supported) — a terminal can't scale fonts, but it can
        // make big text physically bigger this way.
        const big = w.fs >= Math.max(20, CH * 1.3);
        const gw = big ? 2 : 1;
        const ideal = Math.round((w.x - scroll.sx) / CW);
        const col = Math.max(ideal, cursor);
        if (col >= cells.cols) continue;
        if (col - 1 >= cursor && col - 1 >= 0) {
          chars[row][col - 1] = ' '; // pad before
          if (w.bg) overrides.set(row * cells.cols + col - 1, w); // extend bg pill
        }
        let end = col;
        for (let i = 0; i < w.t.length; i++) {
          const cc = col + i * gw;
          if (cc + gw > cells.cols) break;
          if (big) {
            chars[row][cc] = toFullwidth(w.t[i]);
            chars[row][cc + 1] = ''; // covered by the wide glyph
            overrides.set(row * cells.cols + cc + 1, w);
          } else {
            chars[row][cc] = w.t[i];
          }
          overrides.set(row * cells.cols + cc, w);
          end = cc + gw;
        }
        if (end < cells.cols) {
          chars[row][end] = ' '; // blank the separator cell
          if (w.bg) overrides.set(row * cells.cols + end, w); // extend bg pill
        }
        cursor = end + 1;
      }
    }
  }

  // Hint labels stamp last, over everything, in a loud style.
  if (mode === 'hint') {
    for (const h of hints) {
      if (hintPrefix && !h.label.startsWith(hintPrefix)) continue;
      const row = Math.floor((h.y - scroll.sy) / CH);
      const col = Math.round((h.x - scroll.sx) / CW);
      if (row < 0 || row >= cells.rows) continue;
      for (let i = 0; i < h.label.length && col + i < cells.cols; i++) {
        if (col + i < 0) continue;
        chars[row][col + i] = h.label[i].toUpperCase();
        overrides.set(row * cells.cols + col + i, { hint: true });
      }
    }
  }

  const height = Math.min(cells.rows, grid.rows);
  const out = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    if (opt.colorMode === 'mono') {
      // Unstyled page content — but hint labels and find highlights are UI,
      // not content, so they keep a highlight (reverse video needs no
      // colour support; the current find match adds bold).
      for (let x = 0; x < cells.cols; x++) {
        const ov = overrides.get(y * cells.cols + x);
        if (ov && ov.hint) line += '\x1b[7m' + chars[y][x] + '\x1b[0m';
        else if (ov && findCur && findCur.has(ov)) line += '\x1b[7;1m' + chars[y][x] + '\x1b[0m';
        else if (ov && findAll && findAll.has(ov)) line += '\x1b[7m' + chars[y][x] + '\x1b[0m';
        else line += chars[y][x];
      }
    } else {
      const gray = opt.colorMode === 'gray';
      const grayOf = (v) => {
        const l = Math.round(0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]);
        return [l, l, l];
      };
      let last = '';
      for (let x = 0; x < cells.cols; x++) {
        const ov = overrides.get(y * cells.cols + x);
        const o = (y * cells.cols + x) * 3;
        // Self-contained style per run: leading 0 resets attributes from the
        // previous run, then colour, then this run's attributes/background.
        let c;
        if (ov && ov.hint) {
          c = '\x1b[0;30;103m'; // hint label: black on bright yellow
        } else if (ov && findCur && findCur.has(ov)) {
          c = '\x1b[0;30;106m'; // current find match: black on bright cyan
        } else if (ov && findAll && findAll.has(ov)) {
          c = '\x1b[0;30;46m';  // other find matches: black on cyan
        } else {
          let fg = ov ? ov.c : [colors[o], colors[o + 1], colors[o + 2]];
          let bg = (ov && ov.bg) || null;
          if (gray) {
            fg = grayOf(fg);
            if (bg) bg = grayOf(bg);
          }
          c = '\x1b[0;38;2;' + fg[0] + ';' + fg[1] + ';' + fg[2] +
            (ov && ov.b ? ';1' : '') + (ov && ov.u ? ';4' : '') +
            (bg ? ';48;2;' + bg[0] + ';' + bg[1] + ';' + bg[2] : '') + 'm';
        }
        if (c !== last) { line += c; last = c; } // only emit style changes
        line += chars[y][x];
      }
      line += '\x1b[0m';
    }
    out.push(line);
  }
  return out;
}

// Frame diffing: only rows whose styled content changed get rewritten. This
// is the flicker fix — an unchanged row is never touched, and during video
// only the media rows update.
let prevRows = [];
let prevStatus = '';

function draw(f, scroll) {
  const rowsOut = composeFrame(f, scroll);
  let status;
  if (mode === 'url') {
    status = '\x1b[7m Open: ' + urlInput + '▏ — Enter go · Esc cancel \x1b[0m';
  } else if (mode === 'find') {
    const count = findMatches.length
      ? (Math.min(findCurrent, findMatches.length - 1) + 1) + '/' + findMatches.length
      : (findQuery ? 'no matches' : '');
    status = '\x1b[7m Find: ' + findQuery + '▏ ' + count +
      ' — Tab/⇧Tab cycle · Enter click · Esc done \x1b[0m';
  } else {
    let help;
    if (mode === 'insert') help = ' -- INSERT -- keys go to the page · Esc back ';
    else if (mode === 'hint') help = ' -- LINKS ' + hintPrefix + ' -- type a label · Esc cancel ';
    else {
      const flag = (k, on) => k + (on ? '✓' : '·');
      help = ' | q quit · o url · / find · f links · e type · H/L hist · ' +
        flag('t', !opt.noText) + ' ' + flag('i', opt.invert) + ' ' + flag('b', opt.braille) +
        ' ' + (pixelMode ? flag('p', pixelsOn) : 'p✗') + // ✗ = no kitty/sixel support detected
        ' c:' + opt.colorMode + ' ';
    }
    status = '\x1b[7m ' + url.slice(0, Math.max(10, grid.cols - help.length - 2)) +
      help + '\x1b[0m';
  }
  let out = '';
  for (let y = 0; y < rowsOut.length; y++) {
    if (rowsOut[y] !== prevRows[y]) {
      out += '\x1b[' + (y + 1) + ';1H' + rowsOut[y] + '\x1b[K';
    }
  }
  for (let y = rowsOut.length; y < prevRows.length; y++) {
    out += '\x1b[' + (y + 1) + ';1H\x1b[K'; // clear rows the new frame doesn't cover
  }
  if (status !== prevStatus) {
    out += '\x1b[' + (grid.rows + 1) + ';1H' + status + '\x1b[K';
  }
  prevRows = rowsOut;
  prevStatus = status;

  // True-pixel media: kitty placements persist, so clear the previous set
  // and retransmit whenever we redraw; sixel just repaints at the cursor.
  if (f.media && f.media.length) {
    if (f.media[0].mode === 'kitty') out += '\x1b_Ga=d,d=A\x1b\\';
    out += emitMedia(f.media);
    hadKittyMedia = f.media[0].mode === 'kitty';
  } else if (hadKittyMedia) {
    out += '\x1b_Ga=d,d=A\x1b\\'; // media scrolled away/toggled off
    hadKittyMedia = false;
  }

  if (out) process.stdout.write(out);
}
let hadKittyMedia = false;

// ---- true-pixel media -----------------------------------------------------------
// Probe the terminal (before the key handler attaches — responses arrive on
// stdin): kitty graphics query, DA1 for sixel capability, cell pixel size.
let pixelMode = null;          // 'kitty' | 'sixel' | null
let pixelsOn = true;           // runtime toggle ('p')
let cellPx = { w: 8, h: 16 };  // physical pixels per terminal cell (sixel scaling)

if (!opt.once && process.stdin.isTTY && opt.pixels !== 'off') {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const resp = await new Promise((resolve) => {
    let acc = '';
    const done = () => { process.stdin.off('data', on); resolve(acc); };
    const timer = setTimeout(done, 400);
    const on = (d) => {
      acc += d.toString('latin1');
      if (/\x1b\[\?[\d;]*c/.test(acc)) { clearTimeout(timer); done(); } // DA1 = last reply
    };
    process.stdin.on('data', on);
    process.stdout.write('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[c');
  });
  const da = /\x1b\[\?([\d;]*)c/.exec(resp);
  if (opt.pixels === 'kitty' || (opt.pixels === 'auto' && resp.includes('\x1b_Gi=31'))) {
    pixelMode = 'kitty';
  } else if (opt.pixels === 'sixel' || (opt.pixels === 'auto' && da && da[1].split(';').includes('4'))) {
    pixelMode = 'sixel';
  }
  const cs = /\x1b\[6;(\d+);(\d+)t/.exec(resp);
  if (cs && +cs[1] > 0 && +cs[2] > 0) cellPx = { h: +cs[1], w: +cs[2] };
} else if (opt.pixels === 'kitty' || opt.pixels === 'sixel') {
  pixelMode = opt.pixels; // forced (also usable with --once / no TTY)
}

// Map visible media boxes to cell-aligned crop requests for the renderer tab.
function mediaGeometry(scroll) {
  if (!pixelMode || !pixelsOn || !mediaBoxes.length) return null;
  const list = [];
  const VW = grid.cols * CW;
  const VH = grid.rows * CH;
  for (const b of mediaBoxes) {
    const x0 = Math.max(b.x - scroll.sx, 0);
    const y0 = Math.max(b.y - scroll.sy, 0);
    const x1 = Math.min(b.x - scroll.sx + b.w, VW);
    const y1 = Math.min(b.y - scroll.sy + b.h, VH);
    const col = Math.round(x0 / CW);
    const row = Math.round(y0 / CH);
    const cols = Math.floor((x1 - x0) / CW);
    const rows = Math.floor((y1 - y0) / CH);
    if (cols < 2 || rows < 1) continue;
    list.push({
      col, row, cols, rows,
      sx: col * CW * DSF, sy: row * CH * DSF,
      sw: cols * CW * DSF, sh: rows * CH * DSF,
      // sixel paints physical pixels, so scale crops to the cell box exactly
      outW: pixelMode === 'sixel' ? cols * cellPx.w : 0,
      outH: pixelMode === 'sixel' ? rows * cellPx.h : 0
    });
  }
  return list.length ? { mode: pixelMode, boxes: list } : null;
}

// Serialize one frame's media as terminal graphics escapes.
function emitMedia(media) {
  let out = '';
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    out += '\x1b7\x1b[' + (m.row + 1) + ';' + (m.col + 1) + 'H'; // save cursor, move
    if (m.mode === 'kitty') {
      const id = 40 + i;
      for (let p = 0; p < m.data.length; p += 4096) {
        const last = p + 4096 >= m.data.length;
        const ctrl = p === 0
          ? 'a=T,i=' + id + ',q=2,f=100,z=-1,c=' + m.cols + ',r=' + m.rows + ',m=' + (last ? 0 : 1)
          : 'q=2,m=' + (last ? 0 : 1);
        out += '\x1b_G' + ctrl + ';' + m.data.slice(p, p + 4096) + '\x1b\\';
      }
    } else {
      out += m.data; // pre-encoded sixel
    }
    out += '\x1b8'; // restore cursor
  }
  return out;
}

// ---- --once: single frame to stdout, no TTY needed ----------------------------
if (opt.once) {
  if (!opt.noText) await extractText();
  if (pixelMode) await extractMedia();
  const scroll = await page.evaluate(() => ({ sx: scrollX, sy: scrollY }));
  const b64 = await page.screenshot({ type: 'jpeg', quality: 90, encoding: 'base64' });
  const f = await convert(b64, scroll);
  if (!f) { console.error('render failed'); await quit(1); }
  process.stdout.write(composeFrame(f, scroll).join('\n') + '\n');
  if (f.media && f.media.length) process.stdout.write(emitMedia(f.media));
  await quit(0);
}

// ---- input --------------------------------------------------------------------
// Scrolling dispatches real wheel events (not window.scrollBy) so it works on
// pages that scroll a container or lock body scroll (consent modals etc.).
// Terminal mouse reporting (SGR) makes cells clickable: cell -> page pixels.
let mouseX = 0; // last known page-pixel (CSS) position; wheel lands here
let mouseY = 0;
let redraw = () => {};

function wheel(dy) {
  const x = mouseX || (grid.cols * CW) / 2;
  const y = mouseY || (grid.rows * CH) / 2;
  page.mouse.move(x, y)
    .then(() => page.mouse.wheel({ deltaY: dy }))
    .catch(() => {});
}

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    let s = buf.toString('latin1');
    const pageH = grid.rows * CH;

    // Mouse events (may be several per chunk).
    let m;
    while ((m = SGR_MOUSE.exec(s))) {
      const btn = +m[1];
      mouseX = (+m[2] - 0.5) * CW; // 1-based cell -> CSS pixel at cell centre
      mouseY = (+m[3] - 0.5) * CH;
      if (btn === 0 && m[4] === 'm') {
        page.mouse.click(mouseX, mouseY).catch(() => {}); // click on release
      } else if (btn === 64) wheel(-CH * 3); // wheel up
      else if (btn === 65) wheel(CH * 3);    // wheel down
    }
    s = s.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '');
    if (!s) return;

    if (s.includes('\x03')) return quit(0); // Ctrl-C always quits

    if (mode === 'insert') {
      if (s === '\x1b') { mode = 'normal'; redraw(); return; } // bare Esc
      forwardKeys(s);
      return;
    }

    if (mode === 'find') {
      if (s === '\x1b') {
        mode = 'normal'; findQuery = ''; findMatches = []; redraw(); return;
      }
      if (s === '\t' || s === '\x1b[Z') { // Tab / Shift-Tab: cycle matches
        if (findMatches.length) {
          const step = s === '\t' ? 1 : -1;
          findCurrent = (findCurrent + step + findMatches.length) % findMatches.length;
          scrollToFindMatch();
        }
        redraw();
        return;
      }
      for (const ch of s) {
        if (ch === '\r') { // click the current match
          const m = findMatches[findCurrent];
          mode = 'normal'; findQuery = ''; findMatches = [];
          if (m) clickHint({ x: m.x + 2, y: m.y });
          redraw();
          return;
        }
        if (ch === '\x7f' || ch === '\b') findQuery = findQuery.slice(0, -1);
        else if (ch >= ' ') findQuery += ch;
      }
      computeFindMatches();
      findCurrent = 0;
      if (findMatches.length) scrollToFindMatch();
      redraw();
      return;
    }

    if (mode === 'url') {
      if (s === '\x1b') { mode = 'normal'; redraw(); return; }
      for (const ch of s) {
        if (ch === '\r') {
          let target = urlInput.trim();
          mode = 'normal';
          if (target) {
            if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = 'https://' + target;
            url = target;
            page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          }
          redraw();
          return;
        }
        if (ch === '\x7f' || ch === '\b') urlInput = urlInput.slice(0, -1);
        else if (ch >= ' ') urlInput += ch;
      }
      redraw();
      return;
    }

    if (mode === 'hint') {
      if (s === '\x1b') { mode = 'normal'; hintPrefix = ''; redraw(); return; }
      for (const ch of s) {
        if (HINT_ALPHABET.includes(ch)) hintPrefix += ch;
      }
      const exact = hints.find((h) => h.label === hintPrefix);
      const partial = hints.some((h) => h.label.startsWith(hintPrefix));
      if (exact) {
        mode = 'normal';
        hintPrefix = '';
        clickHint(exact);
      } else if (!partial) {
        mode = 'normal';
        hintPrefix = '';
      }
      redraw();
      return;
    }

    // normal mode
    if (s.includes('q')) return quit(0);
    if (s.includes('\x1b[A')) wheel(-CH * 3);            // up
    else if (s.includes('\x1b[B')) wheel(CH * 3);        // down
    else if (s.includes('\x1b[5~')) wheel(-pageH);       // PgUp
    else if (s.includes('\x1b[6~') || s === ' ') wheel(pageH); // PgDn / space
    else if (s === 'g') page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    else if (s === 'G') page.evaluate(() => window.scrollTo(0, 1e9)).catch(() => {});
    else if (s === 'f') startHints();
    else if (s === 'e') { mode = 'insert'; redraw(); }
    else if (s === 'o') { mode = 'url'; urlInput = ''; redraw(); }
    else if (s === '/') { mode = 'find'; findQuery = ''; findMatches = []; findCurrent = 0; redraw(); }
    else if (s === 'c') {
      const order = ['color', 'gray', 'mono'];
      opt.colorMode = order[(order.indexOf(opt.colorMode) + 1) % order.length];
      redraw();
    }
    else if (s === 'p' && pixelMode) { pixelsOn = !pixelsOn; redraw(); }
    else if (s === 'H') page.goBack().catch(() => {});
    else if (s === 'L') page.goForward().catch(() => {});
    else if (s === 't') { opt.noText = !opt.noText; setTextHidden(!opt.noText); redraw(); }
    else if (s === 'i') { opt.invert = !opt.invert; redraw(); }
    else if (s === 'b') { opt.braille = !opt.braille; redraw(); }
  });
}

// ---- frame loop -----------------------------------------------------------------
// page.screenshot() forces a capture even for a backgrounded tab (which the
// page tab is — the renderer tab was opened after it). Identical captures are
// skipped so idle pages don't burn conversion work; toggles force a redraw.
let lastShot = '';
let force = true;
redraw = () => { force = true; };

process.stdout.on('resize', () => {
  grid = termGrid();
  prevRows = []; // stale diff baseline; repaint everything
  prevStatus = '';
  process.stdout.write('\x1b[2J');
  applyViewport().then(() => { force = true; }).catch(() => {});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Alt screen, hide cursor, clear, enable SGR mouse reporting.
process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1000h\x1b[?1006h');

while (!quitting) {
  const t0 = Date.now();
  try {
    const b64 = await page.screenshot({ type: 'jpeg', quality: 90, encoding: 'base64' });
    if (b64 !== lastShot || force) {
      lastShot = b64;
      force = false;
      // Scroll first: media crop geometry depends on it.
      const scroll = await page.evaluate(() => ({ sx: scrollX, sy: scrollY }));
      const f = await convert(b64, scroll);
      if (f && !quitting) draw(f, scroll);
    }
  } catch (e) {
    // Mid-navigation capture race; keep the last frame and try again.
  }
  // Insert mode refreshes faster so typed field values show promptly — and
  // must force the redraw itself: the page's own text is transparent in the
  // capture, so typing never trips the screenshot change-detector.
  if (Date.now() - lastExtract > (mode === 'insert' ? 250 : 1000)) {
    lastExtract = Date.now();
    if (!opt.noText) extractText().then(() => { if (mode === 'insert') redraw(); });
    if (pixelMode && pixelsOn) extractMedia();
  }
  await sleep(Math.max(20, 1000 / opt.fps - (Date.now() - t0)));
}
