import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExportOptions } from '../../src/core';
import { createSession } from '../../src/core/session';
import { DOCX_BYTES, F_ARCH, F_DESK, F_PRIV, F_SHARED, F_TRASH, ME, PNG_1X1, SITE, T_CHAT, T_PLAN, T_READING_SECRET, T_SHARED, T_SHEET, T_SLIDES, TOKEN, XLSX_BYTES } from '../mock/fixture';
import { probeHtml, startMockQuip, type MockQuip } from '../mock/quipMock';
import { NodeFsSink, parseHtml } from '../helpers/env';
import { readZip, type ZipEntry } from '../helpers/unzip';
import { driverFor } from './harness';
import type { E2EPage } from './harness/types';

// The same scenarios run in every browser: `E2E_BROWSER=chromium|firefox|webkit|safari` (see tests/e2e/harness).
const driver = driverFor(process.env.E2E_BROWSER ?? 'chromium');
let mock: MockQuip;

beforeAll(async () => {
  mock = await startMockQuip();
  await driver.start(mock);
});

// A failed assertion must not leave an exporter page running: it would keep the export lock and write into the next test's folder.
afterEach(() => driver.reset());

afterAll(async () => {
  await driver.stop();
  await mock?.close();
});

const openExporter = (extra: Record<string, string> = {}): Promise<E2EPage> => driver.open(extra);

const state = (page: E2EPage, value: string, timeout = 60_000) => page.waitForSelector(`body[data-state="${value}"]`, { timeout });

async function connect(page: E2EPage): Promise<void> {
  await page.click('#btn-connect');
  await state(page, 'connected');
}

async function readTree(page: E2EPage): Promise<Record<string, string>> {
  return page.evaluate(() => (window as unknown as { __e2e: { readTree(): Promise<Record<string, string>> } }).__e2e.readTree());
}

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const TEXT = /\.(md|json|html|txt)$/;

async function nodeTree(dir: string, rel = '', out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out[`${path}/`] = '';
      await nodeTree(dir, path, out);
    } else if (TEXT.test(entry.name)) out[path] = await readFile(join(dir, path), 'utf8');
    else out[path] = `<binary ${(await readFile(join(dir, path))).length} bytes>`;
  }
  return out;
}

const comparable = (tree: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tree)
      .filter(([path]) => !path.startsWith('.quip-md-export/'))
      .map(([path, text]) => [path, text.replace(TS, '<time>')]),
  );

