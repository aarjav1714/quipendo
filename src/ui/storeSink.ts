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
  allMeta(): Promise<StoredMeta[]>;
  putDir(path: string): Promise<void>;
  allDirs(): Promise<string[]>;
  clear(): Promise<void>;
  close(): void;
}

const isQuota = (err: unknown): boolean => err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);

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

const asPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('The transaction was aborted', 'AbortError'));
  });

/** Keeps the files in IndexedDB: on disk, surviving a closed tab, and not limited by memory. */
export class IdbBackend implements StoreBackend {
  private constructor(private readonly db: IDBDatabase) {}

  static open(name: string): Promise<IdbBackend> {
    return new Promise((resolve, reject) => {
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
        resolve(new IdbBackend(db));
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('The stored export is in use by an older version of this page. Close the other Quipendo tabs and try again.'));
    });
  }

  async put(meta: StoredMeta, data: StoredData): Promise<void> {
    const tx = this.db.transaction([META, DATA], 'readwrite');
    tx.objectStore(META).put(meta);
    tx.objectStore(DATA).put(data, meta.path);
    await finished(tx);
  }
  getMeta(path: string): Promise<StoredMeta | undefined> {
    return asPromise(this.db.transaction(META).objectStore(META).get(path) as IDBRequest<StoredMeta | undefined>);
  }
  getData(path: string): Promise<StoredData | undefined> {
    return asPromise(this.db.transaction(DATA).objectStore(DATA).get(path) as IDBRequest<StoredData | undefined>);
  }
  allMeta(): Promise<StoredMeta[]> {
    return asPromise(this.db.transaction(META).objectStore(META).getAll() as IDBRequest<StoredMeta[]>);
  }
  async putDir(path: string): Promise<void> {
    const tx = this.db.transaction(DIRS, 'readwrite');
    tx.objectStore(DIRS).put({ path });
    await finished(tx);
  }
  async allDirs(): Promise<string[]> {
    const rows = await asPromise(this.db.transaction(DIRS).objectStore(DIRS).getAll() as IDBRequest<Array<{ path: string }>>);
    return rows.map((r) => r.path);
  }
  async clear(): Promise<void> {
    const tx = this.db.transaction([META, DATA, DIRS], 'readwrite');
    for (const name of [META, DATA, DIRS]) tx.objectStore(name).clear();
    await finished(tx);
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

  /** A browser that is out of room says so in its own words; the export stops with ours. */
  private async guarded(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (isQuota(err)) throw new SinkFullError(FULL);
      throw err;
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
        const data = await this.backend.getData(m.path);
        if (data === undefined) throw new Error(`${m.path} is no longer stored.`);
        return typeof data === 'string' ? encoder.encode(data) : data;
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
