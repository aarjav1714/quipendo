import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Makes the images the Chrome Web Store asks for, in assets/store/: a 440x280 promo tile, a 1400x560 marquee and
// 1280x800 screenshots (the Mac App Store takes the same size). The screenshots are of the real, production-built extension
// page running its built-in demo (a made-up account, nothing from a real one), set in a captioned frame. The files are
// JPEG because the store does not accept PNGs with an alpha channel, which is what a browser screenshot produces.
//
// Usage: npm run store-assets (builds the extension first; needs the Chromium of `npm run e2e`).
const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}assets/store`;
const QUALITY = 95;

execFileSync(process.execPath, [`${root}scripts/build.mjs`], { stdio: 'inherit' });

// The demo account is TypeScript, so it is bundled into a temporary file just to read the addresses of its documents.
const bundled = await build({
  stdin: {
    contents: "export { demoDocuments } from './src/demo/account';",
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
await writeFile(`${work}/demo.mjs`, bundled.outputFiles[0].text);
const { demoDocuments } = await import(pathToFileURL(`${work}/demo.mjs`).href);
const docs = new Map(demoDocuments().map((d) => [d.title, d.url]));
const PLAN = 'Website Relaunch: Project Plan';
if (!docs.has(PLAN)) throw new Error(`The demo account has no document called "${PLAN}".`);

await mkdir(out, { recursive: true });
const extension = `${root}dist`;
const context = await chromium.launchPersistentContext(`${work}/profile`, {
  channel: 'chromium',
  headless: true,
  colorScheme: 'light',
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
    await page.goto(`chrome-extension://${id}/exporter.html?demo=1`);
    await state(page, 'connected');
    return page;
  };
  const preview = async (page, title) => {
    await page.fill('#preview-url', docs.get(title));
    await page.click('#btn-preview');
    await page.waitForSelector('#preview-result:not([hidden])');
  };
  // The tabs and the document under them, without the instructions above, in a pane that ends between two blocks so that no line
  // is cut in half: it starts at the heading `from` (or the top) and ends where the next heading called `until` begins.
  const reading = async (page, { markdown = false, height = 540, from = '', until = '' } = {}) => {
    const pane = markdown ? '#preview-text' : '#preview-rendered';
    if (markdown) await page.click('#tab-markdown');
    await page.$eval(
      pane,
      (el, [fallback, first, last]) => {
        const find = (wanted, after) => {
          const headings = [...el.querySelectorAll('h1, h2, h3, h4, h5, h6')];
          const hit = headings.find((h) => (h.textContent ?? '').trim() === wanted && (!after || after.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING));
          if (!hit) throw new Error(`The preview has no heading "${wanted}".`);
          return hit;
        };
        const top = (e) => e.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        const start = first ? find(first) : undefined;
        const end = last ? find(last, start) : undefined;
        let size = fallback;
        if (end) size = top(end) - (start ? top(start) : 0) - 6;
        if (el.tagName === 'TEXTAREA') el.style.height = `${size}px`;
        else el.style.maxHeight = `${size}px`;
        if (start) start.scrollIntoView({ block: 'start' });
      },
      [height, from, until],
    );
    const area = await page.evaluate((selector) => {
      const top = document.querySelector('#preview-result .tabs').getBoundingClientRect();
      const bottom = document.querySelector(selector).getBoundingClientRect();
      return { x: top.left + window.scrollX, y: top.top + window.scrollY, width: top.width, height: bottom.bottom - top.top };
    }, pane);
    return page.screenshot({ type: 'png', fullPage: true, clip: area });
  };

  // Raw screenshots of parts of the page, taken at twice the size so they stay sharp when scaled into a frame.
  const shots = {};

  let page = await open();
  await preview(page, PLAN);
  shots.plan = await reading(page, { until: 'Timeline' });
  await page.close();

  page = await open();
  await preview(page, PLAN);
  shots.board = await reading(page, { from: 'Board', until: 'Design' });
  await page.close();

  page = await open();
  await preview(page, PLAN);
  shots.markdown = await reading(page, { markdown: true, height: 560 });
  await page.close();

  page = await open();
  await page.check('#out-store');
  await page.click('#btn-scan');
  await state(page, 'scanned');
  await page.locator('#tree button.twisty[aria-label$="Projects"]').click();
  await page.locator('#tree label').filter({ has: page.getByText('Budget 2026', { exact: true }) }).locator('input').uncheck();
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
  await framed('screenshot-1-preview', 'See what a document becomes first', 'Drawn the way it reads, with its status bar, checklist and links. Nothing is saved in a preview.', shots.plan);
  await framed('screenshot-2-board', 'Calendars, boards and trackers come across', 'Embedded apps become text you can read and search, not empty boxes.', shots.board);
  await framed('screenshot-3-markdown', 'Plain Markdown, ready to keep', 'Opens in Obsidian, VS Code or any editor. Links between documents work offline.', shots.markdown);
  await framed('screenshot-4-choose', 'Pick exactly what to export', 'Tick folders and documents, filter by name, and see where each one will be saved.', shots.tree, 24);
  await framed('screenshot-5-export', 'Save to a folder, or as a .zip', 'Read-only: Quipendo can look at your Quip documents but cannot change them.', shots.zip);

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
  await rm(work, { recursive: true, force: true });
}
console.log('Wrote assets/store/{promo-tile-440x280,marquee-1400x560,screenshot-1-preview,screenshot-2-board,screenshot-3-markdown,screenshot-4-choose,screenshot-5-export}.jpg');
