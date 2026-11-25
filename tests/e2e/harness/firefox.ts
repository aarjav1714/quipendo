import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Builder, By, type WebDriver } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox';
import { TOKEN } from '../../mock/fixture';
import type { MockQuip } from '../../mock/quipMock';
import { EvalPage } from './evalPage';
import type { Capabilities, Download, E2EDriver, E2EPage } from './types';
import { wipePageStorage } from './chromium';

const EXTENSION = resolve(__dirname, '../../..', process.env.E2E_PROD === '1' ? 'dist-firefox' : 'dist-e2e-firefox');
const FIREFOX_APP = '/Applications/Firefox.app/Contents/MacOS/firefox';

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** What the page offers for download, as the page's own test hook reports it. */
interface Offered {
  name: string;
  base64: string;
}

/** Stock Firefox with the extension installed as a temporary add-on, driven by geckodriver. */
export class FirefoxDriver implements E2EDriver {
  readonly name = 'firefox' as const;
  readonly can: Capabilities = { folder: false, guard: true, background: true, unpermittedReads: true, revocableAccess: true };
  private driver!: firefox.Driver;
  private mock!: MockQuip;
  private uuid = randomUUID();
  private downloads = '';
  private home = '';
  private current = '';
  private readonly pages = new Set<FirefoxPage>();

