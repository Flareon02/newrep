#!/usr/bin/env node
// Rasterizes the extension icon from its SVG sources with local Chromium (Playwright): 16/32 from icon-small.svg,
// 48/128 from icon.svg, transparent background. Also previews them on dark and light backgrounds.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tools/ux/render-icons.mjs [--preview out.png]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pw = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(pw.startsWith('/') ? pathToFileURL(pw).href : pw);
const src = (f) => 'data:image/svg+xml;base64,' + Buffer.from(readFileSync(path.join(root, 'tools/ux/icon', f))).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [size, file] of [[16, 'icon-small.svg'], [32, 'icon-small.svg'], [48, 'icon.svg'], [128, 'icon.svg']]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src(file)}" width="${size}" height="${size}" style="display:block"></body></html>`);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: path.join(root, `extension/icons/icon${size}.png`), omitBackground: true });
  console.log(`extension/icons/icon${size}.png`);
}
const i = process.argv.indexOf('--preview');
if (i > 0) {
  await page.setViewportSize({ width: 520, height: 300 });
  const row = (bg) => `<div style="background:${bg};padding:16px;display:flex;gap:24px;align-items:center">${[16, 32, 48, 128].map((n) => `<img src="${src(n < 48 ? 'icon-small.svg' : 'icon.svg')}" width="${n}" height="${n}">`).join('')}</div>`;
  await page.setContent(`<html><body style="margin:0">${row('#0d1117')}${row('#f4f6f9')}</body></html>`);
  await page.screenshot({ path: process.argv[i + 1] });
  console.log(process.argv[i + 1]);
}
await browser.close();
