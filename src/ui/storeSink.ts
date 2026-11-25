import { SinkFullError, splitSafePath, type Sink } from '../core/sink';
import { crc32, partitionZip, zipBlob, zipItems, type ZipBudget, type ZipItem } from '../core/zip';

/** What is known about a stored file without reading it. */
export interface StoredMeta {
  path: string;
  /** Size in bytes. */
  size: number;
  crc: number;
  /** Whether it was written as bytes (a picture, a spreadsheet) rather than as text. */
  binary: boolean;
}

export type StoredData = string | Blob;

export interface StoreStats {
  files: number;
  bytes: number;
}

/** One .zip file of a saved export. */
export interface ZipPart {
  /** 1-based. */
  index: number;
  count: number;
  /** Files and folders in this part. */
  entries: number;
  /** Size of the files in this part before compression. */
  bytes: number;
  build(): Promise<Blob>;
}

/** Where a store keeps things. Browsers keep them in IndexedDB; a browser that will not is given memory. */
export interface StoreBackend {
  put(meta: StoredMeta, data: StoredData): Promise<void>;
  getMeta(path: string): Promise<StoredMeta | undefined>;
  getData(path: string): Promise<StoredData | undefined>;
  /** A file's description and content as they were at one moment: another tab may rewrite the file between two separate reads. */
  getBoth(path: string): Promise<{ meta: StoredMeta; data: StoredData } | undefined>;
  allMeta(): Promise<StoredMeta[]>;
  putDir(path: string): Promise<void>;
  allDirs(): Promise<string[]>;
  clear(): Promise<void>;
  close(): void;
}

/** The browser says it is out of room with a QuotaExceededError, on a request or on the transaction that failed with it. */
const isQuota = (err: unknown): boolean => {
  const e = err as { name?: unknown; code?: unknown } | null;
  return e !== null && typeof e === 'object' && (e.name === 'QuotaExceededError' || e.code === 22);
};

const FULL = 'The browser has no room left to keep the export. Save what is stored as a .zip, then clear it and carry on with the rest.';

// ---- backends ------------------------------------------------------------

export class MemoryBackend implements StoreBackend {
  private readonly metas = new Map<string, StoredMeta>();
  private readonly datas = new Map<string, StoredData>();
  private readonly dirs = new Set<string>();

  put(meta: StoredMeta, data: StoredData): Promise<void> {
    this.metas.set(meta.path, meta);
    this.datas.set(meta.path, data);
    return Promise.resolve();
  }
  getMeta(path: string): Promise<StoredMeta | undefined> {
    return Promise.resolve(this.metas.get(path));
  }
  getData(path: string): Promise<StoredData | undefined> {
    return Promise.resolve(this.datas.get(path));
  }
  getBoth(path: string): Promise<{ meta: StoredMeta; data: StoredData } | undefined> {
    const meta = this.metas.get(path);
    const data = this.datas.get(path);
    return Promise.resolve(meta !== undefined && data !== undefined ? { meta, data } : undefined);
  }
  allMeta(): Promise<StoredMeta[]> {
    return Promise.resolve([...this.metas.values()]);
  }
  putDir(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }
  allDirs(): Promise<string[]> {
    return Promise.resolve([...this.dirs]);
  }
  clear(): Promise<void> {
    this.metas.clear();
    this.datas.clear();
    this.dirs.clear();
    return Promise.resolve();
  }
  close(): void {}
}

const META = 'meta';
const DATA = 'data';
const DIRS = 'dirs';

/** Content read back as it is used elsewhere: a Blob, or text. Bytes kept as plain data (see `keepsBlobs`) become a Blob again. */
const asData = (value: StoredData | ArrayBuffer | undefined): StoredData | undefined => (value instanceof ArrayBuffer ? new Blob([value]) : value);

const asPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * Settles when the transaction has committed or aborted. A request that fails raises its error on the request, and the
 * transaction's own `error` stays null until it aborts (and in some browsers after that, too), so the request's error is
 * kept to say what went wrong; the abort that always follows is what rejects.
 */
export const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    let cause: unknown;
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => {
      cause ??= (event.target as IDBRequest | null)?.error ?? undefined;
    };
    tx.onabort = () => reject(cause ?? tx.error ?? new DOMException("The browser stopped saving to the extension's storage", 'AbortError'));
  });

/** A key no file path can have, for finding out whether a Blob can be kept. */
const PROBE_KEY = -1;

/**
 * Whether this browser can keep a Blob in IndexedDB. A private or temporary session of WebKit cannot (the write fails
 * without saying why), and a browser that cannot gets the same bytes as plain data instead.
 */
