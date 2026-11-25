import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { TOKEN } from '../../mock/fixture';
import type { MockQuip } from '../../mock/quipMock';
import type { Capabilities, Download, E2EDriver, E2EPage } from './types';

const EXTENSION = resolve(__dirname, '../../../dist-e2e');

export const wipePageStorage = async (): Promise<void> => {
  await chrome.storage.local.clear();
  // What a page kept of an export is wiped, too, or the next test would start from it.
  for (const { name } of await indexedDB.databases()) {
    if (name) await new Promise((done) => Object.assign(indexedDB.deleteDatabase(name), { onsuccess: done, onerror: done, onblocked: done }));
  }
};

/** Chromium with the extension loaded from `dist-e2e`, driven by Playwright. */
export class ChromiumDriver implements E2EDriver {
  readonly name = 'chromium' as const;
  readonly can: Capabilities = { folder: true, guard: true, background: true, unpermittedReads: true, revocableAccess: false };
  private context!: BrowserContext;
  private profile = '';
  private extensionId = '';
  private mock!: MockQuip;
  private readonly opened = new Set<Page>();

  async start(mock: MockQuip): Promise<void> {
    this.mock = mock;
    this.profile = await mkdtemp(join(tmpdir(), 'quip-e2e-profile-'));
    this.context = await chromium.launchPersistentContext(this.profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const worker = this.context.serviceWorkers()[0] ?? (await this.context.waitForEvent('serviceworker'));
    this.extensionId = new URL(worker.url()).host;
    if (!/^[a-p]{32}$/.test(this.extensionId)) throw new Error(`Unexpected extension id ${this.extensionId}`);
  }

  origin(): string {
    return `chrome-extension://${this.extensionId}`;
  }

  async open(params: Record<string, string> = {}): Promise<E2EPage> {
    const page = await this.context.newPage();
    this.opened.add(page);
    const query = new URLSearchParams({ e2e: '1', base: this.mock.url, token: TOKEN, ...params });
    await page.goto(`${this.origin()}/exporter.html?${query}`);
    await page.waitForSelector('body[data-state="idle"]');
    return page as unknown as E2EPage;
  }

  async openPlain(url: string): Promise<E2EPage> {
    const page = await this.context.newPage();
    this.opened.add(page);
    await page.goto(url);
    return page as unknown as E2EPage;
  }

  async saveDownload(page: E2EPage, selector: string, index = 0): Promise<Download> {
    const p = page as unknown as Page;
    const [download] = await Promise.all([p.waitForEvent('download'), p.locator(selector).nth(index).click()]);
    return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile((await download.path()) as string)) };
  }

  async toolbarClick(from: E2EPage, quipUrl?: string, options: { nobodyListens?: boolean } = {}): Promise<E2EPage | undefined> {
    const opening = options.nobodyListens ? this.context.waitForEvent('page', { timeout: 10_000 }) : undefined;
    await (from as unknown as Page).evaluate((message) => chrome.runtime.sendMessage(message), { type: 'e2e-toolbar', url: quipUrl, nobodyListens: options.nobodyListens });
    if (!opening) return undefined;
    const page = await opening;
    this.opened.add(page);
    return page as unknown as E2EPage;
  }

  async exporterPages(): Promise<number> {
    return this.context.pages().filter((page) => page.url().startsWith(`${this.origin()}/exporter.html`)).length;
  }

  async setColorScheme(page: E2EPage, scheme: 'dark' | 'light'): Promise<void> {
    await (page as unknown as Page).emulateMedia({ colorScheme: scheme });
  }

  async reset(): Promise<void> {
    // A failed assertion must not leave an exporter page running: it would keep the export lock and write into the next test's folder.
    for (const page of this.context.pages()) if (page.url().startsWith('chrome-extension://') || this.opened.has(page)) await page.close().catch(() => undefined);
    this.opened.clear();
    // The page keeps its settings in the profile (such as the output), and a test may have closed its page already.
    // The next test must start from the defaults, so a page of its own wipes them.
    const janitor = await this.open({ target: 'e2e-janitor' });
    try {
      await janitor.evaluate(wipePageStorage);
    } finally {
      await janitor.close().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    await this.context?.close();
    if (this.profile) await rm(this.profile, { recursive: true, force: true });
  }
}
