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
//                      [--mono] [--invert] [--no-text] [--hidpi]
//                      [--braille] [--sound] [--once]
//
// --invert  flips the fill ramp ("paper mode"): right for mostly-white sites.
// --no-text disables the DOM text overlay (pure art mode).
// --hidpi   captures at 2x device pixels: ~4x source detail per cell, slower.
// --braille renders imagery as braille dot-matrix cells (2x4 dots per cell =
//           8x the spatial detail of one ASCII glyph); the DOM text layer
//           still stamps normal readable characters on top. Trades the ASCII
//           aesthetic for detail.
// --sound   (experimental, parked) launches a real (visible) Chrome window
//           instead of headless and doesn't mute it — minimize the window
//           and audio plays normally. (Headless Chrome has no audio path.)
// --once    renders a single frame to stdout and exits (no TTY needed).
//
// Keys (normal mode): q quit · f link hints (type the label to click; works
// on links/buttons/inputs — selecting an input enters insert mode) · e insert
// mode (keys forward to the page; Esc exits) · H/L history back/forward ·
// wheel/↑↓/PgUp/PgDn/space scroll · g/G top/bottom · t text overlay ·
// i invert · b braille. Mouse click/wheel work in every mode.

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
  mono: false, invert: false, noText: false, hidpi: false,
  braille: false, sound: false, once: false
};
let url = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--mono') opt.mono = true;
  else if (a === '--invert') opt.invert = true;
  else if (a === '--no-text') opt.noText = true;
  else if (a === '--hidpi') opt.hidpi = true;
  else if (a === '--braille') opt.braille = true;
  else if (a === '--sound') opt.sound = true;
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
// Braille packs a 2x4 dot matrix per cell, so a cell must split evenly into
// half-width subcells at least 2px wide.
if (opt.cell % 2) opt.cell += 1;
if (opt.braille && opt.cell < 4) opt.cell = 4;

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
  const args = [
    // Software WebGL2: newer Chrome needs the flag to allow SwiftShader.
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    // Headless counts no input as "no user gesture": videos never start
    // without this.
    '--autoplay-policy=no-user-gesture-required'
  ];
  // Headless Chrome has no audio output path; --sound runs a real window
  // (minimize it) so audio reaches the system mixer.
  if (!opt.sound) args.push('--mute-audio');
  const common = { headless: !opt.sound, args };
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
// Navigations wipe injected styles; re-apply.
page.on('framenavigated', (fr) => {
  if (!fr.parentFrame()) setTextHidden(!opt.noText);
});

// ---- frame conversion (runs in the renderer tab) ------------------------------
// ASCII mode: one shader cell per terminal cell (aspect 2).
// Braille mode: square subcells at half the cell width — a terminal cell
// covers exactly 2x4 of them, one per braille dot.
async function convert(b64) {
  const braille = opt.braille;
  const f = await rendererPage.evaluate(async (b64, cell, threshold, invert, braille) => {
    const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
    // flipY baked in: WebGL ignores UNPACK_FLIP_Y for ImageBitmap sources.
    const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
    const g = window.__r.readCells(bmp, bmp.width, bmp.height, {
      cellSize: braille ? cell / 2 : cell,
      cellAspect: braille ? 1 : 2,
      edgeThreshold: threshold,
      invert: invert
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
    return {
      cols: g.cols,
      rows: g.rows,
      text: g.text,
      colors: b64ify(g.colors),
      glyphs: braille ? b64ify(g.glyphs) : null
    };
  }, b64, CW * DSF, opt.threshold, opt.invert, braille);
  if (f) f.braille = braille; // pin the mode used, in case 'b' toggles mid-frame
  return f;
}

// ---- DOM text layer -----------------------------------------------------------
// Extract every visible word with its document position and CSS colour, then
// group words into visual lines (clustered by y-centre). Runs ~1/s (positions
// are document-relative, so scrolling doesn't invalidate them).
let textLines = []; // [{ y, words: [...x-sorted] }], sorted by y
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
        out.push({ t: m[0], x: r.left + scrollX, y: r.top + scrollY + r.height / 2, c: col, b: bold, u: link });
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
        u: 0
      });
    });
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
}

// ---- modes ----------------------------------------------------------------------
// normal: browse keys. insert: keys forward to the page (Esc exits).
// hint: visible clickables wear labels; typing a label clicks it.
let mode = 'normal';
let hints = [];     // [{ label, x, y }] in document CSS pixels
let hintPrefix = '';

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
  const overrides = new Map(); // cellIndex -> [r,g,b] from CSS text colour

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
        const ideal = Math.round((w.x - scroll.sx) / CW);
        const col = Math.max(ideal, cursor);
        if (col >= cells.cols) continue;
        if (col - 1 >= cursor && col - 1 >= 0) chars[row][col - 1] = ' '; // pad before
        for (let i = 0; i < w.t.length && col + i < cells.cols; i++) {
          chars[row][col + i] = w.t[i];
          overrides.set(row * cells.cols + col + i, w);
        }
        const gap = col + w.t.length;
        if (gap < cells.cols) chars[row][gap] = ' '; // blank the separator cell
        cursor = gap + 1;
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
    if (opt.mono) {
      line = chars[y].join('');
    } else {
      let last = '';
      for (let x = 0; x < cells.cols; x++) {
        const ov = overrides.get(y * cells.cols + x);
        const o = (y * cells.cols + x) * 3;
        // Self-contained style per run: leading 0 resets bold/underline from
        // the previous run, then colour, then this run's attributes.
        const c = ov
          ? (ov.hint
            ? '\x1b[0;30;103m' // hint label: black on bright yellow
            : '\x1b[0;38;2;' + ov.c[0] + ';' + ov.c[1] + ';' + ov.c[2] +
              (ov.b ? ';1' : '') + (ov.u ? ';4' : '') + 'm')
          : '\x1b[0;38;2;' + colors[o] + ';' + colors[o + 1] + ';' + colors[o + 2] + 'm';
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
  let help;
  if (mode === 'insert') help = ' -- INSERT -- keys go to the page · Esc back ';
  else if (mode === 'hint') help = ' -- LINKS ' + hintPrefix + ' -- type a label · Esc cancel ';
  else help = ' | q quit · f links · e type · H/L back/fwd · t/i/b modes ';
  const status = '\x1b[7m ' + url.slice(0, Math.max(10, grid.cols - help.length - 2)) +
    help + '\x1b[0m';
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
  if (out) process.stdout.write(out);
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
    if (!s) return;

    if (s.includes('\x03')) return quit(0); // Ctrl-C always quits

    if (mode === 'insert') {
      if (s === '\x1b') { mode = 'normal'; redraw(); return; } // bare Esc
      forwardKeys(s);
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
      const [f, scroll] = await Promise.all([
        convert(b64),
        page.evaluate(() => ({ sx: scrollX, sy: scrollY }))
      ]);
      if (f && !quitting) draw(f, scroll);
    }
  } catch (e) {
    // Mid-navigation capture race; keep the last frame and try again.
  }
  // Insert mode refreshes faster so typed field values show promptly — and
  // must force the redraw itself: the page's own text is transparent in the
  // capture, so typing never trips the screenshot change-detector.
  if (!opt.noText && Date.now() - lastExtract > (mode === 'insert' ? 250 : 1000)) {
    lastExtract = Date.now();
    extractText().then(() => { if (mode === 'insert') redraw(); });
  }
  await sleep(Math.max(20, 1000 / opt.fps - (Date.now() - t0)));
}
