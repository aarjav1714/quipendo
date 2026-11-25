import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExportOptions } from '../../src/core';
import { createSession } from '../../src/core/session';
import { DOCX_BYTES, F_ARCH, F_DESK, F_PRIV, F_SHARED, F_TRASH, ME, PNG_1X1, SITE, T_CHAT, T_PLAN, T_READING_SECRET, T_SHARED, T_SHEET, T_SLIDES, TOKEN, XLSX_BYTES } from '../mock/fixture';
import { probeHtml, startMockQuip, type MockQuip } from '../mock/quipMock';
import { NodeFsSink, parseHtml } from '../helpers/env';
import { readZip, type ZipEntry } from '../helpers/unzip';

const EXTENSION = resolve(__dirname, '../../dist-e2e');

let mock: MockQuip;
let context: BrowserContext;
let profile: string;
let extensionId: string;

beforeAll(async () => {
  mock = await startMockQuip();
  profile = await mkdtemp(join(tmpdir(), 'quip-e2e-profile-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

// A failed assertion must not leave an exporter page running: it would keep the export lock and write into the next test's folder.
afterEach(async () => {
  for (const page of context.pages()) if (page.url().startsWith('chrome-extension://')) await page.close().catch(() => undefined);
  // The page keeps its settings in the profile (such as ".zip" as the output), and a test may have closed its page already.
  // The next test must start from the defaults, so a page of its own wipes them.
  const janitor = await context.newPage();
  try {
    await janitor.goto(`chrome-extension://${extensionId}/exporter.html?${new URLSearchParams({ e2e: '1', base: mock.url, target: 'e2e-janitor' })}`);
    await janitor.waitForSelector('body[data-state="idle"]');
    await janitor.evaluate(() => chrome.storage.local.clear());
  } finally {
    await janitor.close().catch(() => undefined);
  }
});

afterAll(async () => {
  await context?.close();
  await mock?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function openExporter(extra: Record<string, string> = {}): Promise<Page> {
  const page = await context.newPage();
  const query = new URLSearchParams({ e2e: '1', base: mock.url, token: TOKEN, ...extra });
  await page.goto(`chrome-extension://${extensionId}/exporter.html?${query}`);
  await page.waitForSelector('body[data-state="idle"]');
  return page;
}

const state = (page: Page, value: string, timeout = 60_000) => page.waitForSelector(`body[data-state="${value}"]`, { timeout });

async function connect(page: Page): Promise<void> {
  await page.click('#btn-connect');
  await state(page, 'connected');
}

async function readTree(page: Page): Promise<Record<string, string>> {
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

async function saveDownload(page: Page, button: string): Promise<{ name: string; bytes: Uint8Array }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click(button)]);
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile((await download.path()) as string)) };
}

/** The checkbox of a folder or document in the tree. */
const treeBox = (page: Page, name: string) => page.locator('#tree label').filter({ has: page.getByText(name, { exact: true }) }).locator('input');

/** The documents in the tree that can be seen: not filtered out and not inside a folded folder. */
const shownDocs = (page: Page): Promise<string[]> =>
  page.$$eval('#tree li[data-kind="doc"]', (items) => items.filter((li) => !li.closest('[hidden]')).map((li) => li.querySelector('label span')?.textContent ?? ''));

/** Starts a scan and waits for it to finish, even when the page was already showing the result of an earlier one. */
async function rescan(page: Page): Promise<void> {
  const before = mock.requests.length;
  await page.click('#btn-scan');
  await expect.poll(() => mock.requests.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await state(page, 'scanned');
}

describe('the extension in a real Chromium', () => {
  it('loads with a service worker and the production-safe manifest', async () => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    const page = await openExporter();
    expect(await page.title()).toBe('Quipendo');
    await expect(page.evaluate(() => (document.querySelector('header img') as HTMLImageElement | null)?.naturalWidth ?? 0)).resolves.toBeGreaterThan(0);
    await expect(page.evaluate(() => chrome.runtime.getManifest().icons)).resolves.toMatchObject({ '16': 'icons/icon-16.png', '128': 'icons/icon-128.png' });
    await expect(page.textContent('#guard-status')).resolves.toContain('read-only guard: on');
    await expect(page.textContent('#target-name')).resolves.toBe('e2e-target');
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

  it('blocks every kind of write, even to an address the extension has no permission for, while reads still work', async () => {
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
    expect(seen).toContain('GET /guard/get');
    expect(seen).not.toContain('POST /guard/post');
    expect(mock.mutating()).toEqual([]);
    await page.close();
  });

  it('never fetches the sub-resources that Quip HTML points at', async () => {
    const probe = await startMockQuip({ probe: true });
    const plain = await context.newPage();
    const page = await openExporter({ base: probe.url });
    try {
      // Parsing is inert in this browser...
      await plain.goto(`${probe.url}/control.html`);
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
      expect(probe.probeHits().filter((r) => r.referer.startsWith('chrome-extension://'))).toEqual([]); // nothing was requested on behalf of the extension page
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

  it('writes to the folder chosen last, even when the folder scanned earlier has the same name', async () => {
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

  it('applies a Quip page picked mid-export only once the export has finished, without reconnecting', async () => {
    const slow = await startMockQuip({ delayMs: 60 });
    const page = await openExporter({ base: slow.url });
    try {
      await connect(page);
      await expect(page.isVisible('#page-scope')).resolves.toBe(false);
      await page.click('#btn-run');
      await state(page, 'running');
      const worker = context.serviceWorkers()[0] as NonNullable<ReturnType<BrowserContext['serviceWorkers']>[number]>;
      await worker.evaluate((url) => chrome.runtime.sendMessage({ type: 'quip-source-url', url }), `${SITE}/${T_PLAN}/Project-Plan`);
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
      await expect.poll(() => second.textContent('#run-status'), { timeout: 10_000 }).toContain('Another exporter tab is already exporting');
      expect(await second.getAttribute('body', 'data-state')).toBe('connected'); // still usable, just not running
      expect(await second.isDisabled('#btn-run')).toBe(false);
      expect(Object.keys(await readTree(second)).filter((p) => p.endsWith('.md'))).toEqual([]);

      await state(first, 'done', 120_000);
      await second.click('#btn-run'); // the lock is free again
      await state(second, 'done', 120_000);
      await expect(second.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved/);
    } finally {
      await Promise.all([first.close(), second.close()]);
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
    expect(await treeBox(page, 'Projects').evaluate((box: HTMLInputElement) => box.indeterminate)).toBe(true);
    expect(await treeBox(page, 'Private').evaluate((box: HTMLInputElement) => box.indeterminate)).toBe(true);

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
    // Where the browser refuses, the text is selected for the user to copy by hand.
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    });
    await page.click('#btn-copy');
    await expect(page.textContent('#preview-status')).resolves.toContain('The text is selected');

    const saved = await saveDownload(page, '#btn-download-md');
    expect(saved.name).toBe('Project Plan.md');
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

  it('saves everything as one .zip that matches a folder export, and starts from scratch every time', async () => {
    const page = await openExporter();
    await connect(page);
    await page.check('#out-zip');
    await expect(page.isVisible('#folder-row')).resolves.toBe(false);
    // A .zip has no earlier run to compare with, so there is nothing to skip.
    await expect(page.isDisabled('#opt-skip')).resolves.toBe(true);
    await expect(page.isVisible('#btn-zip')).resolves.toBe(false);

    await page.click('#btn-scan');
    await state(page, 'scanned');
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved, 0 unchanged of 9 documents\. The report is _Quip export report\.md in the \.zip\./);
    await expect(page.isVisible('#btn-zip')).resolves.toBe(true);
    // The chosen folder was not touched.
    expect(await readTree(page)).toEqual({});

    const first = await saveDownload(page, '#btn-zip');
    expect(first.name).toMatch(/^quipendo-export-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(first.bytes.subarray(0, 4)).toEqual(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
    const zip = readZip(first.bytes);
    for (const [name, entry] of Object.entries(zip)) expect(entry.method === 0 || entry.method === 8, name).toBe(true);
    expect(comparable(zipFiles(zip))).toEqual(withoutDirs(await nodeReference()));
    // Folders with nothing in them are kept, as in a folder export.
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['Archive/', 'Desktop/']));
    expect(new TextDecoder().decode(zip['Private/Projects/Project Plan.md']?.data)).toContain('**Calendar** (2021-10)');
    expect(zip['_attachments/PLANthread1/BLOBok00001.png']?.data.length).toBe(PNG_1X1.length);

    // Starting again makes a new .zip with everything in it, because nothing from the first one is remembered.
    await page.click('#btn-run');
    await state(page, 'done');
    await expect(page.textContent('#run-status')).resolves.toMatch(/Done\. 9 saved, 0 unchanged of 9 documents/);
    const second = await saveDownload(page, '#btn-zip');
    expect(Object.keys(readZip(second.bytes)).sort()).toEqual(Object.keys(zip).sort());

    // Going back to a folder forgets the scan made for the .zip and hides the download.
    await page.check('#out-folder');
    await expect(page.isVisible('#btn-zip')).resolves.toBe(false);
    await expect(page.isVisible('#folder-row')).resolves.toBe(true);
    await expect(page.isDisabled('#opt-skip')).resolves.toBe(false);
    await expect(page.isVisible('#tree-panel')).resolves.toBe(false);
    await page.close();
  });

  it('says so when a .zip would be too big, and still lets the user save what fit', async () => {
    const page = await openExporter({ zipMax: '2500' });
    await connect(page);
    await page.check('#out-zip');
    await page.uncheck('#opt-raw');
    await page.click('#btn-run');
    await state(page, 'error');
    await expect(page.textContent('#run-status')).resolves.toContain('too much to build as one .zip file in the browser. Save to a folder instead. Save the .zip to keep what was exported.');
    await expect(page.isVisible('#btn-zip')).resolves.toBe(true);
    const saved = await saveDownload(page, '#btn-zip');
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

  it('keeps what a .zip had collected when Quip rejects the token part-way, and says to save it', async () => {
    let htmlRequests = 0;
    const flaky = await startMockQuip({ override: (req) => (req.path.endsWith('/html') && ++htmlRequests > 2 ? { status: 401 } : undefined) });
    const page = await openExporter({ base: flaky.url });
    try {
      await connect(page);
      await page.check('#out-zip');
      await page.click('#btn-run');
      await state(page, 'idle');
      await expect(page.textContent('#run-status')).resolves.toContain('Stopped: Quip rejected the access token. Create a new one at quip.com/dev/token and connect again. Save the .zip to keep what was exported.');
      await expect(page.isVisible('#btn-zip')).resolves.toBe(true);
      const zip = readZip((await saveDownload(page, '#btn-zip')).bytes);
      expect(Object.keys(zip).filter((name) => name.endsWith('.md') && !name.startsWith('_')).length).toBeGreaterThan(0);
      expect(new TextDecoder().decode(zip['_Quip export report.md']?.data)).toContain('Stopped: Quip rejected the access token');
    } finally {
      await page.close();
      await flaky.close();
    }
  });

  it('never sent anything but reads, whatever the page was asked to do', () => {
    expect(mock.requests.length).toBeGreaterThan(100);
    expect(mock.mutating()).toEqual([]);
  });
});
