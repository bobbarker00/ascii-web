#!/usr/bin/env node
// Generates the extension icons (16/32/48/128) with headless Chrome — the
// same one the CLI uses — so the repo needs no image tooling installed.
// Design: terminal-dark rounded square, green '@' (the densest glyph of the
// fill ramp), with corner glyphs hinting at the edge characters at 128px.

import puppeteer from '../cli/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

function chromePath() {
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome']) {
    try {
      const p = execSync('command -v ' + name, { shell: '/bin/bash', stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
      if (p) return p;
    } catch (e) { /* keep looking */ }
  }
  return null;
}

let browser;
try {
  browser = await puppeteer.launch({ channel: 'chrome', headless: true });
} catch (e) {
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
}
const page = await browser.newPage();

for (const size of [16, 32, 48, 128]) {
  const dataUrl = await page.evaluate((s) => {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');

    // Rounded terminal-dark tile.
    const r = s * 0.18;
    ctx.beginPath();
    ctx.roundRect(0, 0, s, s, r);
    ctx.fillStyle = '#0d1117';
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (s >= 48) {
      // Corner edge glyphs, dim.
      ctx.fillStyle = 'rgba(120, 220, 120, 0.35)';
      ctx.font = 'bold ' + s * 0.28 + 'px monospace';
      ctx.fillText('/', s * 0.2, s * 0.22);
      ctx.fillText('\\', s * 0.8, s * 0.22);
      ctx.fillText('\\', s * 0.2, s * 0.8);
      ctx.fillText('/', s * 0.8, s * 0.8);
    }

    // The '@' — densest glyph of the fill ramp.
    ctx.fillStyle = '#7ee787';
    ctx.shadowColor = 'rgba(126, 231, 135, 0.8)';
    ctx.shadowBlur = s * 0.12;
    ctx.font = 'bold ' + s * 0.62 + 'px monospace';
    ctx.fillText('@', s / 2, s / 2 + s * 0.03);

    return c.toDataURL('image/png');
  }, size);

  const file = join(OUT, 'icon' + size + '.png');
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', file);
}

await browser.close();
