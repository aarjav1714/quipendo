import { execFile } from 'node:child_process';
import { TOKEN } from '../../mock/fixture';
import type { MockQuip } from '../../mock/quipMock';
import { wipePageStorage } from './chromium';
import { EvalPage } from './evalPage';
import type { Capabilities, Download, E2EDriver, E2EPage } from './types';

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Runs an AppleScript, one at a time (Safari answers a script at a time), with arguments that need no quoting. */
let turn: Promise<unknown> = Promise.resolve();
function osascript(lines: string[], ...args: string[]): Promise<string> {
  const run = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const script = ['on run argv', ...lines, 'end run'].flatMap((line) => ['-e', line]);
      execFile('osascript', [...script, ...args], { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LANG: 'en_US.UTF-8' } }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout.replace(/\n$/, ''));
      });
    });
  const result = turn.then(run, run);
  turn = result.catch(() => undefined);
  return result;
}

/** AppleScript that finds the tab whose address is argv item 2 (exactly, when item 3 is "exact"), and does `action` with it as `t`. */
const withTab = (action: string): string[] => [
  'set needle to item 2 of argv',
  'set exact to (item 3 of argv) is "exact"',
  'tell application "Safari"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'set u to ""',
  'try',
  'set u to URL of t',
  'end try',
  'if (exact and u is needle) or ((not exact) and u contains needle) then',
  ...action.split('\n'),
  'end if',
  'end repeat',
  'end repeat',
  'end tell',
  'error "no tab with that address"',
];

interface Offered {
  name: string;
  base64: string;
}

/**
 * The real Safari on this Mac, with the extension loaded as a temporary extension and driven through AppleScript.
 *
 * Safari refuses to open an extension's page from outside (the address does not even load), so pages are opened by an
 * extension page that is already open, the one the toolbar button opens. Setting Safari up is done once by hand
 * (docs/safari.md): the extension loaded and enabled, "Allow JavaScript from Apple Events" ticked, and the toolbar
 * button pressed once. Safari makes the extension's address up, so it is read off that tab; `E2E_SAFARI_ORIGIN` names it
 * when the tab is not open.
 */
export class SafariDriver implements E2EDriver {
  readonly name = 'safari' as const;
  readonly can: Capabilities = { folder: false, guard: false, background: true, unpermittedReads: true, revocableAccess: false, spacesInDownloadNames: true };
  private extensionOrigin = '';
  private mock!: MockQuip;
  private anchor!: SafariPage;
  private counter = 0;
  private readonly pages = new Set<SafariPage>();

  async start(mock: MockQuip): Promise<void> {
    this.mock = mock;
    this.extensionOrigin = process.env.E2E_SAFARI_ORIGIN ?? (await this.findOrigin());
    this.anchor = new SafariPage(`${this.extensionOrigin}/exporter.html`, true);
    if ((await this.anchor.evaluate(() => document.title).catch(() => '')) !== 'Quipendo') {
      throw new Error(`No Quipendo page is open at ${this.extensionOrigin}/exporter.html. Press the extension's toolbar button in Safari. See docs/safari.md.`);
    }
    await this.ensureAccess();
  }

  /** Safari grants nothing at install, and only asks when a click on the page requests access: wait for a person to do that once. */
  private async ensureAccess(): Promise<void> {
    const host = new URL(this.mock.url).hostname;
    const has = (): Promise<boolean> => this.anchor.evaluate((pattern: string) => chrome.permissions.contains({ origins: [pattern] }), `http://${host}/*`);
    if (await has()) return;
    const page = await this.open();
    process.stderr.write(`\nQuipendo has no access to ${host} in Safari yet. In the Safari tab that just opened, press Connect and allow it (waiting two minutes).\n`);
    const deadline = Date.now() + 120_000;
    while (!(await has())) {
      if (Date.now() > deadline) throw new Error(`Safari did not give Quipendo access to ${host}. Press Connect in the test page and allow it, then run the tests again.`);
      await sleep(1000);
    }
    await page.close();
  }

  /** The address of the extension's pages, read off an open tab of one of them. */
  private async findOrigin(): Promise<string> {
    const found = (await this.tabs()).map(([url]) => /^safari-web-extension:\/\/[0-9A-Fa-f-]+/.exec(url)?.[0]).find(Boolean);
    if (!found) throw new Error('Open the Quipendo exporter page in Safari once (press its toolbar button), so the test can learn its address, or set E2E_SAFARI_ORIGIN. See docs/safari.md.');
    return found;
  }

  origin(): string {
    return this.extensionOrigin;
  }

  async open(params: Record<string, string> = {}): Promise<E2EPage> {
    this.counter += 1;
    // Several pages can be open with the same settings, and Safari may spell an address differently from how it was asked for.
    const query = new URLSearchParams({ e2e: '1', base: this.mock.url, token: TOKEN, ...params, n: `${Date.now()}-${this.counter}` });
    const url = `${this.origin()}/exporter.html?${query}`;
    await this.anchor.evaluate((address: string) => chrome.tabs.create({ url: address }), url);
    const page = new SafariPage(`n=${query.get('n')}`);
    this.pages.add(page);
    await page.waitForSelector('body[data-state="idle"]', { timeout: 60_000 });
    return page;
  }