async function keepsBlobs(db: IDBDatabase): Promise<boolean> {
  try {
    const tx = db.transaction(DATA, 'readwrite');
    tx.objectStore(DATA).put(new Blob([new Uint8Array([1])]), PROBE_KEY);
    tx.objectStore(DATA).delete(PROBE_KEY);
    await transactionDone(tx);
    return true;
  } catch {
    return false;
  }
}

/** Keeps the files in IndexedDB: on disk, surviving a closed tab, and not limited by memory. */
export class IdbBackend implements StoreBackend {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly blobs: boolean,
  ) {}

  static async open(name: string): Promise<IdbBackend> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(META, { keyPath: 'path' });
        db.createObjectStore(DATA);
        db.createObjectStore(DIRS, { keyPath: 'path' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab deleting or upgrading the database must not be held up by this one.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('The stored export is in use by an older version of this page. Close the other Quipendo tabs and try again.'));
    });
    return new IdbBackend(db, await keepsBlobs(db));
  }

  async put(meta: StoredMeta, data: StoredData): Promise<void> {
    // Read before the transaction starts: a transaction ends when nothing is waiting on it.
    const value = data instanceof Blob && !this.blobs ? await data.arrayBuffer() : data;
    const tx = this.db.transaction([META, DATA], 'readwrite');
    tx.objectStore(META).put(meta);
    tx.objectStore(DATA).put(value, meta.path);
    await transactionDone(tx);
  }
  getMeta(path: string): Promise<StoredMeta | undefined> {
    return asPromise(this.db.transaction(META).objectStore(META).get(path) as IDBRequest<StoredMeta | undefined>);
  }
  async getData(path: string): Promise<StoredData | undefined> {
    return asData(await asPromise(this.db.transaction(DATA).objectStore(DATA).get(path) as IDBRequest<StoredData | ArrayBuffer | undefined>));
  }
  async getBoth(path: string): Promise<{ meta: StoredMeta; data: StoredData } | undefined> {
    const tx = this.db.transaction([META, DATA]);
    const [meta, data] = await Promise.all([asPromise(tx.objectStore(META).get(path) as IDBRequest<StoredMeta | undefined>), asPromise(tx.objectStore(DATA).get(path) as IDBRequest<StoredData | ArrayBuffer | undefined>)]);
    return meta !== undefined && data !== undefined ? { meta, data: asData(data) as StoredData } : undefined;
  }
  allMeta(): Promise<StoredMeta[]> {
    return asPromise(this.db.transaction(META).objectStore(META).getAll() as IDBRequest<StoredMeta[]>);
  }
  async putDir(path: string): Promise<void> {
    const tx = this.db.transaction(DIRS, 'readwrite');
    tx.objectStore(DIRS).put({ path });
    await transactionDone(tx);
  }
  async allDirs(): Promise<string[]> {
    const rows = await asPromise(this.db.transaction(DIRS).objectStore(DIRS).getAll() as IDBRequest<Array<{ path: string }>>);
    return rows.map((r) => r.path);
  }
  async clear(): Promise<void> {
    const tx = this.db.transaction([META, DATA, DIRS], 'readwrite');
    for (const name of [META, DATA, DIRS]) tx.objectStore(name).clear();
    await transactionDone(tx);
  }
  close(): void {
    this.db.close();
  }
}

// ---- the store -----------------------------------------------------------

export interface StoreOptions {
  /** Refuse to hold more than this many bytes. Used to try out a full browser without filling one. */
  maxBytes?: number;
  now?: () => Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The export, kept in the browser instead of in a folder: where a browser cannot write into a folder the user picks
 * (Firefox and Safari cannot), this is the folder. It reads back everything it wrote, so an export can be stopped,
 * continued and updated exactly as with a folder, and it is saved as one or more .zip files when the user asks.
 */
export class StoreSink implements Sink {
  private bytes = 0;

  private constructor(
    private readonly backend: StoreBackend,
    private readonly options: StoreOptions,
  ) {}

  static async open(backend: StoreBackend, options: StoreOptions = {}): Promise<StoreSink> {
    const store = new StoreSink(backend, options);
    store.bytes = (await backend.allMeta()).reduce((n, m) => n + m.size, 0);
    return store;
  }

  /** Opens the browser's own storage for the export; rejects where the browser will not allow it. */
  static async openInBrowser(options: StoreOptions = {}, name = 'quipendo-store'): Promise<StoreSink> {
    return StoreSink.open(await IdbBackend.open(name), options);
  }