/** What the page produces with its default settings, made by the Node pipeline instead: every browser export must match it. */
async function nodeReference(extra: Partial<ExportOptions> = {}): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'quip-e2e-node-'));
  try {
    const { exporter } = createSession({
      token: TOKEN,
      baseUrl: mock.url,
      sink: new NodeFsSink(dir),
      parseHtml,
      options: {
        rootIds: [F_PRIV, F_DESK, F_SHARED, F_ARCH],
        allRootIds: [F_PRIV, F_DESK, F_SHARED, F_ARCH, F_TRASH], // Starred is a view, so the page leaves it out
        ownerId: ME.id,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        siteUrl: SITE,
        ...extra,
      },
      client: { minIntervalMs: 0 },
    });
    await exporter.run();
    return comparable(await nodeTree(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The files of a downloaded .zip, shaped like `nodeTree` (folders that hold files have no entry of their own in a .zip). */
function zipFiles(zip: Record<string, ZipEntry>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(zip)
      .filter(([name]) => !name.endsWith('/'))
      .map(([name, entry]) => [name, TEXT.test(name) ? new TextDecoder().decode(entry.data) : `<binary ${entry.data.length} bytes>`]),
  );
}

const withoutDirs = (tree: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(tree).filter(([name]) => !name.endsWith('/')));

const saveDownload = (page: E2EPage, selector: string, index = 0) => driver.saveDownload(page, selector, index);

/** The checkbox of a folder or document in the tree, found by the name beside it. */
const treeBox = (page: E2EPage, name: string) => {
  const act = (action: 'checked' | 'indeterminate' | 'uncheck') =>
    page.evaluate(
      ({ n, what }: { n: string; what: string }) => {
        const label = Array.from(document.querySelectorAll('#tree label')).find((l) => Array.from(l.querySelectorAll('span, small')).some((s) => s.textContent === n));
        const box = label?.querySelector('input') as HTMLInputElement | null | undefined;
        if (!box) throw new Error(`No entry named ${n} in the tree`);
        if (what === 'uncheck') {
          if (box.checked) box.click();
          return true;
        }
        return what === 'checked' ? box.checked : box.indeterminate;
      },
      { n: name, what: action },
    );
  return { isChecked: () => act('checked'), isIndeterminate: () => act('indeterminate'), uncheck: () => act('uncheck') };
};

/** The documents in the tree that can be seen: not filtered out and not inside a folded folder. */
const shownDocs = (page: E2EPage): Promise<string[]> =>
  page.$$eval('#tree li[data-kind="doc"]', (items) => items.filter((li) => !li.closest('[hidden]')).map((li) => li.querySelector('label span')?.textContent ?? ''));

/** Starts a scan and waits for it to finish, even when the page was already showing the result of an earlier one. */
async function rescan(page: E2EPage): Promise<void> {
  const before = mock.requests.length;
  await page.click('#btn-scan');
  await expect.poll(() => mock.requests.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await state(page, 'scanned');
}

describe(`the extension in ${driver.name}`, () => {
  it('loads with its branding and the production-safe manifest', async () => {
    if (driver.name === 'chromium') expect(driver.origin()).toMatch(/^chrome-extension:\/\/[a-p]{32}$/);
    const page = await openExporter();
    expect(await page.title()).toBe('Quipendo');
    await expect(page.evaluate(() => (document.querySelector('header img') as HTMLImageElement | null)?.naturalWidth ?? 0)).resolves.toBeGreaterThan(0);
    // The heading is the wordmark picture, in the version that suits the page's colour scheme.
    const wordmark = () => page.evaluate(() => ({ width: (document.querySelector('h1 img') as HTMLImageElement | null)?.naturalWidth ?? 0, src: (document.querySelector('h1 img') as HTMLImageElement | null)?.currentSrc ?? '' }));
    await expect(page.$$eval('h1', (headings) => headings.filter((h) => (h.querySelector('img') as HTMLImageElement | null)?.alt === 'Quipendo').length)).resolves.toBe(1);
    // A browser that cannot be told which scheme to prefer follows the computer's appearance, which changes with the time of day.
    if (driver.setColorScheme) {
      await driver.setColorScheme(page, 'light');
      await expect.poll(async () => (await wordmark()).src).toMatch(/wordmark-on-light\.svg$/);
      await driver.setColorScheme(page, 'dark');
      await expect.poll(async () => (await wordmark()).src).toMatch(/wordmark-on-dark\.svg$/);
    } else {
      const dark = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
      expect((await wordmark()).src).toMatch(dark ? /wordmark-on-dark\.svg$/ : /wordmark-on-light\.svg$/);
    }
    await expect.poll(async () => (await wordmark()).width).toBeGreaterThan(0);
    // Some browsers hand the icon paths back as full addresses of the extension.
    await expect(page.evaluate(() => chrome.runtime.getManifest().icons)).resolves.toMatchObject({ '16': expect.stringMatching(/icons\/icon-16\.png$/), '128': expect.stringMatching(/icons\/icon-128\.png$/) });
    // Where the browser has no request-blocking of its own, the page says so instead of claiming a guard it does not have.
    await expect(page.textContent('#guard-status')).resolves.toContain(driver.can.guard ? 'read-only guard: on' : 'read-only guard: unavailable');
    if (driver.can.folder) {
      await expect(page.textContent('#target-name')).resolves.toBe('e2e-target');
      await expect(page.isChecked('#out-folder')).resolves.toBe(true);
    } else {
      // No folder picker in this browser: the export is kept in the browser, and the page says why the folder option is off.
      await expect(page.isDisabled('#out-folder')).resolves.toBe(true);
      await expect(page.isChecked('#out-store')).resolves.toBe(true);
      await expect(page.isVisible('#folder-unavailable')).resolves.toBe(true);
      await expect(page.isVisible('#folder-row')).resolves.toBe(false);
    }
    await page.close();
  });

  it('exports the whole mock account through the UI and matches the Node pipeline byte for byte', async () => {
    const page = await openExporter();
    await connect(page);
    await expect(page.textContent('#connect-status')).resolves.toContain('Connected as Jane Doe (acme.quip.com)');
    const roots = await page.$$eval('#roots label', (labels) => labels.map((l) => ({ text: l.textContent ?? '', checked: (l.querySelector('input') as HTMLInputElement).checked })));
    expect(roots.map((r) => r.text)).toEqual(['PrivatePrivate', 'DesktopDesktop', 'Team SharedShared folder', 'ArchiveArchive', 'StarredStarred', 'TrashTrash']);
    expect(roots.map((r) => r.checked)).toEqual([true, true, true, true, false, false]);

    await page.click('#btn-scan');
    await state(page, 'scanned');
    await expect(page.textContent('#scan-summary')).resolves.toContain('9 documents in 5 folders');
    // A folder that cannot be read leaves unfiled documents uncertain, and the user hears about it before anything is written.
    await expect(page.textContent('#scan-summary')).resolves.toContain('1 folder could not be read, so documents you wrote inside it may also be exported under "_Unfiled"');

    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved, 0 unchanged of 9 documents/);
    const tree = await readTree(page);

    // Same inputs through the Node + jsdom pipeline must give identical files.
    expect(comparable(tree)).toEqual(await nodeReference());

    expect(tree['Private/Projects/Project Plan.md']).toContain('**Calendar** (2021-10)');
    expect(tree['Private/Reading Log.md']).toContain('| Month | Pages | Done |');
    expect(tree['_attachments/PLANthread1/BLOBok00001.png']).toBe(`<binary ${PNG_1X1.length} bytes>`);
    expect(tree['Private/Reading Log.xlsx']).toBe(`<binary ${XLSX_BYTES.length} bytes>`);
    expect(tree['Private/Reading Log.md']).toContain('Original spreadsheet with its formulas: [Reading Log.xlsx]');
    expect(tree['Desktop/']).toBe('');
    expect(Object.keys(tree)).toContain('.quip-md-export/state.json');
    await page.close();
  });

  it('only ever sent authenticated GET requests during the browser export', () => {
    expect(mock.requests.length).toBeGreaterThan(20);
    expect(mock.mutating()).toEqual([]);
    expect(mock.requests.filter((r) => r.path !== '/1/users/current' || r.auth !== '').every((r) => r.auth === `Bearer ${TOKEN}` || r.auth === '')).toBe(true);
  });

  it('resumes: a second run through the UI skips what is already saved', async () => {
    const page = await openExporter();
    await connect(page);
    await page.fill('#opt-max', '2');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/2 saved, 0 unchanged of 2 documents/);

    await page.fill('#opt-max', '');
    await page.click('#btn-run');
    await state(page, 'done');
    // A note whose links could not be resolved on the first run is rendered again now that their targets exist.
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 8 saved, 1 unchanged of 9 documents/);
    await page.close();
  });

  it('offers the Quip page the user came from as the export scope', async () => {
    const page = await openExporter({ from: `${SITE}/${T_PLAN}/Project-Plan` });
    await connect(page);
    await expect(page.isVisible('#page-scope')).resolves.toBe(true);
    await expect(page.textContent('#page-label')).resolves.toBe('Document: Project Plan');
    await expect(page.isChecked('#scope-page')).resolves.toBe(true);
    await page.click('#btn-run');
    await state(page, 'done');
    const tree = await readTree(page);
    expect(Object.keys(tree).filter((p) => p.endsWith('.md') && !p.startsWith('_'))).toEqual(['Project Plan.md']);
    expect(tree['Project Plan.md']).toContain('[Reading Log](https://acme.quip.com/tREADINGth1v/Reading-Log#temp:C:abc)');
    await page.close();
  });

  it('reports a rejected token without exporting anything', async () => {
    const page = await openExporter({ token: 'not-the-token' });
    await page.click('#btn-connect');
    await page.waitForFunction(() => document.getElementById('connect-status')?.getAttribute('data-tone') === 'error');
    await expect(page.textContent('#connect-status')).resolves.toContain('Quip rejected the access token');
    await expect(page.textContent('#btn-run')).resolves.toBe('Start export');
    expect(await page.isDisabled('#btn-run')).toBe(true);
    await page.close();
  });

  it.skipIf(!driver.can.guard)('blocks every kind of write, even to an address the extension has no permission for, while reads still work', async () => {
    const page = await openExporter();
    const hook = (name: string, ...args: string[]) =>
      page.evaluate(([n, a]) => (window as unknown as { __e2e: Record<string, (...x: string[]) => Promise<string>> }).__e2e[n as string]!(...(a as string[])), [name, args] as const);

    const before = mock.requests.length;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await hook('tryMutation', `${mock.url}/1/threads/edit-document`, method), method).toMatch(/^blocked:/);
    }
    // The blocked requests never reached the server...
    expect(mock.requests.length).toBe(before);
    // ...while a plain GET to the same host goes through (401: no token supplied by this probe).
    expect(await hook('tryRead', `${mock.url}/1/users/current`)).toBe('reached:401');
    expect(mock.requests.length).toBe(before + 1);

    // The same server under a name the extension has no host permission for. Browser security makes the
    // answers unreadable, so the server's own log is the witness: the read arrives, the write never does.
    const elsewhere = mock.url.replace('127.0.0.1', 'localhost');
    await hook('tryRead', `${elsewhere}/guard/get`);
    await hook('tryMutation', `${elsewhere}/guard/post`);
    const seen = mock.requests.map((r) => `${r.method} ${r.path}`);
    if (driver.can.unpermittedReads) expect(seen).toContain('GET /guard/get');
    expect(seen).not.toContain('POST /guard/post');
    expect(mock.mutating()).toEqual([]);
    await page.close();
  });

  it('never fetches the sub-resources that Quip HTML points at', async () => {
    const probe = await startMockQuip({ probe: true });
    const plain = await driver.openPlain(`${probe.url}/control.html`);
    const page = await openExporter({ base: probe.url });
    try {
      // Parsing is inert in this browser...
      const markup = probeHtml(probe.url);
      await plain.evaluate((html) => void new DOMParser().parseFromString(html, 'text/html'), markup);
      await plain.waitForTimeout(500);
      expect(probe.probeHits()).toEqual([]);
      // ...whereas the same markup in a live page does make the browser fetch things, so the probe can detect a leak.
      await plain.evaluate((html) => {
        const box = document.createElement('div');
        box.innerHTML = html;
        document.body.append(box);
      }, markup);
      await expect.poll(() => probe.probeHits().length, { timeout: 10_000 }).toBeGreaterThan(0);
      // Let the control page finish loading everything it was asked to, so what comes later is attributable.
      let seen = -1;
      for (let i = 0; i < 20 && seen !== probe.probeHits().length; i += 1) {
        seen = probe.probeHits().length;
        await plain.waitForTimeout(400);
      }
      const control = probe.probeHits().length;

      // A whole export of documents full of such tags fetches none of them.
      await connect(page);
      await page.click('#btn-run');
      await state(page, 'done');
      await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved/);
      await page.waitForTimeout(500);
      expect(probe.probeHits().length).toBe(control);
      expect(probe.probeHits().filter((r) => r.referer.startsWith(driver.origin()))).toEqual([]); // nothing was requested on behalf of the extension page
      expect(probe.mutating()).toEqual([]);
      const tree = await readTree(page);
      const raw = Object.entries(tree).filter(([path]) => path.endsWith('/body.html'));
      expect(raw.length).toBeGreaterThan(0);
      expect(raw.every(([, html]) => html.includes(`${probe.url}/probe/img.png`))).toBe(true); // the tags really were in what was fetched
    } finally {
      await Promise.all([plain.close(), page.close()]);
      await probe.close();
    }
  });

  it('keeps the token only while "Remember" is ticked, and forgets it the moment it is unticked', async () => {
    const page = await openExporter();
    const stored = () => page.evaluate(async () => ((await chrome.storage.local.get('token')) as { token?: string }).token ?? null);
    expect(await stored()).toBeNull();
    await page.check('#remember');
    await connect(page);
    expect(await stored()).toBe(TOKEN);
    await page.uncheck('#remember');
    await expect.poll(stored, { timeout: 5_000 }).toBeNull();
    await page.check('#remember');
    await expect.poll(stored, { timeout: 5_000 }).toBe(TOKEN);
    await page.uncheck('#remember');
    await expect.poll(stored, { timeout: 5_000 }).toBeNull();
    await page.close();
  });

  it('forgets the token on request: from the page and from both kinds of browser storage', async () => {
    const page = await openExporter();
    const stored = () =>
      page.evaluate(async () => ({
        session: !!((await chrome.storage.session.get('token')) as { token?: string }).token,
        local: !!((await chrome.storage.local.get('token')) as { token?: string }).token,
      }));
    await page.check('#remember');
    await connect(page);
    expect(await stored()).toEqual({ session: true, local: true });

    await page.click('#btn-forget');
    await state(page, 'idle');
    expect(await stored()).toEqual({ session: false, local: false });
    expect(await page.inputValue('#token')).toBe('');
    expect(await page.isChecked('#remember')).toBe(false);
    expect(await page.isDisabled('#btn-run')).toBe(true);
    expect(await page.$$('#roots label')).toHaveLength(0);
    await expect(page.textContent('#roots')).resolves.toContain('Connect first to list your folders.');
    await expect(page.textContent('#connect-status')).resolves.toContain('The token was removed');
    await page.close();
  });

  it.skipIf(!driver.can.folder)('writes to the folder chosen last, even when the folder scanned earlier has the same name', async () => {
    const page = await openExporter();
    const hook = (name: string, arg: string) =>
      page.evaluate(([n, a]) => (window as unknown as { __e2e: Record<string, (x: string) => Promise<unknown>> }).__e2e[n as string]!(a as string), [name, arg] as const);
    await connect(page);
    await page.click('#btn-scan');
    await state(page, 'scanned');

    await hook('switchTarget', `elsewhere-${Date.now()}/e2e-target`);
    await page.click('#btn-run');
    await state(page, 'done');
    expect(Object.keys(await readTree(page))).toContain('Private/Reading Log.md');
    expect(await hook('readTreeAt', 'e2e-target')).toEqual({}); // the folder that was scanned stays untouched
    await page.close();
  });

  it('saves a spreadsheet\'s .xlsx only when asked, and re-exports the note when that choice changes', async () => {
    const page = await openExporter({ from: `${SITE}/${T_READING_SECRET}/Reading-Log` });
    await connect(page);
    await page.uncheck('#opt-xlsx');
    await page.click('#btn-run');
    await state(page, 'done');
    let tree = await readTree(page);
    expect(Object.keys(tree).filter((p) => !p.startsWith('.') && !p.startsWith('_'))).toEqual(['Reading Log.md']);
    expect(tree['Reading Log.md']).not.toContain('.xlsx');

    await page.check('#opt-xlsx');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/1 saved, 0 unchanged/);
    tree = await readTree(page);
    expect(tree['Reading Log.xlsx']).toBe(`<binary ${XLSX_BYTES.length} bytes>`);
    expect(tree['Reading Log.md']).toContain('[Reading Log.xlsx](Reading%20Log.xlsx)');
    await page.close();
  });

  it.skipIf(!driver.can.background)('applies a Quip page picked with the toolbar button mid-export only once the export has finished, without reconnecting', async () => {
    const slow = await startMockQuip({ delayMs: 60 });
    const page = await openExporter({ base: slow.url });
    try {
      await connect(page);
      await expect(page.isVisible('#page-scope')).resolves.toBe(false);
      await page.click('#btn-run');
      await state(page, 'running');
      await driver.toolbarClick(page, `${SITE}/${T_PLAN}/Project-Plan`);
      await expect.poll(() => page.textContent('#log'), { timeout: 10_000 }).toContain('Another Quip page was selected');
      expect(await page.getAttribute('body', 'data-state')).toBe('running');

      // The export finishes undisturbed; only then is the selected page looked up (the page is busy meanwhile), and the scope follows it.
      await state(page, 'connected', 120_000);
      await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved/);
      await expect(page.textContent('#page-label')).resolves.toBe('Document: Project Plan');
      await expect(page.isChecked('#scope-page')).resolves.toBe(true);
      await expect(page.textContent('#connect-status')).resolves.toContain('Connected as Jane Doe');
      expect(await page.isDisabled('#btn-run')).toBe(false);
    } finally {
      await page.close();
      await slow.close();
    }
  });

  it('stops and disconnects when Quip rejects the token part-way through an export', async () => {
    let htmlRequests = 0;
    const flaky = await startMockQuip({ override: (req) => (req.path.endsWith('/html') && ++htmlRequests > 2 ? { status: 401 } : undefined) });
    const page = await openExporter({ base: flaky.url });
    try {
      await connect(page);
      await page.click('#btn-run');
      await state(page, 'idle');
      const status = (await page.textContent('#run-status')) ?? '';
      expect(status).toContain('Stopped: Quip rejected the access token');
      expect(status).not.toContain('Done.');
      expect(await page.isDisabled('#btn-run')).toBe(true);
      await expect(page.getAttribute('#connect-status', 'data-tone')).resolves.toBe('error');
      const report = (await readTree(page))['_Quip export report.md'] ?? '';
      expect(report).toContain('Stopped: Quip rejected the access token');
      expect(report).toMatch(/\d+ not attempted/);
    } finally {
      await page.close();
      await flaky.close();
    }
  });

  it('lets only one exporter tab write at a time', async () => {
    const slow = await startMockQuip({ delayMs: 60 });
    const first = await openExporter({ base: slow.url, target: 'e2e-lock-a' });
    const second = await openExporter({ base: slow.url, target: 'e2e-lock-b' });
    try {
      await connect(first);
      await connect(second);
      await first.click('#btn-run');
      await state(first, 'running');

      await second.click('#btn-run');
      await expect.poll(() => second.textContent('#run-status'), { timeout: 10_000 }).toContain('Another exporter tab is exporting, saving or clearing this export');
      expect(await second.getAttribute('body', 'data-state')).toBe('connected'); // still usable, just not running
      expect(await second.isDisabled('#btn-run')).toBe(false);
      // With a folder each tab has its own, so the second has written nothing; the browser's storage is one for all tabs.
      if (driver.can.folder) expect(Object.keys(await readTree(second)).filter((p) => p.endsWith('.md'))).toEqual([]);

      await state(first, 'done', 120_000);
      await second.click('#btn-run'); // the lock is free again
      await state(second, 'done', 120_000);
      await expect(second.textContent('#run-status')).resolves.toMatch(driver.can.folder ? /Done\. 9 saved/ : /Done\. \d saved, \d unchanged of 9 documents/);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await slow.close();
    }
  });

  it.skipIf(!driver.can.background)('hands the Quip page to an exporter page that is already open, instead of opening another', async () => {
    const page = await openExporter();
    expect(await driver.exporterPages()).toBe(1);
    await driver.toolbarClick(page, `${SITE}/${T_PLAN}/Project-Plan`);
    // The page keeps the address until it has connected, then offers that page as the scope.
    await connect(page);
    await expect(page.textContent('#page-label')).resolves.toBe('Document: Project Plan');
    await expect(page.isChecked('#scope-page')).resolves.toBe(true);
    expect(await driver.exporterPages()).toBe(1);
    await page.close();
  });

  it.skipIf(!driver.can.background)('opens an exporter page that offers the Quip page as the scope when none is open', async () => {
    const quip = `${SITE}/${T_PLAN}/Project-Plan?x=1&y=2`;
    const first = await openExporter();
    // The first page is open, but pretends not to be, to reach the part that opens a new one.
    const opened = await driver.toolbarClick(first, quip, { nobodyListens: true });
    expect(opened).toBeDefined();
    await expect(Promise.resolve((opened as E2EPage).url())).resolves.toBe(`${driver.origin()}/exporter.html?from=${encodeURIComponent(quip)}`);
    await (opened as E2EPage).waitForSelector('body[data-state="idle"]');
    expect(await driver.exporterPages()).toBe(2);
    await (opened as E2EPage).close();
    await first.close();
  });

  it.skipIf(!driver.can.revocableAccess)('asks the browser for access to Quip when it was withdrawn, and says what to do when that is refused', async () => {
    const origin = `${new URL(mock.url).protocol}//${new URL(mock.url).hostname}/*`;
    const before = await openExporter();
    await expect(before.isVisible('#access-notice')).resolves.toBe(false);
    await expect(before.evaluate((pattern: string) => chrome.permissions.remove({ origins: [pattern] }), origin)).resolves.toBe(true);
    await before.close();

    const page = await openExporter();
    await expect(page.isVisible('#access-notice')).resolves.toBe(true);
    await expect(page.textContent('#access-notice')).resolves.toContain('has not given Quipendo access to 127.0.0.1 yet');
    // A click made by a script is not a person's click, so the browser refuses to ask: the page says what to do by hand.
    await page.evaluate(() => (document.getElementById('btn-connect') as HTMLButtonElement).click());
    await expect.poll(() => page.textContent('#connect-status')).toContain('was not allowed to contact 127.0.0.1, so it cannot connect.');
    await expect(page.textContent('#connect-status')).resolves.toMatch(/about:addons|Settings → Extensions/);
    await expect(page.getAttribute('#connect-status', 'data-tone')).resolves.toBe('error');

    // A real click gets the access, and the connection goes ahead.
    await connect(page);
    await expect(page.isVisible('#access-notice')).resolves.toBe(false);
    await expect(page.textContent('#connect-status')).resolves.toContain('Connected as Jane Doe');
    await page.close();
  });

  it('will not clear the stored export, or build a .zip from it, while another tab is exporting into it', async () => {
    const slow = await startMockQuip({ delayMs: 60 });
    const first = await openExporter({ base: slow.url });
    let second: E2EPage | undefined;
    try {
      await first.check('#out-store');
      await connect(first);
      await first.click('#btn-run');
      await state(first, 'running');
      // The second tab opens when something is already stored, so it offers to save and to clear it.
      await expect.poll(async () => Object.keys(await readTree(first)).filter((p) => p.endsWith('.md')).length, { timeout: 30_000 }).toBeGreaterThan(1);
      second = await openExporter({ base: slow.url });
      await second.check('#out-store');
      await expect.poll(() => second?.isVisible('.zip-part'), { timeout: 15_000 }).toBe(true);

      const busy = 'Another exporter tab is exporting, saving or clearing this export';
      await second.click('#btn-clear');
      await second.click('#btn-clear-yes');
      await expect.poll(() => second?.textContent('#run-status'), { timeout: 10_000 }).toContain(busy);
      await second.evaluate(() => (document.querySelector('.zip-part') as HTMLElement).click());
      await expect.poll(() => second?.textContent('#run-status'), { timeout: 10_000 }).toContain(busy);

      // Nothing was lost: the first tab finishes, and everything is there.
      await state(first, 'done', 120_000);
      await expect(first.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved/);
      expect(Object.keys(await readTree(first)).filter((p) => p.endsWith('.md') && !p.startsWith('_Quip') && p !== '_Index.md')).toHaveLength(9);

      // Once nobody is using it, it can be cleared from the other tab.
      await second.click('#btn-clear');
      await second.click('#btn-clear-yes');
      await expect.poll(() => second?.textContent('#store-info'), { timeout: 10_000 }).toBe('Nothing is kept yet.');
    } finally {
      await Promise.all([first.close(), second?.close()]);
      await slow.close();
    }
  });

  it('says why the page you came from cannot be offered, instead of silently showing all folders', async () => {
    const unknown = await openExporter({ from: 'https://acme.quip.com/AbCdEfGhIjKl/Nothing-Here' });
    await connect(unknown);
    await expect(unknown.textContent('#connect-status')).resolves.toContain('The page you came from cannot be offered: this token cannot read it (HTTP 404)');
    expect(await unknown.getAttribute('#connect-status', 'data-tone')).toBe('warn');
    await expect(unknown.isVisible('#page-scope')).resolves.toBe(false);
    await expect(unknown.isChecked('#scope-all')).resolves.toBe(true);
    await unknown.close();

    const notQuip = await openExporter({ from: 'https://example.com/some/page' });
    await connect(notQuip);
    await expect(notQuip.textContent('#connect-status')).resolves.toContain('not a Quip document or folder address');
    await notQuip.close();
  });

  it('can be stopped while connecting', async () => {
    const slow = await startMockQuip({ delayMs: 400 });
    const page = await openExporter({ base: slow.url });
    try {
      await page.click('#btn-connect');
      await state(page, 'connecting');
      await page.click('#btn-stop');
      await state(page, 'idle');
      await expect(page.textContent('#connect-status')).resolves.toContain('Connecting was cancelled');
    } finally {
      await page.close();
      await slow.close();
    }
  });

  it('honours a Stop that arrives before the export has even started', async () => {
    const page = await openExporter();
    await connect(page);
    // Both clicks in one task: Stop lands while the export is still asking for its lock.
    await page.evaluate(() => {
      (document.getElementById('btn-run') as HTMLButtonElement).click();
      (document.getElementById('btn-stop') as HTMLButtonElement).click();
    });
    await state(page, 'stopped');
    await expect(page.textContent('#run-status')).resolves.toContain('Stopped');
    expect(Object.keys(await readTree(page)).filter((p) => p.endsWith('.md'))).toEqual([]);
    await page.close();
  });

  it('does not let a tab that scanned earlier overwrite what another tab has exported since', async () => {
    const first = await openExporter({ target: 'e2e-shared' });
    const second = await openExporter({ target: 'e2e-shared', reuse: '1' });
    await connect(first);
    await first.click('#btn-scan');
    await state(first, 'scanned');

    await connect(second);
    await second.click('#btn-run');
    await state(second, 'done');
    await expect(second.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved, 0 unchanged of 9 documents/);

    // The first tab's scan is now out of date: it plans again, sees what the second tab saved, and finds nothing to redo.
    await first.click('#btn-run');
    await state(first, 'done');
    await expect(first.textContent('#run-status')).resolves.toMatch(/Done\. 0 saved, 9 unchanged of 9 documents/);
    const tree = await readTree(first);
    expect(Object.keys(tree).filter((p) => p.endsWith('.md') && !p.startsWith('_Quip') && p !== '_Index.md')).toHaveLength(9);
    expect(Object.keys(tree).some((p) => /\(\d+\)\.md$/.test(p))).toBe(true); // the two same-titled notes, and nothing duplicated beyond them
    expect(Object.keys(tree).filter((p) => /Notes \(3\)|Project Plan \(2\)/.test(p))).toEqual([]);
    await Promise.all([first.close(), second.close()]);
  });

  it('lets the user untick folders and documents after a scan, and exports only what is left ticked', async () => {
    const page = await openExporter();
    await connect(page);
    await expect(page.isVisible('#tree-panel')).resolves.toBe(false);
    await page.click('#btn-scan');
    await state(page, 'scanned');
    await expect(page.isVisible('#tree-panel')).resolves.toBe(true);
    await expect(page.textContent('#tree-count')).resolves.toBe('9 of 9 documents ticked');
    // Top-level folders are open; what is inside "Projects" is folded away until asked for.
    await expect(shownDocs(page)).resolves.toEqual(['Loose note', 'Notes', 'notes', 'Q3/Q4: plan? <final>', 'Reading Log', 'Shared doc']);

    // The filter opens the folders around a match, and "Untick shown" only touches what the filter shows.
    await page.fill('#tree-filter', 'budget');
    await expect(shownDocs(page)).resolves.toEqual(['Budget']);
    await page.click('#btn-tree-none');
    await expect(page.textContent('#tree-count')).resolves.toBe('8 of 9 documents ticked');
    await page.fill('#tree-filter', '');
    expect(await treeBox(page, 'Budget').isChecked()).toBe(false);
    // The folders above it show that only part of what is in them is ticked.
    expect(await treeBox(page, 'Projects').isIndeterminate()).toBe(true);
    expect(await treeBox(page, 'Private').isIndeterminate()).toBe(true);

    // A folder takes everything in it along.
    await treeBox(page, 'Team Shared').uncheck();
    await expect(page.textContent('#tree-count')).resolves.toBe('7 of 9 documents ticked');
    expect(await treeBox(page, 'Shared doc').isChecked()).toBe(false);

    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 7 saved, 0 unchanged of 7 documents/);
    const tree = await readTree(page);
    expect(Object.keys(tree).filter((p) => /^(Private\/Projects\/Budget|Team Shared\/)/.test(p))).toEqual([]);
    expect(tree['_Index.md']).toContain('- Documents: 7');
    // Leaving things out must not change how what remains is written.
    expect(comparable(tree)).toEqual(await nodeReference({ excludeIds: [T_SHEET, T_SHARED, F_SHARED] }));
    await page.close();
  });

  it('will not start an export while nothing is ticked', async () => {
    const page = await openExporter();
    await connect(page);
    await page.click('#btn-scan');
    await state(page, 'scanned');
    await expect(page.isDisabled('#btn-run')).resolves.toBe(false);
    await page.click('#btn-tree-none');
    await expect(page.textContent('#tree-count')).resolves.toBe('0 of 9 documents ticked');
    await expect(page.isDisabled('#btn-run')).resolves.toBe(true);
    await page.click('#btn-tree-all');
    await expect(page.textContent('#tree-count')).resolves.toBe('9 of 9 documents ticked');
    await expect(page.isDisabled('#btn-run')).resolves.toBe(false);
    await page.close();
  });

  it('keeps what was unticked across a re-scan, and forgets it when what is scanned changes', async () => {
    const page = await openExporter();
    await connect(page);
    await page.click('#btn-scan');
    await state(page, 'scanned');
    await treeBox(page, 'Loose note').uncheck();
    await expect(page.textContent('#tree-count')).resolves.toBe('8 of 9 documents ticked');

    await rescan(page);
    await expect(page.textContent('#tree-count')).resolves.toBe('8 of 9 documents ticked');
    expect(await treeBox(page, 'Loose note').isChecked()).toBe(false);

    // A scan shown for other settings no longer applies, so it goes away, together with what was unticked in it.
    await page.fill('#opt-max', '5');
    await expect(page.isVisible('#tree-panel')).resolves.toBe(false);
    await expect(page.isVisible('#scan-summary')).resolves.toBe(false);
    await page.fill('#opt-max', '');
    await rescan(page);
    await expect(page.textContent('#tree-count')).resolves.toBe('9 of 9 documents ticked');
    await page.close();
  });

  it('previews one document without saving anything or fetching its attachments', async () => {
    const page = await openExporter();
    await expect(page.isDisabled('#btn-preview')).resolves.toBe(true);
    await connect(page);
    await expect(page.isDisabled('#btn-preview')).resolves.toBe(false);
    await expect(page.isVisible('#preview-result')).resolves.toBe(false);

    const before = mock.requests.length;
    await page.fill('#preview-url', `${SITE}/${T_PLAN}/Project-Plan`);
    await page.press('#preview-url', 'Enter');
    await page.waitForSelector('#preview-result:not([hidden])');
    const markdown = await page.inputValue('#preview-text');
    expect(markdown).toContain('# Project Plan');
    expect(markdown).toContain('**Calendar** (2021-10)');
    expect(markdown).toContain('*[image: architecture]*');
    expect(markdown).toContain('spec.pdf *(attachment, saved by a full export)*');
    // Another document is still pointed at by its Quip address, since nothing here is saved for it to point to.
    expect(markdown).toContain(`[Reading Log](${SITE}/${T_READING_SECRET}/Reading-Log#temp:C:abc)`);
    await expect(page.textContent('#preview-status')).resolves.toContain('Project Plan (document). Nothing was saved. Notes: a date that may be a day off');
    // Links to other documents are not worth a note here: every one of them points outside a preview.
    await expect(page.textContent('#preview-status')).resolves.not.toContain('link-outside-export');
    await expect(page.getAttribute('body', 'data-state')).resolves.toBe('connected');
    expect(mock.requests.slice(before).filter((r) => r.path.startsWith('/blob/'))).toEqual([]);
    expect(await readTree(page)).toEqual({});
    // The document is drawn first; its Markdown is behind the other tab, and is what Copy and Download give.
    await expect(page.isVisible('#preview-rendered')).resolves.toBe(true);
    await expect(page.isVisible('#preview-text')).resolves.toBe(false);
    await expect(page.textContent('#preview-rendered h1')).resolves.toBe('Project Plan');

    await page.evaluate(() => {
      const copied: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = copied;
      navigator.clipboard.writeText = (text: string) => {
        copied.push(text);
        return Promise.resolve();
      };
    });
    await page.click('#btn-copy');
    await expect(page.textContent('#preview-status')).resolves.toContain('Copied the Markdown');
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([markdown]);
    // Where the browser refuses, the text is selected for the user to copy by hand, so it is shown.
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    });
    await page.click('#btn-copy');
    await expect(page.textContent('#preview-status')).resolves.toContain('The text is selected');
    await expect(page.isVisible('#preview-text')).resolves.toBe(true);
    await expect(page.getAttribute('#tab-markdown', 'aria-selected')).resolves.toBe('true');

    const saved = await saveDownload(page, '#btn-download-md');
    expect(driver.can.spacesInDownloadNames ? saved.name : saved.name.replace(/_/g, ' ')).toBe('Project Plan.md');
    expect(new TextDecoder().decode(saved.bytes)).toBe(markdown);
    await page.close();
  });

  it('says what is wrong when a preview cannot be made, and leaves the last good one alone', async () => {
    const page = await openExporter();
    await connect(page);
    const status = () => page.textContent('#preview-status');
    const preview = async (address: string) => {
      await page.fill('#preview-url', address);
      await page.click('#btn-preview');
      await page.waitForSelector('body[data-state="connected"]');
    };

    await preview('not an address');
    await expect.poll(status).toContain('Paste the address of a Quip document');
    await preview(`${SITE}/${T_CHAT}/A-chat`);
    await expect.poll(status).toContain('That is a chat, which cannot be exported.');
    await preview(`${SITE}/AbCdEfGhIjKl/Missing`);
    await expect.poll(status).toMatch(/404|not found/i);
    await expect(page.isVisible('#preview-result')).resolves.toBe(false);

    await preview(`${SITE}/${T_SLIDES}/Pitch-deck`);
    await expect.poll(status).toContain('Pitch deck (slides)');
    await expect(page.inputValue('#preview-text')).resolves.toContain('Quip slide decks cannot be converted to Markdown');
    await page.close();
  });

  it('keeps the export in the browser, saves it as a .zip that matches a folder export, and continues from it', async () => {
    const page = await openExporter();
    await connect(page);
    await page.check('#out-store');
    await expect(page.isVisible('#folder-row')).resolves.toBe(false);
    await expect(page.isVisible('#store-panel')).resolves.toBe(true);
    await expect.poll(() => page.textContent('#store-info')).toBe('Nothing is kept yet.');
    await expect(page.isVisible('.zip-part')).resolves.toBe(false);
    await expect(page.isDisabled('#btn-clear')).resolves.toBe(true);
    // What is kept can be read back, so unchanged documents can be skipped, as with a folder.
    await expect(page.isDisabled('#opt-skip')).resolves.toBe(false);

    await page.click('#btn-scan');
    await state(page, 'scanned');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved, 0 unchanged of 9 documents\. The report is _Quip export report\.md in the copy kept in this browser\./);
    await expect(page.textContent('#store-info')).resolves.toMatch(/^[\d,]+ files, [\d.]+ [KM]B, kept in this browser\.$/);
    // The folder the page had been given was not touched.
    if (driver.can.folder) await expect(page.evaluate(() => (window as unknown as { __e2e: { readTreeAt(p: string): Promise<object> } }).__e2e.readTreeAt('e2e-target'))).resolves.toEqual({});
    // The test hook sees the store as it would a folder, and it matches what the Node pipeline writes.
    expect(comparable(await readTree(page))).toEqual(await nodeReference());

    await expect(page.$$('.zip-part')).resolves.toHaveLength(1);
    await expect(page.textContent('.zip-part')).resolves.toBe('Save as .zip');
    const first = await saveDownload(page, '.zip-part');
    expect(first.name).toMatch(/^quipendo-export-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(first.bytes.subarray(0, 4)).toEqual(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
    const zip = readZip(first.bytes);
    for (const [name, entry] of Object.entries(zip)) expect(entry.method === 0 || entry.method === 8, name).toBe(true);
    expect(comparable(zipFiles(zip))).toEqual(withoutDirs(await nodeReference()));
    // Folders with nothing in them are kept, as in a folder export.
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['Archive/', 'Desktop/']));
    expect(new TextDecoder().decode(zip['Private/Projects/Project Plan.md']?.data)).toContain('**Calendar** (2021-10)');
    expect(zip['_attachments/PLANthread1/BLOBok00001.png']?.data.length).toBe(PNG_1X1.length);
    // The state a later run continues from travels in the .zip too.
    expect(Object.keys(zip)).toContain('.quip-md-export/state.json');

    // Starting again continues from what is kept: nothing changed in Quip, so nothing is fetched again.
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 0 saved, 9 unchanged of 9 documents/);

    if (driver.can.folder) {
      // Going back to a folder forgets the scan made for the store and hides the store's panel; the stored copy stays.
      await page.check('#out-folder');
      await expect(page.isVisible('#store-panel')).resolves.toBe(false);
      await expect(page.isVisible('#folder-row')).resolves.toBe(true);
      await expect(page.isVisible('#tree-panel')).resolves.toBe(false);
      await page.check('#out-store');
      await expect.poll(() => page.textContent('#store-info')).toMatch(/^[\d,]+ files, /);
    }
    await page.close();
  });

  it('is still there after the page is closed: it can be saved, continued and cleared in a later visit', async () => {
    const page = await openExporter();
    await connect(page);
    await page.check('#out-store');
    await page.fill('#opt-max', '2');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/2 saved, 0 unchanged of 2 documents/);
    await page.close();

    // A new visit finds the choice and the stored copy as they were left, before anything is connected.
    const again = await openExporter();
    await expect(again.isChecked('#out-store')).resolves.toBe(true);
    await expect(again.textContent('#store-info')).resolves.toMatch(/^[\d,]+ files, .* kept in this browser\.$/);
    await expect(again.isVisible('.zip-part')).resolves.toBe(true);
    const part = await saveDownload(again, '.zip-part');
    const names = Object.keys(readZip(part.bytes));
    expect(names.filter((name) => name.endsWith('.md') && !name.startsWith('_'))).toHaveLength(2);

    await connect(again);
    await again.fill('#opt-max', '');
    await again.click('#btn-run');
    await state(again, 'done');
    // Two were kept; the other seven are new. A note whose links could not be resolved the first time is rendered again.
    await expect(again.textContent('#run-status')).resolves.toMatch(/Done\. 8 saved, 1 unchanged of 9 documents/);

    // Clearing asks first, and keeping it changes nothing.
    await again.click('#btn-clear');
    await expect(again.isVisible('#clear-confirm')).resolves.toBe(true);
    await expect(again.textContent('#clear-question')).resolves.toContain('Quip is not touched, and a .zip you already saved stays where it is');
    await again.click('#btn-clear-no');
    await expect(again.isVisible('#clear-confirm')).resolves.toBe(false);
    await expect(again.textContent('#store-info')).resolves.toMatch(/^[\d,]+ files/);
    await again.click('#btn-clear');
    await again.click('#btn-clear-yes');
    await expect.poll(() => again.textContent('#store-info')).toBe('Nothing is kept yet.');
    await expect(again.isVisible('.zip-part')).resolves.toBe(false);
    expect(await readTree(again)).toEqual({});

    // The next export starts from nothing.
    await again.click('#btn-run');
    await state(again, 'done');
    await expect(again.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved, 0 unchanged of 9 documents/);
    await again.close();
  });

  it('saves a big export as several .zip files that together hold everything', async () => {
    const page = await openExporter({ partEntries: '20' });
    await connect(page);
    await page.check('#out-store');
    await page.click('#btn-run');
    await state(page, 'done');
    const buttons = await page.$$eval('.zip-part', (all) => all.map((b) => b.textContent));
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons[0]).toBe(`Save part 1 of ${buttons.length} (.zip)`);

    const files: Record<string, string> = {};
    for (let i = 0; i < buttons.length; i += 1) {
      const download = await saveDownload(page, '.zip-part', i);
      expect(download.name).toMatch(new RegExp(`^quipendo-export-\\d{4}-\\d{2}-\\d{2}-part-${i + 1}-of-${buttons.length}\\.zip$`));
      const zip = readZip(download.bytes);
      expect(Object.keys(zip).length).toBeLessThanOrEqual(20);
      for (const [name, text] of Object.entries(zipFiles(zip))) {
        expect(files[name], `${name} is in two parts`).toBeUndefined();
        files[name] = text;
      }
    }
    expect(comparable(files)).toEqual(withoutDirs(await nodeReference()));
    await page.close();
  });

  it('says so when the browser has no room, and still lets the user save what fit', async () => {
    const page = await openExporter({ storeMax: '2500' });
    await connect(page);
    await page.check('#out-store');
    await page.uncheck('#opt-raw');
    await page.click('#btn-run');
    await state(page, 'error');
    await expect(page.textContent('#run-status')).resolves.toContain('The browser has no room left to keep the export. Save what is stored as a .zip, then clear it and carry on with the rest.');
    await expect(page.isVisible('.zip-part')).resolves.toBe(true);
    const saved = await saveDownload(page, '.zip-part');
    const notes = Object.keys(readZip(saved.bytes)).filter((name) => name.endsWith('.md'));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThan(9);
    await page.close();
  });

  it('adds a Word copy on request, ties dependent options together, and limits the export to a date', async () => {
    const page = await openExporter({ from: `${SITE}/${T_READING_SECRET}/Reading-Log` });
    await connect(page);
    await page.uncheck('#opt-comments');
    await expect(page.isDisabled('#opt-anchor')).resolves.toBe(true);
    await page.check('#opt-comments');
    await expect(page.isDisabled('#opt-anchor')).resolves.toBe(false);
    await page.uncheck('#opt-raw');
    await expect(page.isDisabled('#opt-edits')).resolves.toBe(true);
    await page.check('#opt-raw');
    await expect(page.isDisabled('#opt-edits')).resolves.toBe(false);

    // Every mock document last changed on 4 February 2021.
    await page.fill('#opt-since', '2021-02-10');
    await page.click('#btn-scan');
    await state(page, 'scanned');
    await expect(page.textContent('#scan-summary')).resolves.toContain('1 documents last changed before 2021-02-10 are left out.');
    await expect(page.isVisible('#tree-panel')).resolves.toBe(false);

    await page.fill('#opt-since', '2021-02-01');
    await page.check('#opt-docx');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 1 saved, 0 unchanged of 1 documents/);
    const tree = await readTree(page);
    expect(tree['Reading Log.docx']).toBe(`<binary ${DOCX_BYTES.length} bytes>`);
    expect(tree['Reading Log.md']).toContain('Word copy as Quip exports it (without comments): [Reading Log.docx](Reading%20Log.docx)');
    await page.close();
  });

  it('asks for a new token when Quip rejects it during a preview', async () => {
    const flaky = await startMockQuip({ override: (req) => (req.path.endsWith('/html') ? { status: 401 } : undefined) });
    const page = await openExporter({ base: flaky.url });
    try {
      await connect(page);
      await page.fill('#preview-url', `${SITE}/${T_PLAN}/Project-Plan`);
      await page.click('#btn-preview');
      await state(page, 'idle');
      await expect(page.textContent('#preview-status')).resolves.toContain('Quip rejected the access token');
      await expect(page.getAttribute('#connect-status', 'data-tone')).resolves.toBe('error');
      await expect(page.isDisabled('#btn-preview')).resolves.toBe(true);
    } finally {
      await page.close();
      await flaky.close();
    }
  });

  it('keeps what was exported when Quip rejects the token part-way, and says so', async () => {
    let htmlRequests = 0;
    const flaky = await startMockQuip({ override: (req) => (req.path.endsWith('/html') && ++htmlRequests > 2 ? { status: 401 } : undefined) });
    const page = await openExporter({ base: flaky.url });
    try {
      await connect(page);
      await page.check('#out-store');
      await page.click('#btn-run');
      await state(page, 'idle');
      await expect(page.textContent('#run-status')).resolves.toContain('Stopped: Quip rejected the access token. Create a new one at quip.com/dev/token and connect again. What was exported so far is kept in this browser. The report lists what was not exported.');
      await expect(page.isVisible('.zip-part')).resolves.toBe(true);
      const zip = readZip((await saveDownload(page, '.zip-part')).bytes);
      expect(Object.keys(zip).filter((name) => name.endsWith('.md') && !name.startsWith('_')).length).toBeGreaterThan(0);
      expect(new TextDecoder().decode(zip['_Quip export report.md']?.data)).toContain('Stopped: Quip rejected the access token');
    } finally {
      await page.close();
      await flaky.close();
    }
  });

  describe('the demo account', () => {
    const SAMPLE = resolve(__dirname, '../../examples/sample-output');

    it('opens with no token, says it is made up, previews every kind of embedded content, and contacts nobody', async () => {
      const before = mock.requests.length;
      const page = await openExporter();
      const typed = await page.inputValue('#token');
      await expect(page.isVisible('#demo-banner')).resolves.toBe(false);
      await page.click('#btn-demo');
      await state(page, 'connected');
      await expect(page.isVisible('#demo-banner')).resolves.toBe(true);
      await expect(page.textContent('#demo-banner')).resolves.toContain('made-up account');
      await expect(page.textContent('#connect-status')).resolves.toContain('demo account');
      await expect(page.textContent('#btn-forget')).resolves.toBe('Leave the demo');
      // Whatever was typed in the token box is left alone, and the demo's own token is never put there.
      await expect(page.inputValue('#token')).resolves.toBe(typed);

      // The document with the most kinds of content is offered first, and the others can be chosen from the browser's own list.
      await expect(page.inputValue('#preview-url')).resolves.toBe('https://acme.quip.com/RELAUNCHpl1/Website-Relaunch-Project-Plan');
      await expect(page.$$eval('#demo-docs option', (options) => options.length)).resolves.toBe(13);
      await page.click('#btn-preview');
      await page.waitForSelector('#preview-result:not([hidden])');
      const markdown = await page.inputValue('#preview-text');
      for (const label of ['**Process bar**', '**Calendar**', '**Kanban board**', '**Project tracker**']) expect(markdown, label).toContain(label);
      await expect(page.textContent('#preview-status')).resolves.toContain('Nothing was saved');

      await page.click('#btn-forget');
      await state(page, 'idle');
      await expect(page.isVisible('#demo-banner')).resolves.toBe(false);
      await expect(page.textContent('#btn-forget')).resolves.toBe('Forget token');
      await expect(page.inputValue('#preview-url')).resolves.toBe('');
      await expect(page.isDisabled('#btn-scan')).resolves.toBe(true);
      expect(mock.requests.length).toBe(before);
      await page.close();
    });

    it('draws the preview as a formatted document with its Markdown a tab away, and nothing drawn can load or run', async () => {
      const before = mock.requests.length;
      const page = await openExporter();
      await page.click('#btn-demo');
      await state(page, 'connected');
      // The demo's own button has done its job once the demo is open.
      await expect(page.isVisible('#demo-row')).resolves.toBe(false);
      await page.click('#btn-preview');
      await page.waitForSelector('#preview-result:not([hidden])');

      // The drawn document comes first; the Markdown text is behind the other tab.
      await expect(page.getAttribute('#tab-rendered', 'aria-selected')).resolves.toBe('true');
      await expect(page.isVisible('#preview-rendered')).resolves.toBe(true);
      await expect(page.isVisible('#preview-text')).resolves.toBe(false);
      await expect(page.textContent('#preview-rendered h1')).resolves.toBe('Website Relaunch: Project Plan');
      const drawn = (await page.textContent('#preview-rendered')) ?? '';
      for (const text of ['Process bar', 'Calendar', 'Kanban board', 'Project tracker', 'Comments and conversation', 'Comments on highlighted text']) expect(drawn, text).toContain(text);
      // Tables, checklists and comments are drawn as such, not left as Markdown symbols.
      await expect(page.$$eval('#preview-rendered table', (found) => found.length)).resolves.toBe(2);
      await expect(page.$$eval('#preview-rendered input[type="checkbox"]', (found) => found.length)).resolves.toBe(5);
      await expect(page.$$eval('#preview-rendered .md-comment', (found) => found.length)).resolves.toBeGreaterThanOrEqual(3);
      expect(drawn).not.toContain('| ---');
      expect(drawn).not.toContain('**');
      // Nothing drawn can navigate, fetch or run anything: no links, images, frames, forms, styles, scripts or event handlers.
      const live = await page.$$eval(
        '#preview-rendered *',
        (all) =>
          all.filter(
            (e) =>
              ['A', 'IMG', 'IFRAME', 'FORM', 'SCRIPT', 'STYLE', 'LINK', 'OBJECT', 'EMBED', 'SVG', 'VIDEO', 'AUDIO'].includes(e.tagName.toUpperCase()) ||
              e.getAttributeNames().some((name) => name === 'href' || name === 'src' || name === 'style' || name.startsWith('on')),
          ).length,
      );
      expect(live).toBe(0);

      await page.click('#tab-markdown');
      await expect(page.getAttribute('#tab-markdown', 'aria-selected')).resolves.toBe('true');
      await expect(page.isVisible('#preview-text')).resolves.toBe(true);
      await expect(page.isVisible('#preview-rendered')).resolves.toBe(false);
      await expect(page.inputValue('#preview-text')).resolves.toContain('**Calendar**');
      // The arrow keys move between the two tabs, as in any tab list.
      await page.evaluate(() => {
        document.getElementById('tab-markdown')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      });
      await expect(page.getAttribute('#tab-rendered', 'aria-selected')).resolves.toBe('true');
      await expect(page.isVisible('#preview-rendered')).resolves.toBe(true);

      // The next preview starts on the drawn document again, and leaving the demo empties both views.
      await page.click('#tab-markdown');
      await page.fill('#preview-url', 'https://acme.quip.com/LAUNCHlist1/Launch-Checklist');
      await page.click('#btn-preview');
      await expect.poll(() => page.textContent('#preview-status')).toContain('Launch Checklist (document)');
      await expect(page.getAttribute('#tab-rendered', 'aria-selected')).resolves.toBe('true');
      await expect(page.textContent('#preview-rendered h1')).resolves.toBe('Launch Checklist');
      await page.click('#btn-forget');
      await state(page, 'idle');
      await expect(page.isVisible('#preview-result')).resolves.toBe(false);
      await expect(page.$$eval('#preview-rendered *', (all) => all.length)).resolves.toBe(0);
      await expect(page.inputValue('#preview-text')).resolves.toBe('');
      await expect(page.isVisible('#demo-row')).resolves.toBe(true);
      expect(mock.requests.length).toBe(before);
      await page.close();
    });

    it('exports exactly the sample output in the repository, in the browser, and contacts nobody', async () => {
      const before = mock.requests.length;
      const page = await openExporter();
      await page.click('#btn-demo');
      await state(page, 'connected');
      await page.check('#out-store');
      await page.click('#btn-scan');
      await state(page, 'scanned');
      await expect(page.textContent('#scan-summary')).resolves.toContain('13 documents in 9 folders');
      await page.click('#btn-run');
      await state(page, 'done');
      await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 13 saved, 0 unchanged of 13 documents/);

      const zip = readZip((await saveDownload(page, '.zip-part')).bytes);
      const raw = (tree: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(tree).filter(([name]) => !name.startsWith('.quip-raw/')));
      const sample = withoutDirs(comparable(await nodeTree(SAMPLE)));
      // The sample was made without the raw archive and with a frozen clock; what is left must be identical, file for file.
      const made = raw(comparable(zipFiles(zip)));
      expect(Object.keys(made).sort()).toEqual(Object.keys(sample).sort());
      for (const [name, text] of Object.entries(sample)) expect(made[name], name).toBe(text);
      expect(new TextDecoder().decode(zip['Private/Projects/Budget 2026.xlsx']?.data)).toContain('<f>SUM(B2:B6)</f>');
      expect(mock.requests.length).toBe(before);
      await page.close();
    });
  });

  it('never sent anything but reads, whatever the page was asked to do', () => {
    expect(mock.requests.length).toBeGreaterThan(100);
    expect(mock.mutating()).toEqual([]);
  });
});
