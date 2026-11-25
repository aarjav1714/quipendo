import { splitSafePath, type Sink } from './sink';

/** The most a page can reasonably hold in memory while it builds a .zip. */
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
/** The classic .zip format counts entries in 16 bits; one value is reserved. */
const DEFAULT_MAX_ENTRIES = 0xfffe;
const COMPRESSIBLE = /\.(md|html?|json|txt|csv|xml|svg)$/i;

/** The export does not fit in one .zip file; a folder has no such limit. */
export class ZipTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipTooLargeError';
  }
}

let crcTable: Uint32Array | undefined;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = (crcTable[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Typed arrays are accepted wherever a Blob is built; recent TypeScript only objects to the buffer type. */
const part = (bytes: Uint8Array): BlobPart => bytes as unknown as BlobPart;

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([part(data)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const u16 = (view: DataView, at: number, value: number): void => view.setUint16(at, value, true);
const u32 = (view: DataView, at: number, value: number): void => view.setUint32(at, value >>> 0, true);

export interface ZipLimits {
  maxBytes?: number;
  maxEntries?: number;
}

/**
 * Holds what an export writes in memory, then produces it as a standard .zip file. Used where there is no folder to
 * write to. Nothing persists between runs, so a second export starts again from nothing.
 */
export class ZipSink implements Sink {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(
    limits: ZipLimits = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  ensureDir(path: string): Promise<void> {
    if (path !== '') splitSafePath(path);
    if (path !== '') this.dirs.add(path);
    return Promise.resolve();
  }

  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    splitSafePath(path);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.bytes += bytes.length - (this.files.get(path)?.length ?? 0);
    if (this.bytes > this.maxBytes) {
      throw new ZipTooLargeError(`The export is larger than ${Math.round(this.maxBytes / 1024 ** 3)} GB, which is too much to build as one .zip file in the browser. Save to a folder instead.`);
    }
    if (!this.files.has(path) && this.files.size + 1 > this.maxEntries) {
      throw new ZipTooLargeError(`The export has more than ${this.maxEntries} files, which a single .zip file cannot hold. Save to a folder instead.`);
    }
    this.files.set(path, bytes);
    return Promise.resolve();
  }

  readBytes(path: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.files.get(path));
  }

  async readText(path: string): Promise<string | undefined> {
    const data = this.files.get(path);
    return data === undefined ? undefined : new TextDecoder().decode(data);
  }

  async readHead(path: string, maxBytes: number): Promise<string | undefined> {
    const data = this.files.get(path);
    return data === undefined ? undefined : new TextDecoder().decode(data.subarray(0, maxBytes));
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  /** Number of files held, not counting folders. */
  get size(): number {
    return this.files.size;
  }

  /** Everything written so far as one .zip file. Folders that hold nothing are kept as empty folder entries. */
  async toBlob(): Promise<Blob> {
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(this.now());
    // Folders that contain a file need no entry of their own; the empty ones do.
    const parents = new Set<string>();
    for (const path of this.files.keys()) for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) parents.add(path.slice(0, i));
    const emptyDirs = [...this.dirs].filter((d) => !parents.has(d)).sort();
    const entries: Array<{ name: string; data: Uint8Array; dir: boolean }> = [
      ...emptyDirs.map((d) => ({ name: `${d}/`, data: new Uint8Array(0), dir: true })),
      ...[...this.files.keys()].sort().map((name) => ({ name, data: this.files.get(name) as Uint8Array, dir: false })),
    ];
    if (entries.length > this.maxEntries) throw new ZipTooLargeError(`The export has more than ${this.maxEntries} entries, which a single .zip file cannot hold. Save to a folder instead.`);

    const parts: BlobPart[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const crc = crc32(entry.data);
      let method = 0;
      let payload = entry.data;
      if (!entry.dir && payload.length > 64 && COMPRESSIBLE.test(entry.name)) {
        const packed = await deflateRaw(payload);
        if (packed.length < payload.length) {
          method = 8;
          payload = packed;
        }
      }
      if (offset > 0xfffffff0 || payload.length > 0xfffffff0) throw new ZipTooLargeError('The export is too large for a single .zip file. Save to a folder instead.');

      const local = new Uint8Array(30);
      const lv = new DataView(local.buffer);
      u32(lv, 0, 0x04034b50);
      u16(lv, 4, 20);
      u16(lv, 6, 0x0800); // names are UTF-8
      u16(lv, 8, method);
      u16(lv, 10, time);
      u16(lv, 12, date);
      u32(lv, 14, crc);
      u32(lv, 18, payload.length);
      u32(lv, 22, entry.data.length);
      u16(lv, 26, name.length);
      parts.push(part(local), part(name), part(payload));

      const head = new Uint8Array(46);
      const cv = new DataView(head.buffer);
      u32(cv, 0, 0x02014b50);
      u16(cv, 4, (3 << 8) | 20); // made on Unix, so the permission bits below are honoured
      u16(cv, 6, 20);
      u16(cv, 8, 0x0800);
      u16(cv, 10, method);
      u16(cv, 12, time);
      u16(cv, 14, date);
      u32(cv, 16, crc);
      u32(cv, 20, payload.length);
      u32(cv, 24, entry.data.length);
      u16(cv, 28, name.length);
      u32(cv, 38, entry.dir ? ((0o040755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0);
      u32(cv, 42, offset);
      central.push(head, name);
      offset += local.length + name.length + payload.length;
    }

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    u32(ev, 0, 0x06054b50);
    u16(ev, 8, entries.length);
    u16(ev, 10, entries.length);
    u32(ev, 12, centralSize);
    u32(ev, 16, offset);
    return new Blob([...parts, ...central.map(part), part(end)], { type: 'application/zip' });
  }
}
