import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Makes the images the Chrome Web Store asks for, in assets/store/: a 440x280 promo tile, a 1400x560 marquee and
// 1280x800 screenshots. The screenshots are of the real extension page working on the mock account that the tests use
// (made-up documents, nothing from a real account), set in a captioned frame. The files are JPEG because the store
// does not accept PNGs with an alpha channel, which is what a browser screenshot produces.
//
// Usage: npm run store-assets (builds the test build of the extension first; needs the Chromium of `npm run e2e`).
const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}assets/store`;
const QUALITY = 95;

execFileSync(process.execPath, [`${root}scripts/build.mjs`, '--e2e'], { stdio: 'inherit' });

// The mock server is TypeScript that only the tests use, so it is bundled into a temporary file for this run.
const bundled = await build({
  stdin: {
    contents: "export { startMockQuip } from './tests/mock/quipMock'; export { SITE, T_PLAN, TOKEN } from './tests/mock/fixture';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'warning',
});
const work = await mkdtemp(join(tmpdir(), 'quipendo-store-'));
await writeFile(`${work}/mock.mjs`, bundled.outputFiles[0].text);
const { startMockQuip, SITE, T_PLAN, TOKEN } = await import(pathToFileURL(`${work}/mock.mjs`).href);

await mkdir(out, { recursive: true });
const mock = await startMockQuip();
const extension = `${root}dist-e2e`;
const context = await chromium.launchPersistentContext(`${work}/profile`, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 860, height: 1100 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const state = (page, value) => page.waitForSelector(`body[data-state="${value}"]`, { timeout: 60_000 });
  const open = async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/exporter.html?${new URLSearchParams({ e2e: '1', base: mock.url, token: TOKEN })}`);
    await state(page, 'idle');
    await page.click('#btn-connect');
    await state(page, 'connected');
    return page;
  };

  // Raw screenshots of parts of the page, taken at twice the size so they stay sharp when scaled into a frame.
  const shots = {};

  let page = await open();
  await page.fill('#preview-url', `${SITE}/${T_PLAN}/Project-Plan`);
  await page.click('#btn-preview');
  await page.waitForSelector('#preview-result:not([hidden])');
  // Scroll the text past the front matter to the part that shows what calendars, boards and trackers become.
  await page.$eval('#preview-text', (el) => {
    const at = el.value.indexOf('**Calendar**');
    el.scrollTop = Math.max(0, (el.value.slice(0, at).split('\n').length - 3) * 18);
  });
  shots.preview = await page.locator('#step-preview').screenshot({ type: 'png' });
  await page.close();

  page = await open();
  await page.click('#btn-scan');
  await state(page, 'scanned');
  await page.locator('#tree button.twisty[aria-label$="Projects"]').click();
  await page.locator('#tree label').filter({ has: page.getByText('Budget', { exact: true }) }).locator('input').uncheck();
  await page.locator('#tree label').filter({ has: page.getByText('Team Shared', { exact: true }) }).locator('input').uncheck();
  // The list scrolls on the page; the picture shows all of it.
  await page.$eval('#tree', (el) => {
    el.style.maxHeight = 'none';
  });
  shots.tree = await page.locator('#tree-panel').screenshot({ type: 'png' });
  await page.close();

  page = await open();
  await page.check('#out-store');
  await page.click('#btn-scan');
  await state(page, 'scanned');
  await page.click('#btn-run');
  await state(page, 'done');
  shots.zip = await page.locator('#step-run').screenshot({ type: 'png' });
  await page.close();

  const frame = await context.newPage();
  await frame.setViewportSize({ width: 1280, height: 800 });
  const framed = async (name, caption, sub, png, padding = 0) => {
    await frame.goto(pathToFileURL(`${root}assets/store-shot.html`).href);
    await frame.evaluate(
      async ([c, s, data, pad]) => {
        document.getElementById('caption').textContent = c;
        document.getElementById('sub').textContent = s;
        const img = document.getElementById('shot');
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        // Shown at the size it had on the page (half the captured size), or smaller if that would not fit the frame.
        const width = img.naturalWidth / 2;
        const height = img.naturalHeight / 2;
        const fit = Math.min(1, 1100 / width, 600 / height);
        img.style.width = `${width * fit}px`;
        img.style.height = `${height * fit}px`;
        // A part of a card has no edge of its own, so it gets the card's white around it.
        const box = document.querySelector('.frame');
        box.style.padding = `${pad}px`;
        box.style.background = pad > 0 ? '#fff' : '';
      },
      [caption, sub, png.toString('base64'), padding],
    );
    await frame.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: QUALITY, scale: 'css' });
  };
  await framed('screenshot-1-preview', 'See what a document becomes first', 'Calendars, boards and trackers turn into plain Markdown. Nothing is saved in a preview.', shots.preview);
  await framed('screenshot-2-choose', 'Pick exactly what to export', 'Tick folders and documents, filter by name, and see where each one will be saved.', shots.tree, 24);
  await framed('screenshot-3-export', 'Save to a folder, or as a .zip', 'Read-only: Quipendo can look at your Quip documents but cannot change them.', shots.zip);

  const tiles = [
    ['promo-tile-440x280', '?tile', { width: 440, height: 280 }],
    ['marquee-1400x560', '?marquee', { width: 1400, height: 560 }],
  ];
  for (const [name, query, size] of tiles) {
    await frame.setViewportSize(size);
    await frame.goto(`${pathToFileURL(`${root}assets/store-promo.html`).href}${query}`);
    await frame.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode())]));
    await frame.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: QUALITY, scale: 'css' });
  }
} finally {
  await context.close();
  await mock.close();
  await rm(work, { recursive: true, force: true });
}
console.log('Wrote assets/store/{promo-tile-440x280,marquee-1400x560,screenshot-1-preview,screenshot-2-choose,screenshot-3-export}.jpg');