  /** Runs `work` with the given tab in front. One script runs at a time, so tabs can be driven turn by turn. */
  private queue: Promise<unknown> = Promise.resolve();
  inTab<R>(handle: string, work: (driver: WebDriver) => Promise<R>): Promise<R> {
    const run = async (): Promise<R> => {
      if (this.current !== handle) {
        await this.driver.switchTo().window(handle);
        this.current = handle;
      }
      return work(this.driver);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async start(mock: MockQuip): Promise<void> {
    this.mock = mock;
    // Lets a script running in the browser's own context open an extension page, which WebDriver itself is not allowed to navigate to.
    process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1';
    const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')) as { browser_specific_settings: { gecko: { id: string } } };
    const geckoId = manifest.browser_specific_settings.gecko.id;
    this.downloads = await mkdtemp(join(tmpdir(), 'quip-e2e-downloads-'));

    const options = new firefox.Options();
    if (existsSync(process.env.FIREFOX_BIN ?? FIREFOX_APP)) options.setBinary(process.env.FIREFOX_BIN ?? FIREFOX_APP);
    if (process.env.E2E_HEADED !== '1') options.addArguments('-headless');
    // A fixed address for the extension's pages, instead of a random one the test could only learn by asking.
    options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [geckoId]: this.uuid }));
    options.setPreference('xpinstall.signatures.required', false);
    // Nobody is there to press Allow: a permission the page asks for from a real click is granted at once.
    options.setPreference('extensions.webextOptionalPermissionPrompts', false);
    options.setPreference('browser.download.folderList', 2);
    options.setPreference('browser.download.dir', this.downloads);
    options.setPreference('browser.download.useDownloadDir', true);
    options.setPreference('browser.download.alwaysOpenPanel', false);
    options.setPreference('browser.helperApps.neverAsk.saveToDisk', 'application/zip,application/x-zip-compressed,application/octet-stream,text/markdown,text/plain');
    this.driver = (await new Builder().forBrowser('firefox').setFirefoxOptions(options).build()) as unknown as firefox.Driver;
    await this.driver.installAddon(EXTENSION, true);
    this.home = await this.driver.getWindowHandle();
    this.current = this.home;
  }

  origin(): string {
    return `moz-extension://${this.uuid}`;
  }

  /** Opens an address in a new tab: from the browser's own context, so that an extension page is allowed. */
  private async newTab(url: string): Promise<FirefoxPage> {
    const before = new Set(await this.driver.getAllWindowHandles());
    await this.queue;
    await this.driver.setContext(firefox.Context.CHROME);
    try {
      await this.driver.executeScript(
        `const tab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); gBrowser.selectedTab = tab;`,
        url,
      );
    } finally {
      await this.driver.setContext(firefox.Context.CONTENT);
    }
    return this.adopt(before);
  }

  /** The tab that appeared since `before`, wrapped as a page. */
  private async adopt(before: Set<string>, timeout = 15_000): Promise<FirefoxPage> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const fresh = (await this.driver.getAllWindowHandles()).find((handle) => !before.has(handle));
      if (fresh) {
        const page = new FirefoxPage(this, fresh);
        this.pages.add(page);
        return page;
      }
      if (Date.now() > deadline) throw new Error('No new tab appeared.');
      await sleep(50);
    }
  }

  forget(page: FirefoxPage): void {
    this.pages.delete(page);
  }

  async afterClose(): Promise<void> {
    await this.queue;
    await this.driver.switchTo().window(this.home);
    this.current = this.home;
  }

  async open(params: Record<string, string> = {}): Promise<E2EPage> {
    const query = new URLSearchParams({ e2e: '1', base: this.mock.url, token: TOKEN, ...params });
    const page = await this.newTab(`${this.origin()}/exporter.html?${query}`);
    await page.waitForSelector('body[data-state="idle"]', { timeout: 30_000 });
    return page;
  }

  openPlain(url: string): Promise<E2EPage> {
    return this.newTab(url);
  }

  async saveDownload(page: E2EPage, selector: string, index = 0): Promise<Download> {
    type Hooks = { __e2e: { takeDownloads(): Promise<Offered[]> } };
    await page.evaluate(() => (window as unknown as Hooks).__e2e.takeDownloads());
    const known = new Set(await readdir(this.downloads));
    await page.evaluate(({ sel, at }: { sel: string; at: number }) => (document.querySelectorAll(sel)[at] as HTMLElement).click(), { sel: selector, at: index });
    const deadline = Date.now() + 30_000;
    let offered: Offered | undefined;
    while (!offered) {
      offered = (await page.evaluate(() => (window as unknown as Hooks).__e2e.takeDownloads()))[0];
      if (!offered && Date.now() > deadline) throw new Error(`${selector} did not offer a file to save.`);
      if (!offered) await sleep(50);
    }
    const bytes = new Uint8Array(Buffer.from(offered.base64, 'base64'));
    // The browser itself must have saved it, too: a file of the same size appears in its downloads folder.
    for (;;) {
      const fresh = (await readdir(this.downloads)).filter((file) => !known.has(file) && !file.endsWith('.part'));
      const saved = await Promise.all(fresh.map(async (file) => (await stat(join(this.downloads, file))).size));
      if (saved.includes(bytes.length)) break;
      if (Date.now() > deadline) throw new Error(`Firefox did not save ${offered.name} (${bytes.length} bytes); its downloads folder holds ${fresh.join(', ') || 'nothing new'}.`);
      await sleep(100);
    }
    return { name: offered.name, bytes };
  }

  async toolbarClick(from: E2EPage, quipUrl?: string, options: { nobodyListens?: boolean } = {}): Promise<E2EPage | undefined> {
    const before = new Set(await this.driver.getAllWindowHandles());
    await from.evaluate((message) => chrome.runtime.sendMessage(message), { type: 'e2e-toolbar', url: quipUrl, nobodyListens: options.nobodyListens });
    return options.nobodyListens ? this.adopt(before) : undefined;
  }

  async exporterPages(): Promise<number> {
    await this.queue;
    let count = 0;
    for (const handle of await this.driver.getAllWindowHandles()) {
      await this.driver.switchTo().window(handle);
      this.current = handle;
      if ((await this.driver.getCurrentUrl()).startsWith(`${this.origin()}/exporter.html`)) count += 1;
    }
    await this.driver.switchTo().window(this.home);
    this.current = this.home;
    return count;
  }

  async reset(): Promise<void> {
    await this.queue;
    for (const handle of await this.driver.getAllWindowHandles()) {
      if (handle === this.home) continue;
      await this.driver.switchTo().window(handle);
      await this.driver.close().catch(() => undefined);
    }
    this.pages.clear();
    await this.driver.switchTo().window(this.home);
    this.current = this.home;
    const janitor = await this.open({ target: 'e2e-janitor' });
    try {
      await janitor.evaluate(wipePageStorage);
      // A test that withdrew the extension's access to the mock server must not leave the next one without it.
      const pattern = `${new URL(this.mock.url).protocol}//${new URL(this.mock.url).hostname}/*`;
      if (!(await janitor.evaluate((origin: string) => chrome.permissions.contains({ origins: [origin] }), pattern))) {
        await janitor.fill('#token', TOKEN);
        await janitor.click('#btn-connect');
        await janitor.waitForSelector('body[data-state="connected"]');
      }
    } finally {
      await janitor.close();
    }
  }

  async stop(): Promise<void> {
    await this.driver?.quit().catch(() => undefined);
    if (this.downloads) await rm(this.downloads, { recursive: true, force: true });
  }
}

class FirefoxPage extends EvalPage {
  constructor(
    private readonly owner: FirefoxDriver,
    private readonly handle: string,
  ) {
    super();
  }

  protected exec(expression: string): Promise<string> {
    return this.owner.inTab(this.handle, (driver) => driver.executeScript<string>(`return ${expression}`));
  }

  /** A real click, as a person makes it: browsers only let a page ask for a permission from one of those. */
  override async click(selector: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const clicked = await this.owner.inTab(this.handle, async (driver) => {
        const [element] = await driver.findElements(By.css(selector));
        if (!element || !(await element.isDisplayed()) || !(await element.isEnabled())) return false;
        try {
          await element.click();
          return true;
        } catch {
          return false; // covered or moving for a moment; look again
        }
      });
      if (clicked) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${selector} to be clickable`);
      await sleep(40);
    }
  }

  async goto(url: string): Promise<void> {
    await this.owner.inTab(this.handle, (driver) => driver.get(url));
  }

  url(): Promise<string> {
    return this.owner.inTab(this.handle, (driver) => driver.getCurrentUrl());
  }

  async close(): Promise<void> {
    await this.owner.inTab(this.handle, (driver) => driver.close());
    this.owner.forget(this);
    await this.owner.afterClose();
  }
}
