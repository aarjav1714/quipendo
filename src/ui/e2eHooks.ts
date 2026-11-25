/**
 * Test-only helpers. Imported solely behind `if (__E2E__)`, so the production bundle never contains this file.
 * It deliberately sends a write request to prove the browser-level guard blocks it.
 */
import type { StoreSink } from './storeSink';

/** An empty folder in the origin-private file system, standing in for the folder picker in tests. */
export async function freshTestTarget(name = 'e2e-target', reuse = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  // Reusing the folder lets a second page share a target with the first, as two tabs on one real folder would.
  if (!reuse) await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  return root.getDirectoryHandle(name, { create: true });
}

export interface TestHooksSource {
  /** The folder, when the export goes to a folder. */
  target(): FileSystemDirectoryHandle | undefined;
  /** The browser's own storage, when the export is kept there. */
  store(): StoreSink | undefined;
  useTarget(handle: FileSystemDirectoryHandle): Promise<void>;
}

export function installTestHooks({ target: getTarget, store: getStore, useTarget }: TestHooksSource): void {
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, out: Record<string, string>): Promise<void> => {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const path = `${prefix}${name}`;
      if (handle.kind === 'directory') {
        out[`${path}/`] = '';
        await walk(handle as FileSystemDirectoryHandle, `${path}/`, out);
      } else {
        const file = await (handle as FileSystemFileHandle).getFile();
        out[path] = /\.(md|json|html|txt)$/.test(name) ? await file.text() : `<binary ${file.size} bytes>`;
      }
    }
  };
  const outcome = (p: Promise<Response>): Promise<string> =>
    p.then(
      (r) => `reached:${r.status}`,
      (e: unknown) => `blocked:${e instanceof Error ? e.name : 'error'}`,
    );
  const nested = async (path: string): Promise<FileSystemDirectoryHandle> => {
    let dir = await navigator.storage.getDirectory();
    for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part, { create: true });
    return dir;
  };
  (window as unknown as { __e2e: unknown }).__e2e = {
    /** What the export made, as a folder would hold it: file name to text (or the size of a binary), and every folder as `name/`. */
    readTree: async () => {
      const out: Record<string, string> = {};
      const store = getStore();
      if (store) {
        const parents = (path: string): string[] => path.split('/').slice(0, -1).map((_, i, all) => `${all.slice(0, i + 1).join('/')}/`);
        for (const meta of await store.list()) {
          const data = await store.read(meta.path);
          out[meta.path] = /\.(md|json|html|txt)$/.test(meta.path) ? (typeof data === 'string' ? data : ((await data?.text()) ?? '')) : `<binary ${meta.size} bytes>`;
          for (const dir of parents(meta.path)) out[dir] = '';
        }
        for (const dir of await store.dirs()) for (const d of parents(`${dir}/x`)) out[d] = '';
        return out;
      }
      const target = getTarget();
      if (target) await walk(target, '', out);
      return out;
    },
    /** Lists a folder of the origin-private file system, for checking that nothing was written there. */
    readTreeAt: async (path: string) => {
      const out: Record<string, string> = {};
      await walk(await nested(path), '', out);
      return out;
    },
    /** Behaves as if the user had picked another folder; the name can repeat that of the current one. */
    switchTarget: async (path: string) => useTarget(await nested(path)),
    tryMutation: (url: string, method = 'POST') => outcome(fetch(url, { method, body: '{}' })),
    tryRead: (url: string) => outcome(fetch(url, { method: 'GET' })),
  };
}