  async ensureDir(path: string): Promise<void> {
    if (path === '') return;
    splitSafePath(path);
    await this.guarded(() => this.backend.putDir(path));
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    splitSafePath(path);
    const binary = typeof data !== 'string';
    const bytes = binary ? data : encoder.encode(data);
    const previous = (await this.backend.getMeta(path))?.size ?? 0;
    const { maxBytes } = this.options;
    if (maxBytes !== undefined && this.bytes - previous + bytes.length > maxBytes) throw new SinkFullError(FULL);
    const stored: StoredData = binary ? new Blob([bytes as unknown as BlobPart]) : data;
    await this.guarded(() => this.backend.put({ path, size: bytes.length, crc: crc32(bytes), binary }, stored));
    this.bytes += bytes.length - previous;
  }

  /** A browser that is out of room says so in its own words; the export stops with ours. Anything else is made an Error, so it can be told what it was. */
  private async guarded(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (isQuota(err)) throw new SinkFullError(FULL);
      throw err instanceof Error ? err : new Error(`The browser could not keep the file${err === null || err === undefined ? '' : `: ${String(err)}`}.`);
    }
  }

  async readText(path: string): Promise<string | undefined> {
    const data = await this.backend.getData(path);
    return data === undefined ? undefined : typeof data === 'string' ? data : data.text();
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    const data = await this.backend.getData(path);
    if (data === undefined) return undefined;
    return typeof data === 'string' ? encoder.encode(data) : new Uint8Array(await data.arrayBuffer());
  }

  async readHead(path: string, maxBytes: number): Promise<string | undefined> {
    const data = await this.backend.getData(path);
    if (data === undefined) return undefined;
    return typeof data === 'string' ? decoder.decode(encoder.encode(data).subarray(0, maxBytes)) : data.slice(0, maxBytes).text();
  }

  async exists(path: string): Promise<boolean> {
    return (await this.backend.getMeta(path)) !== undefined;
  }

  /** How much is kept. */
  async stats(): Promise<StoreStats> {
    const metas = await this.backend.allMeta();
    return { files: metas.length, bytes: metas.reduce((n, m) => n + m.size, 0) };
  }

  /** Everything kept, for checking what an export wrote. */
  async list(): Promise<StoredMeta[]> {
    return (await this.backend.allMeta()).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async read(path: string): Promise<StoredData | undefined> {
    return this.backend.getData(path);
  }

  /** The folders that were asked for, whether or not they hold anything. */
  async dirs(): Promise<string[]> {
    return (await this.backend.allDirs()).sort();
  }

  /** Forgets everything, so the next export starts from nothing. */
  async clear(): Promise<void> {
    await this.backend.clear();
    this.bytes = 0;
  }

  close(): void {
    this.backend.close();
  }

  /**
   * What is kept, as the .zip files to save. One file unless the export is big: each holds about a gigabyte at most, so
   * every browser can build and download it, and all of them unzip into the same folder.
   */
  async zipParts(budget: ZipBudget = {}): Promise<ZipPart[]> {
    const metas = await this.backend.allMeta();
    const files: ZipItem[] = metas.map((m) => ({
      name: m.path,
      size: m.size,
      crc: m.crc,
      data: async () => {
        const stored = await this.backend.getBoth(m.path);
        if (!stored) throw new Error(`${m.path} is no longer stored. Try again.`);
        // The sizes and checksums in the .zip's headers come from when the parts were listed. A file that another tab wrote
        // since must not slip in under them, or the .zip would be corrupt and still be reported as saved.
        if (stored.meta.size !== m.size || stored.meta.crc !== m.crc) throw new Error(`${m.path} changed while the .zip was being built. Try again.`);
        return typeof stored.data === 'string' ? encoder.encode(stored.data) : stored.data;
      },
    }));
    const groups = partitionZip(zipItems(files, await this.backend.allDirs()), budget);
    return groups.map((items, i) => ({
      index: i + 1,
      count: groups.length,
      entries: items.length,
      bytes: items.reduce((n, item) => n + item.size, 0),
      build: () => zipBlob(items, (this.options.now ?? (() => new Date()))()),
    }));
  }
}

/** The name to save a part under: quipendo-export-2026-11-25.zip, or ...-part-2-of-3.zip when there are several. */
export function zipFileName(part: Pick<ZipPart, 'index' | 'count'>, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return part.count === 1 ? `quipendo-export-${day}.zip` : `quipendo-export-${day}-part-${part.index}-of-${part.count}.zip`;
}
