#!/usr/bin/env node
// ascii-browse: a minimal terminal frontend for the ASCII Web pipeline.
//
// Architecture (the same pipeline as the extension, different display):
//   - headless Chrome renders the real page in one tab
//   - a second blank tab runs the extension's own shader files
//     (glyph-atlas.js, shaders.js, ascii-renderer.js — content.js stays
//     extension-only) against screenshots of the first
//   - readCells() hands back the cell grid, which we write as ANSI frames
//   - keys are forwarded as scrolling; q quits
//
// Usage:
//   ascii-browse <url> [--cell 8] [--threshold 0.08] [--fps 10]
//                      [--mono] [--invert] [--once]
//
// --invert flips the fill ramp ("paper mode"): right for mostly-white sites,
//   where the default bright->dense mapping yields a wall of @.
// --once renders a single frame to stdout and exits (no alt screen) — handy
//   for piping to a file or smoke-testing without a TTY.
//
// Interaction: mouse click = click the page (links, buttons, consent
// dialogs), wheel or arrows/PgUp/PgDn/space = scroll (real wheel events, so
// modal/container scrolling works too), g/G top/bottom, q quit.

import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PIPELINE_FILES = ['glyph-atlas.js', 'shaders.js', 'ascii-renderer.js'];

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { cell: 8, threshold: 0.08, fps: 10, mono: false, invert: false, once: false };
let url = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--mono') opt.mono = true;
  else if (a === '--invert') opt.invert = true;
  else if (a === '--once') opt.once = true;
  else if (a === '--cell') opt.cell = Math.max(2, Math.min(24, +argv[++i] || 8));
  else if (a === '--threshold') opt.threshold = +argv[++i] || 0.08;
  else if (a === '--fps') opt.fps = Math.max(1, Math.min(30, +argv[++i] || 10));
  else if (!a.startsWith('-') && !url) url = a;
  else {
    console.error('unknown option: ' + a);
    process.exit(1);
  }
}
if (!url) {
  console.error('usage: ascii-browse <url> [--cell 8] [--threshold 0.08] [--fps 10] [--mono] [--invert] [--once]');
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
    // Software WebGL2: newer Chrome needs the flag to allow SwiftShader.
    args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio']
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
// One terminal cell = cell x 2*cell source pixels (monospace glyphs are ~1:2).
const CW = opt.cell;
const CH = opt.cell * 2;
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
let grid = termGrid();
await page.setViewport({ width: grid.cols * CW, height: grid.rows * CH, deviceScaleFactor: 1 });
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

// One frame: screenshot the page tab, convert in the renderer tab.
async function captureFrame() {
  // Quality matters here: JPEG artifacts read as spurious DoG edges.
  const b64 = await page.screenshot({ type: 'jpeg', quality: 90, encoding: 'base64' });
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
    return { cols: g.cols, rows: g.rows, text: g.text, colors: Array.from(g.colors) };
  }, b64, CW, opt.threshold, opt.invert);
}

// ---- drawing ----------------------------------------------------------------
function frameToAnsi(f) {
  const lines = f.text.split('\n');
  const out = [];
  for (let y = 0; y < f.rows; y++) {
    if (opt.mono) {
      out.push(lines[y]);
      continue;
    }
    let line = '';
    let last = '';
    for (let x = 0; x < f.cols; x++) {
      const o = (y * f.cols + x) * 3;
      const c = '\x1b[38;2;' + f.colors[o] + ';' + f.colors[o + 1] + ';' + f.colors[o + 2] + 'm';
      if (c !== last) { line += c; last = c; } // only emit colour changes
      line += lines[y][x];
    }
    out.push(line + '\x1b[0m');
  }
  return out;
}

function draw(f) {
  const rowsOut = frameToAnsi(f);
  const status = '\x1b[7m ' + url.slice(0, grid.cols - 48) +
    '  |  q quit   click = click   wheel/↑↓/PgUpDn scroll \x1b[0m';
  process.stdout.write('\x1b[H' + rowsOut.map((l) => l + '\x1b[K\n').join('') + status + '\x1b[K');
}

// ---- --once: single frame to stdout, no TTY needed --------------------------
if (opt.once) {
  const f = await captureFrame();
  if (!f) { console.error('render failed'); await quit(1); }
  process.stdout.write(frameToAnsi(f).join('\n') + '\n');
  await quit(0);
}

// ---- input ------------------------------------------------------------------
// Scrolling dispatches real wheel events (not window.scrollBy) so it works on
// pages that scroll a container or lock body scroll (consent modals etc.).
// Terminal mouse reporting (SGR) makes cells clickable: cell -> page pixels.
let mouseX = 0; // last known page-pixel position; wheel lands here
let mouseY = 0;

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
      mouseX = (+m[2] - 0.5) * CW; // 1-based cell -> page pixel at cell centre
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
  });
}

process.stdout.on('resize', () => {
  grid = termGrid();
  page.setViewport({ width: grid.cols * CW, height: grid.rows * CH, deviceScaleFactor: 1 })
    .catch(() => {});
});

// ---- frame loop ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Alt screen, hide cursor, clear, enable SGR mouse reporting.
process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1000h\x1b[?1006h');
while (!quitting) {
  const t0 = Date.now();
  try {
    const f = await captureFrame();
    if (f && !quitting) draw(f);
  } catch (e) {
    if (!quitting) {
      process.stdout.write('\x1b[H\x1b[0mframe error: ' + e.message + '\x1b[K');
    }
  }
  await sleep(Math.max(0, 1000 / opt.fps - (Date.now() - t0)));
}
