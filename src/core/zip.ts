import { SinkFullError } from './sink';

/** The classic .zip format counts entries in 16 bits; one value is reserved. */
const DEFAULT_MAX_ENTRIES = 0xfffe;
const COMPRESSIBLE = /\.(md|html?|json|txt|csv|xml|svg)$/i;

/** Something in the export does not fit the classic .zip format (a single file of 4 GB or more). */
export class ZipTooLargeError extends SinkFullError {
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

/** Compresses with the browser's own deflate, or returns undefined where it has none (the file is then stored as it is). */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined;
  try {
    const stream = new Blob([part(data)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
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

/** One entry of an archive. */
export interface ZipItem {
  /** Path inside the archive. A folder ends with "/". */
  name: string;
  /** Size in bytes before compression. */
  size: number;
  crc: number;
  /**
   * What to store; nothing for a folder. A Blob is stored as it is, so a large file is never read into memory.
   * Bytes of a text file are compressed when that makes them smaller. A function is called when the entry is
   * written, so a part of a big export only holds the entry being written.
   */
  data?: Uint8Array | Blob | (() => Promise<Uint8Array | Blob>);
}

/** What one archive may hold. Several archives are made when an export is bigger than this. */
export interface ZipBudget {
  maxBytes?: number;
  maxEntries?: number;
}

/** Big enough to be worth it, small enough for every browser to build, hold and download without strain. */
export const PART_MAX_BYTES = 1024 ** 3;
export const PART_MAX_ENTRIES = 50_000;

/**
 * Entries for a set of files, with an entry for each folder that holds nothing (a folder that holds a file needs none).
 * Sorted, so the same export always makes the same archive.
 */
export function zipItems(files: ZipItem[], dirs: Iterable<string>): ZipItem[] {
  const parents = new Set<string>();
  for (const file of files) for (let i = file.name.indexOf('/'); i !== -1; i = file.name.indexOf('/', i + 1)) parents.add(file.name.slice(0, i));
  const empty = [...new Set(dirs)].filter((d) => d !== '' && !parents.has(d)).sort();
  return [...empty.map((d) => ({ name: `${d}/`, size: 0, crc: 0 })), ...[...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))];
}

/** Splits entries, in order, into groups that each fit one archive. A file bigger than the budget gets a group to itself. */
export function partitionZip(items: ZipItem[], budget: ZipBudget = {}): ZipItem[][] {
  const maxBytes = budget.maxBytes ?? PART_MAX_BYTES;
  const maxEntries = budget.maxEntries ?? PART_MAX_ENTRIES;
  const groups: ZipItem[][] = [];
  let current: ZipItem[] = [];
  let bytes = 0;
  for (const item of items) {
    if (current.length > 0 && (bytes + item.size > maxBytes || current.length + 1 > maxEntries)) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.size;
  }
  if (current.length > 0 || groups.length === 0) groups.push(current);
  return groups;
}

/** Writes entries as one standard .zip file (the classic format, which every unzip tool reads). */
export async function zipBlob(items: ZipItem[], when: Date = new Date()): Promise<Blob> {
  if (items.length > DEFAULT_MAX_ENTRIES) throw new ZipTooLargeError(`That is more than ${DEFAULT_MAX_ENTRIES} entries, which a single .zip file cannot hold.`);
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(when);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const item of items) {
    const dir = item.name.endsWith('/');
    const name = encoder.encode(item.name);
    const data = typeof item.data === 'function' ? await item.data() : item.data;
    let method = 0;
    let payload: Uint8Array | Blob = data ?? new Uint8Array(0);
    let payloadSize = item.size;
    if (!dir && payload instanceof Uint8Array && payload.length > 64 && COMPRESSIBLE.test(item.name)) {
      const packed = await deflateRaw(payload);
      if (packed && packed.length < payload.length) {
        method = 8;
        payload = packed;
        payloadSize = packed.length;
      }
    }
    if (offset > 0xfffffff0 || payloadSize > 0xfffffff0 || item.size > 0xfffffff0) throw new ZipTooLargeError('A file in the export is too large for the .zip format.');

    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0x0800); // names are UTF-8
    u16(lv, 8, method);
    u16(lv, 10, time);
    u16(lv, 12, date);
    u32(lv, 14, item.crc);
    u32(lv, 18, payloadSize);
    u32(lv, 22, item.size);
    u16(lv, 26, name.length);
    parts.push(part(local), part(name), payload instanceof Blob ? payload : part(payload));

    const head = new Uint8Array(46);
    const cv = new DataView(head.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, (3 << 8) | 20); // made on Unix, so the permission bits below are honoured
    u16(cv, 6, 20);
    u16(cv, 8, 0x0800);
    u16(cv, 10, method);
    u16(cv, 12, time);
    u16(cv, 14, date);
    u32(cv, 16, item.crc);
    u32(cv, 20, payloadSize);
    u32(cv, 24, item.size);
    u16(cv, 28, name.length);
    u32(cv, 38, dir ? ((0o040755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0);
    u32(cv, 42, offset);
    central.push(head, name);
    offset += local.length + name.length + payloadSize;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, items.length);
  u16(ev, 10, items.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, offset);
  return new Blob([...parts, ...central.map(part), part(end)], { type: 'application/zip' });
}
