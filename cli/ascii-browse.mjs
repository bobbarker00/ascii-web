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
//   ascii-browse <url> [--cell 8] [--threshold 0.08] [--fps 10]
//                      [--mono] [--invert] [--no-text] [--hidpi] [--once]
//
// --invert  flips the fill ramp ("paper mode"): right for mostly-white sites.
// --no-text disables the DOM text overlay (pure art mode).
// --hidpi   captures at 2x device pixels: ~4x source detail per cell, slower.
// --once    renders a single frame to stdout and exits (no TTY needed).
//
// Keys: q quit · mouse click = click the page · wheel/↑↓/PgUp/PgDn/space
// scroll (real wheel events, so container/modal scrolling works) · g/G
// top/bottom · t toggle text overlay · i toggle invert.

import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PIPELINE_FILES = ['glyph-atlas.js', 'shaders.js', 'ascii-renderer.js'];

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = {
  cell: 8, threshold: 0.08, fps: 10,
  mono: false, invert: false, noText: false, hidpi: false, once: false
};
let url = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--mono') opt.mono = true;
  else if (a === '--invert') opt.invert = true;
  else if (a === '--no-text') opt.noText = true;
  else if (a === '--hidpi') opt.hidpi = true;
  else if (a === '--once') opt.once = true;
  else if (a === '--cell') opt.cell = Math.max(2, Math.min(12, +argv[++i] || 8));
  else if (a === '--threshold') opt.threshold = +argv[++i] || 0.08;
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

async function launch() {
  const common = {
    headless: true,
    args: [
      // Software WebGL2: newer Chrome needs the flag to allow SwiftShader.
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--mute-audio',
      // Headless counts no input as "no user gesture": videos never start
      // without this.
      '--autoplay-policy=no-user-gesture-required'
    ]
  };
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
    // colours, mouse reporting off, cursor, main screen
    process.stdout.write('\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  await browser.close().catch(() => {});
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
});
// Keep the page tab frontmost: background tabs get rAF throttled to ~1fps,
// which crawls every animation on the page. The renderer tab doesn't care —
// its WebGL work is driven synchronously by our evaluate() calls.
await page.bringToFront();

// ---- frame conversion (runs in the renderer tab) ------------------------------
async function convert(b64) {
  return rendererPage.evaluate(async (b64, cell, threshold, invert) => {
    const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
    // flipY baked in: WebGL ignores UNPACK_FLIP_Y for ImageBitmap sources.
    const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
    const g = window.__r.readCells(bmp, bmp.width, bmp.height, {
      cellSize: cell,
      cellAspect: 2,
      edgeThreshold: threshold,
      invert: invert
    });
    bmp.close();
    if (!g) return null;
    // Colours as base64 — far cheaper to serialize than a JSON number array.
    let bin = '';
    for (let i = 0; i < g.colors.length; i += 8192) {
      bin += String.fromCharCode.apply(null, g.colors.subarray(i, i + 8192));
    }
    return { cols: g.cols, rows: g.rows, text: g.text, colors: btoa(bin) };
  }, b64, CW * DSF, opt.threshold, opt.invert);
}

// ---- DOM text layer -----------------------------------------------------------
// Extract every visible word with its document position and CSS colour. Runs
// ~1/s (positions are document-relative, so scrolling doesn't invalidate them).
let words = [];
let lastExtract = 0;

async function extractText() {
  const raw = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node;
    while ((node = walker.nextNode())) {
      const s = node.nodeValue;
      if (!s || !s.trim()) continue;
      const el = node.parentElement;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      const m2 = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color);
      const col = m2 ? [+m2[1], +m2[2], +m2[3]] : [220, 220, 220];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(s))) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const r = range.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        out.push({ t: m[0], x: r.left + scrollX, y: r.top + scrollY + r.height / 2, c: col });
        if (out.length >= 8000) return out; // safety cap on huge pages
      }
    }
    return out;
  }).catch(() => null);
  if (!raw) return; // mid-navigation; keep the old words until the next pass

  // Dark CSS text (e.g. Wikipedia body copy) is invisible on a dark terminal:
  // lift low-luminance colours most of the way to white, keeping some hue.
  for (const w of raw) {
    const luma = 0.299 * w.c[0] + 0.587 * w.c[1] + 0.114 * w.c[2];
    if (luma < 120) {
      w.c = w.c.map((v) => Math.round(v + (255 - v) * 0.75));
    }
  }
  words = raw;
}

