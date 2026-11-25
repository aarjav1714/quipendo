import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { TOKEN } from '../../mock/fixture';
import type { MockQuip } from '../../mock/quipMock';
import { installExtensionShim } from './shim';
import type { Capabilities, Download, E2EDriver, E2EPage } from './types';

/** The Safari test build, served as ordinary web pages. */
const EXTENSION = resolve(__dirname, '../../../dist-e2e-safari');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/**
 * WebKit as Playwright builds it, running the Safari build of the page from a local web server, with the extension API
 * stood in for (shim.ts). It checks the page's own behaviour in Safari's engine (IndexedDB, Blob, CompressionStream, DOMParser,
 * downloads), anywhere, with no setup. What only a real extension has (the toolbar button, site access, the guard) is for the real Safari.
 */
export class WebKitDriver implements E2EDriver {
  readonly name = 'webkit' as const;
  readonly can: Capabilities = { folder: false, guard: false, background: false, unpermittedReads: false, revocableAccess: false };
  private browser!: Browser;
  private context!: BrowserContext;
  private server!: Server;
  private serverOrigin = '';
  private mock!: MockQuip;
  private manifest: unknown;

  constructor() {
    // The page and the mock server are different origins here, with no host permission to lift that.
    process.env.E2E_MOCK_CORS = '1';
  }

  async start(mock: MockQuip): Promise<void> {
    this.mock = mock;
    this.manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'));
    this.server = createServer((req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      readFile(join(EXTENSION, path)).then(
        (body) => {
          res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
          res.end(body);
        },
        () => {
          res.writeHead(404);
          res.end();
        },
      );
    });
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
    this.serverOrigin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.browser = await webkit.launch();
    await this.newContext();
  }

  private async newContext(): Promise<void> {
    this.context = await this.browser.newContext({ acceptDownloads: true });
    await this.context.addInitScript(installExtensionShim, this.manifest);
  }

  origin(): string {
    return this.serverOrigin;
  }

  async open(params: Record<string, string> = {}): Promise<E2EPage> {
    const page = await this.context.newPage();
    const query = new URLSearchParams({ e2e: '1', base: this.mock.url, token: TOKEN, ...params });
    await page.goto(`${this.serverOrigin}/exporter.html?${query}`);
    await page.waitForSelector('body[data-state="idle"]');
    return page as unknown as E2EPage;
  }

  async openPlain(url: string): Promise<E2EPage> {
    const page = await this.context.newPage();
    await page.goto(url);
    return page as unknown as E2EPage;
  }

  async saveDownload(page: E2EPage, selector: string, index = 0): Promise<Download> {
    const p = page as unknown as Page;
    const [download] = await Promise.all([p.waitForEvent('download'), p.locator(selector).nth(index).click()]);
    const path = (await download.path()) as string;
    return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(path)) };
  }

  async toolbarClick(): Promise<E2EPage | undefined> {
    throw new Error('A web page has no toolbar button.');
  }

  async exporterPages(): Promise<number> {
    return this.context.pages().filter((page) => page.url().includes('/exporter.html')).length;
  }

  async setColorScheme(page: E2EPage, scheme: 'dark' | 'light'): Promise<void> {
    await (page as unknown as Page).emulateMedia({ colorScheme: scheme });
  }

  async reset(): Promise<void> {
    // A new browser context starts with no storage at all, which is what wiping everything by hand tries to reach.
    await this.context?.close().catch(() => undefined);
    await this.newContext();
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
  }
}