  async openPlain(url: string): Promise<E2EPage> {
    await osascript(['tell application "Safari" to make new document with properties {URL:(item 1 of argv)}'], url);
    const page = new SafariPage(url);
    this.pages.add(page);
    return page;
  }

  async saveDownload(page: E2EPage, selector: string, index = 0): Promise<Download> {
    type Hooks = { __e2e: { takeDownloads(): Promise<Offered[]> } };
    // What the page hands to Safari to save. Safari then asks where to put it, in a dialog a script cannot press without
    // Accessibility access and an unlocked screen, so what lands on disk is not checked here (docs/safari.md).
    await page.evaluate(() => (window as unknown as Hooks).__e2e.takeDownloads());
    await page.evaluate(({ sel, at }: { sel: string; at: number }) => (document.querySelectorAll(sel)[at] as HTMLElement).click(), { sel: selector, at: index });
    const deadline = Date.now() + 30_000;
    let offered: Offered | undefined;
    while (!offered) {
      offered = (await page.evaluate(() => (window as unknown as Hooks).__e2e.takeDownloads()))[0];
      if (!offered && Date.now() > deadline) throw new Error(`${selector} did not offer a file to save.`);
      if (!offered) await sleep(100);
    }
    return { name: offered.name, bytes: new Uint8Array(Buffer.from(offered.base64, 'base64')) };
  }

  /** Every tab of every window, as [address, window id]. */
  private async tabs(): Promise<Array<[string, number]>> {
    const listing = await osascript(['tell application "Safari"', 'set found to ""', 'repeat with w in windows', 'repeat with t in tabs of w', 'try', 'set found to found & (URL of t) & (ASCII character 9) & (id of w) & linefeed', 'end try', 'end repeat', 'end repeat', 'return found', 'end tell']);
    return listing
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [url, id] = line.split('\t') as [string, string];
        return [url, Number(id)];
      });
  }

  async toolbarClick(from: E2EPage, quipUrl?: string, options: { nobodyListens?: boolean } = {}): Promise<E2EPage | undefined> {
    const before = new Set((await this.tabs()).map(([url]) => url));
    await from.evaluate((message) => chrome.runtime.sendMessage(message), { type: 'e2e-toolbar', url: quipUrl, nobodyListens: options.nobodyListens });
    if (!options.nobodyListens) return undefined;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const fresh = (await this.tabs()).find(([url]) => !before.has(url) && url.startsWith(`${this.origin()}/exporter.html?from=`));
      if (fresh) {
        const page = new SafariPage(fresh[0]);
        this.pages.add(page);
        return page;
      }
      if (Date.now() > deadline) throw new Error('No new tab appeared.');
      await sleep(100);
    }
  }

  async exporterPages(): Promise<number> {
    // Not counting the page the test itself uses to open the others.
    return (await this.tabs()).filter(([url]) => url.startsWith(`${this.origin()}/exporter.html`) && url !== `${this.origin()}/exporter.html`).length;
  }

  async reset(): Promise<void> {
    // Pages this driver opened, and the tabs the extension opened by itself; the page that opens the others stays.
    for (const page of [...this.pages]) await page.close().catch(() => undefined);
    this.pages.clear();
    for (const [url] of await this.tabs()) {
      if (url.startsWith(`${this.origin()}/exporter.html?`)) await new SafariPage(url).close().catch(() => undefined);
    }
    const janitor = await this.open({ target: 'e2e-janitor' });
    try {
      await janitor.evaluate(wipePageStorage);
    } finally {
      await janitor.close();
    }
  }

  async stop(): Promise<void> {
    for (const page of [...this.pages]) await page.close().catch(() => undefined);
  }
}

/** A tab found by its address, or by part of it, which is how a tab is told from others when Safari has no handle for one. */
class SafariPage extends EvalPage {
  constructor(
    private readonly address: string,
    private readonly exact = false,
  ) {
    super();
  }

  private mode(): string {
    return this.exact ? 'exact' : 'contains';
  }

  protected async exec(expression: string): Promise<string> {
    try {
      return await osascript(withTab('return do JavaScript (item 1 of argv) in t'), expression, this.address, this.mode());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Safari that will not run scripts, or a script that is wrong, is a failure; a page still loading (or a tab that has only
      // just opened) cannot run anything yet, and that is not.
      if (/Allow JavaScript from Apple Events|returned an exception|syntax/i.test(message)) throw error;
      return null as unknown as string;
    }
  }

  async goto(url: string): Promise<void> {
    await osascript(withTab('set URL of t to (item 4 of argv)\nreturn "done"'), '', this.address, this.mode(), url);
  }

  async url(): Promise<string> {
    return osascript(withTab('return URL of t'), '', this.address, this.mode());
  }

  async close(): Promise<void> {
    // Safari leaves the selected tab open when a script closes it, so another tab is selected first; a window with only this tab is closed whole.
    const close = [
      'if (count of tabs of w) is 1 then',
      'close w',
      'else',
      'set pick to 1',
      'if (index of t) is 1 then set pick to 2',
      'set current tab of w to tab pick of w',
      'close t',
      'end if',
      'return "done"',
    ];
    await osascript(withTab(close.join('\n')), '', this.address, this.mode());
  }
}
