import type { MockQuip } from '../../mock/quipMock';

/**
 * The part of a browser page the scenarios use. Playwright's `Page` already has all of it; the other drivers
 * (Firefox through Selenium, Safari through AppleScript) get it from `EvalPage`.
 */
export interface E2EPage {
  goto(url: string): Promise<unknown>;
  url(): string | Promise<string>;
  title(): Promise<string>;
  close(): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: 'Enter'): Promise<void>;
  check(selector: string): Promise<void>;
  uncheck(selector: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  isDisabled(selector: string): Promise<boolean>;
  isChecked(selector: string): Promise<boolean>;
  textContent(selector: string): Promise<string | null>;
  inputValue(selector: string): Promise<string>;
  getAttribute(selector: string, name: string): Promise<string | null>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: () => unknown, arg?: undefined, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  $$(selector: string): Promise<unknown[]>;
  $$eval<R>(selector: string, fn: (elements: Element[]) => R): Promise<R>;
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
}

export interface Download {
  name: string;
  bytes: Uint8Array;
}

/** What a browser can do; a scenario that needs more is left out for it, with the reason in the report. */
export interface Capabilities {
  /** The user can pick a folder to write into (the File System Access API). */
  folder: boolean;
  /** The browser blocks the extension's own write requests (declarativeNetRequest with request methods). */
  guard: boolean;
  /** The extension's background script runs, so the toolbar button can be pressed. */
  background: boolean;
  /** A read that goes to an address the extension has no permission for still reaches the server. */
  unpermittedReads: boolean;
  /** A test can withdraw the extension's access to a site and let the page ask for it again. */
  revocableAccess: boolean;
  /** A saved file's suggested name keeps its spaces. (Playwright's WebKit on Linux turns each into an underscore.) */
  spacesInDownloadNames: boolean;
}

export type BrowserName = 'chromium' | 'firefox' | 'webkit' | 'safari';

export interface E2EDriver {
  readonly name: BrowserName;
  readonly can: Capabilities;
  /** Starts the browser with the extension (or, for WebKit, the page and a stand-in for the extension API). */
  start(mock: MockQuip): Promise<void>;
  /** Opens the exporter page with the test parameters (`e2e`, `base`, `token`, ...) and waits until it is idle. */
  open(params?: Record<string, string>): Promise<E2EPage>;
  /** Opens a page that is not the extension's: an ordinary web page. */
  openPlain(url: string): Promise<E2EPage>;
  /** Clicks a button that saves a file and returns what the browser was handed. */
  saveDownload(page: E2EPage, selector: string, index?: number): Promise<Download>;
  /**
   * Presses the toolbar button on a Quip page (or none), as the given extension page. With `nobodyListens` the button
   * behaves as if no exporter page were open, and the page it opens is returned.
   */
  toolbarClick(from: E2EPage, quipUrl?: string, options?: { nobodyListens?: boolean }): Promise<E2EPage | undefined>;
  /** Makes the page prefer a dark or a light colour scheme, where the browser lets a test do that. */
  setColorScheme?(page: E2EPage, scheme: 'dark' | 'light'): Promise<void>;
  /** How many exporter pages are open now. */
  exporterPages(): Promise<number>;
  /** Closes pages a failed test left behind and wipes what pages keep, so the next test starts from the defaults. */
  reset(): Promise<void>;
  /** The beginning of the address of the extension's own pages, such as `chrome-extension://abc`. */
  origin(): string;
  stop(): Promise<void>;
}
