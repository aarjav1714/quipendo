/**
 * A stand-in for the extension API, injected into the exporter page when it is opened as an ordinary web page. WebKit
 * (as Playwright ships it) cannot load extensions, so this runs the page's own code in WebKit's engine and leaves the
 * browser-extension parts (background script, toolbar button, site access, request blocking) to the real Safari.
 *
 * It must be self-contained: it is serialised and run in the page before the page's own scripts.
 */
export function installExtensionShim(manifest: unknown): void {
  if (!location.pathname.endsWith('/exporter.html')) return;

  const area = (storage: Storage, key: string) => {
    const read = (): Record<string, unknown> => JSON.parse(storage.getItem(key) ?? '{}') as Record<string, unknown>;
    const write = (value: Record<string, unknown>): void => storage.setItem(key, JSON.stringify(value));
    return {
      async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
        const all = read();
        if (keys === undefined || keys === null) return all;
        const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out: Record<string, unknown> = {};
        for (const name of names) if (name in all) out[name] = all[name];
        else if (name in defaults) out[name] = defaults[name];
        return out;
      },
      async set(items: Record<string, unknown>): Promise<void> {
        write({ ...read(), ...items });
      },
      async remove(keys: string | string[]): Promise<void> {
        const all = read();
        for (const name of ([] as string[]).concat(keys)) delete all[name];
        write(all);
      },
      async clear(): Promise<void> {
        write({});
      },
    };
  };

  const listeners: Array<(message: unknown, sender: unknown, respond: (reply?: unknown) => void) => unknown> = [];
  (window as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'e2e-shim',
      getURL: (path: string) => `${location.origin}/${path}`,
      getManifest: () => manifest,
      onMessage: { addListener: (listener: (typeof listeners)[number]) => void listeners.push(listener) },
      // No background script here, so nobody ever answers.
      sendMessage: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    },
    storage: { local: area(localStorage, '__shim_local'), session: area(sessionStorage, '__shim_session') },
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) },
    tabs: { getCurrent: () => Promise.resolve({ id: 1, windowId: 1 }), update: () => Promise.resolve({}), create: ({ url }: { url: string }) => Promise.resolve(window.open(url)) },
    windows: { update: () => Promise.resolve({}) },
    // No declarativeNetRequest: the Safari build never uses it, and a page cannot block its own requests.
  };
}
