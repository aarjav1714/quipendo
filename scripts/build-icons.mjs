import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Regenerates every raster image from assets/logo.svg: the extension's PNG icons, the padded store icon, a 512 px logo
// and the 1280x640 social preview. The PNGs are committed, so a normal build does not need this or a browser. It uses the same
// Chromium that `npm run e2e` does.
const root = fileURLToPath(new URL('..', import.meta.url));
const logo = await readFile(`${root}assets/logo.svg`, 'utf8');

// At toolbar sizes the fine detail (bubbles, border, shadow) turns to noise, so it is dropped, the face is swapped for
// a bolder one (a bigger eye and a thicker smile) and the fish is drawn a little larger. The classes and ids below are
// the ones in assets/logo.svg.
const SMALL_MAX = 32;
const SMALL_STYLE =
  '.fine{display:none}.mark{filter:none}.face-detail{display:none}.face-bold{display:inline}#art{transform:translate(250px,268px) scale(1.04) translate(-256px,-256px)}';
const svgFor = (size) => (size <= SMALL_MAX ? logo.replace('</defs>', `</defs><style>${SMALL_STYLE}</style>`) : logo);
const page_html = (svg, size) =>
  `<!doctype html><body style="margin:0;background:transparent"><img id="logo" width="${size}" height="${size}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();

  const renderLogo = async (size) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(page_html(svgFor(size), size));
    await page.evaluate(() => document.getElementById('logo').decode());
    return page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };

  await mkdir(`${root}extension/icons`, { recursive: true });
  for (const size of [16, 32, 48, 128]) await writeFile(`${root}extension/icons/icon-${size}.png`, await renderLogo(size));
  await writeFile(`${root}assets/logo-512.png`, await renderLogo(512));

  // The Chrome Web Store listing asks for the artwork at 96x96 inside the 128x128 image, with 16 px of transparent
  // padding all round, so the icon looks as big as the others on the page. The packaged icon-128.png fills its square.
  await mkdir(`${root}assets/store`, { recursive: true });
  await page.setViewportSize({ width: 128, height: 128 });
  await page.setContent(
    `<!doctype html><body style="margin:0;background:transparent"><img id="logo" width="96" height="96" style="display:block;margin:16px" src="data:image/svg+xml;base64,${Buffer.from(svgFor(96)).toString('base64')}"></body>`,
  );
  await page.evaluate(() => document.getElementById('logo').decode());
  await writeFile(`${root}assets/store/store-icon-128.png`, await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: 128, height: 128 } }));

  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(pathToFileURL(`${root}assets/social-preview.html`).href);
  await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode())]));
  await writeFile(`${root}assets/social-preview.png`, await page.screenshot({ type: 'png' }));
} finally {
  await browser.close();
}
console.log('Wrote extension/icons/icon-{16,32,48,128}.png, assets/store/store-icon-128.png, assets/logo-512.png and assets/social-preview.png');
