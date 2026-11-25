/// <reference types="chrome" />

declare const __TARGET__: 'chrome' | 'firefox' | 'safari';

export type BrowserTarget = 'chrome' | 'firefox' | 'safari';

/** The browser this build was made for (see scripts/build.mjs). Anything that is not built, such as a unit test, sees Chrome. */
export const TARGET: BrowserTarget = typeof __TARGET__ === 'undefined' ? 'chrome' : __TARGET__;

type Ext = typeof chrome;

const resolve = (): Ext => {
  const found = (globalThis as unknown as { browser?: Ext; chrome?: Ext }).browser ?? (globalThis as unknown as { chrome?: Ext }).chrome;
  if (!found) throw new Error('This page is not running as a browser extension.');
  return found;
};

/**
 * The extension API. Firefox and Safari call it `browser`, Chrome calls it `chrome`; with Manifest V3 all three hand back
 * promises when a function is called without a callback, which is how this extension uses them. Looked up on each use,
 * so a page (or a test) that gets its API late still finds it.
 */
export const ext: Ext = new Proxy({} as Ext, { get: (_target, key) => Reflect.get(resolve(), key) });

const memory = new Map<string, unknown>();

/**
 * Storage that is erased when the browser closes, for the token. A browser without it (Safari before 16.4) gets the
 * page's own memory, which is erased sooner still.
 */
export const sessionStore = {
  async get(key: string): Promise<unknown> {
    if (!ext.storage?.session) return memory.get(key);
    return ((await ext.storage.session.get(key)) as Record<string, unknown>)[key];
  },
  async set(key: string, value: unknown): Promise<void> {
    if (!ext.storage?.session) memory.set(key, value);
    else await ext.storage.session.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    memory.delete(key);
    if (ext.storage?.session) await ext.storage.session.remove(key);
  },
};

/** The permission a web address needs. Match patterns have no port, so neither does this. */
export function hostPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * Whether the extension may contact this address. Chrome grants it at install unless the user limited the site access;
 * Safari asks the user, site by site. Undefined when the browser cannot say.
 */
export async function hasHostAccess(baseUrl: string): Promise<boolean | undefined> {
  if (!ext.permissions?.contains) return undefined;
  try {
    return await ext.permissions.contains({ origins: [hostPattern(baseUrl)] });
  } catch {
    return undefined;
  }
}

/** Asks the user for that access. Browsers only allow it straight from a click, so call it before anything else is awaited. */
export async function requestHostAccess(baseUrl: string): Promise<boolean> {
  if (!ext.permissions?.request) return true;
  try {
    return await ext.permissions.request({ origins: [hostPattern(baseUrl)] });
  } catch {
    return false;
  }
}