// ---- drawing ------------------------------------------------------------------
function composeFrame(f, scroll) {
  // Mutable char grid from the shader output.
  const chars = f.text.split('\n').map((l) => l.split(''));
  const colors = Buffer.from(f.colors, 'base64');
  const overrides = new Map(); // cellIndex -> [r,g,b] from CSS text colour

  if (!opt.noText) {
    // Words arrive in DOM (~reading) order; a per-row cursor stops adjacent
    // words overwriting each other when pixel positions round into the same
    // cells, and guarantees a one-cell gap between them.
    const cursor = new Int32Array(f.rows);
    for (const w of words) {
      const row = Math.floor((w.y - scroll.sy) / CH);
      if (row < 0 || row >= f.rows) continue;
      const col = Math.max(Math.round((w.x - scroll.sx) / CW), cursor[row]);
      if (col >= f.cols) continue;
      for (let i = 0; i < w.t.length && col + i < f.cols; i++) {
        chars[row][col + i] = w.t[i];
        overrides.set(row * f.cols + col + i, w.c);
      }
      const gap = col + w.t.length;
      if (gap < f.cols) chars[row][gap] = ' '; // blank the separator cell
      cursor[row] = gap + 1;
    }
  }

  const height = Math.min(f.rows, grid.rows);
  const out = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    if (opt.mono) {
      line = chars[y].join('');
    } else {
      let last = '';
      for (let x = 0; x < f.cols; x++) {
        const ov = overrides.get(y * f.cols + x);
        const o = (y * f.cols + x) * 3;
        const c = ov
          ? '\x1b[38;2;' + ov[0] + ';' + ov[1] + ';' + ov[2] + 'm'
          : '\x1b[38;2;' + colors[o] + ';' + colors[o + 1] + ';' + colors[o + 2] + 'm';
        if (c !== last) { line += c; last = c; } // only emit colour changes
        line += chars[y][x];
      }
      line += '\x1b[0m';
    }
    out.push(line);
  }
  return out;
}

function draw(f, scroll) {
  const rowsOut = composeFrame(f, scroll);
  const status = '\x1b[7m ' + url.slice(0, Math.max(10, grid.cols - 46)) +
    ' | q quit · click · scroll · t text · i invert \x1b[0m';
  process.stdout.write('\x1b[H' + rowsOut.map((l) => l + '\x1b[K\n').join('') + status + '\x1b[K');
}

// ---- --once: single frame to stdout, no TTY needed ----------------------------
if (opt.once) {
  if (!opt.noText) await extractText();
  const b64 = await page.screenshot({ type: 'jpeg', quality: 90, encoding: 'base64' });
  const f = await convert(b64);
  if (!f) { console.error('render failed'); await quit(1); }
  const scroll = await page.evaluate(() => ({ sx: scrollX, sy: scrollY }));
  process.stdout.write(composeFrame(f, scroll).join('\n') + '\n');
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

    if (s.includes('q') || s.includes('\x03')) return quit(0);
    if (s.includes('\x1b[A')) wheel(-CH * 3);            // up
    else if (s.includes('\x1b[B')) wheel(CH * 3);        // down
    else if (s.includes('\x1b[5~')) wheel(-pageH);       // PgUp
    else if (s.includes('\x1b[6~') || s === ' ') wheel(pageH); // PgDn / space
    else if (s === 'g') page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    else if (s === 'G') page.evaluate(() => window.scrollTo(0, 1e9)).catch(() => {});
    else if (s === 't') { opt.noText = !opt.noText; redraw(); }
    else if (s === 'i') { opt.invert = !opt.invert; redraw(); }
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
      const [f, scroll] = await Promise.all([
        convert(b64),
        page.evaluate(() => ({ sx: scrollX, sy: scrollY }))
      ]);
      if (f && !quitting) draw(f, scroll);
    }
  } catch (e) {
    // Mid-navigation capture race; keep the last frame and try again.
  }
  if (!opt.noText && Date.now() - lastExtract > 1000) {
    lastExtract = Date.now();
    extractText(); // fire and forget; stamps land on the next frame
  }
  await sleep(Math.max(20, 1000 / opt.fps - (Date.now() - t0)));
}
