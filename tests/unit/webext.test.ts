import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Loads the module afresh, as a page would, with the given extension API objects present. */
async function load(globals: Record<string, unknown>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  return import('../../src/ui/webext');
}

describe('the extension API alias', () => {
  it('uses `browser` where there is one (Firefox, Safari) and `chrome` otherwise', async () => {
    const chromeOnly = { id: 'c' };
    const browserApi = { id: 'b' };
    expect((await load({ chrome: chromeOnly })).ext.runtime).toBeUndefined();
    expect((await load({ chrome: { runtime: chromeOnly } })).ext.runtime).toBe(chromeOnly);
    expect((await load({ chrome: { runtime: chromeOnly }, browser: { runtime: browserApi } })).ext.runtime).toBe(browserApi);
  });

  it('is found even when the page gets its API after the module loaded, and says so plainly when there is none', async () => {
    const { ext } = await load({});
    expect(() => ext.runtime).toThrow(/not running as a browser extension/);
    vi.stubGlobal('chrome', { runtime: { id: 'late' } });
    expect(ext.runtime.id).toBe('late');
  });
});

describe('session storage for the token', () => {
  it('uses the browser\'s session storage where it exists', async () => {
    const stored: Record<string, unknown> = {};
    const { sessionStore } = await load({
      chrome: {
        storage: {
          session: {
            get: async (key: string) => ({ [key]: stored[key] }),
            set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
            remove: async (key: string) => void delete stored[key],
          },
        },
      },
    });
    await sessionStore.set('token', 'abc');
    expect(stored).toEqual({ token: 'abc' });
    expect(await sessionStore.get('token')).toBe('abc');
    await sessionStore.remove('token');
    expect(stored).toEqual({});
    expect(await sessionStore.get('token')).toBeUndefined();
  });

  it('keeps the token in memory where a browser has none (Safari before 16.4), and forgets it on request', async () => {
    const { sessionStore } = await load({ chrome: { storage: { local: {} } } });
    expect(await sessionStore.get('token')).toBeUndefined();
    await sessionStore.set('token', 'abc');
    expect(await sessionStore.get('token')).toBe('abc');
    await sessionStore.remove('token');
    expect(await sessionStore.get('token')).toBeUndefined();
  });
});

describe('access to Quip', () => {
  it('asks for the host without a port, which match patterns do not have', async () => {
    const { hostPattern } = await load({ chrome: {} });
    expect(hostPattern('https://platform.quip.com')).toBe('https://platform.quip.com/*');
    expect(hostPattern('http://127.0.0.1:58766')).toBe('http://127.0.0.1/*');
  });

  it('reports what the browser says, and says nothing where it cannot tell', async () => {
    const calls: unknown[] = [];
    const granted = await load({ chrome: { permissions: { contains: async (arg: unknown) => (calls.push(arg), true), request: async () => false } } });
    expect(await granted.hasHostAccess('https://platform.quip.com')).toBe(true);
    expect(calls).toEqual([{ origins: ['https://platform.quip.com/*'] }]);
    expect(await granted.requestHostAccess('https://platform.quip.com')).toBe(false);

    const unable = await load({ chrome: {} });
    expect(await unable.hasHostAccess('https://platform.quip.com')).toBeUndefined();
    expect(await unable.requestHostAccess('https://platform.quip.com')).toBe(true); // nothing to ask for
    const broken = await load({ chrome: { permissions: { contains: async () => Promise.reject(new Error('no')), request: async () => Promise.reject(new Error('no')) } } });
    expect(await broken.hasHostAccess('https://platform.quip.com')).toBeUndefined();
    expect(await broken.requestHostAccess('https://platform.quip.com')).toBe(false);
  });
});
