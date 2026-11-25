// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ZipTooLargeError, crc32, partitionZip, zipBlob, zipItems, type ZipItem } from '../../src/core/zip';
import { readZip, type ZipEntry } from '../helpers/unzip';

const bytes = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? new TextEncoder().encode(data) : data);
const file = (name: string, data: string | Uint8Array): ZipItem => ({ name, size: bytes(data).length, crc: crc32(bytes(data)), data: bytes(data) });
const unzip = async (blob: Blob): Promise<Record<string, ZipEntry>> => readZip(new Uint8Array(await blob.arrayBuffer()));
const text = (e: ZipEntry | undefined): string | undefined => (e ? new TextDecoder().decode(e.data) : undefined);
const WHEN = new Date(2026, 10, 25, 14, 30, 8);

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('zipBlob', () => {
  it('refuses content that is not the size the entry was listed with, since every offset after it would be wrong', async () => {
    const entry = (data: Uint8Array | Blob, size: number): ZipItem => ({ name: 'a.bin', size, crc: 0, data });
    await expect(zipBlob([entry(new Uint8Array(4), 5)], WHEN)).rejects.toThrow(/a\.bin is not the size it was listed with/);
    await expect(zipBlob([entry(new Blob([new Uint8Array(9)]), 8)], WHEN)).rejects.toThrow(/not the size it was listed with/);
    await expect(zipBlob([{ name: 'b.bin', size: 3, crc: 0, data: () => Promise.resolve(new Uint8Array(2)) }], WHEN)).rejects.toThrow(/not the size it was listed with/);
  });

  it('produces a standard archive: names, contents, checksums, empty folders and permissions', async () => {
    const long = `# Heading\n\n${'A line of text that compresses well. '.repeat(40)}\n`;
    const png = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 251);
    const items = zipItems(
      [file('Private/Projects/Plan.md', long), file('Private/Ünïcode – title.md', 'short'), file('_attachments/t1/pic.png', png)],
      ['Private/Projects', 'Empty folder', 'Private'],
    );
    const zip = await unzip(await zipBlob(items, WHEN));

    expect(Object.keys(zip).sort()).toEqual(['Empty folder/', 'Private/Projects/Plan.md', 'Private/Ünïcode – title.md', '_attachments/t1/pic.png']);
    expect(text(zip['Private/Projects/Plan.md'])).toBe(long);
    expect(zip['Private/Projects/Plan.md']?.method).toBe(8); // long text is deflated
    expect(text(zip['Private/Ünïcode – title.md'])).toBe('short');
    expect(zip['Private/Ünïcode – title.md']?.method).toBe(0); // too small to bother
    expect(zip['_attachments/t1/pic.png']?.method).toBe(0); // binary files are stored as they are
    expect(Array.from(zip['_attachments/t1/pic.png']?.data ?? [])).toEqual(Array.from(png));
    expect(zip['Empty folder/']?.data.length).toBe(0);
    expect(zip['Empty folder/']?.mode).toBe(0o040755);
    expect(zip['Private/Projects/Plan.md']?.mode).toBe(0o100644);
    for (const [name, entry] of Object.entries(zip)) expect(entry.crc, name).toBe(crc32(entry.data));
  });

  it('stores a Blob as it is, and asks for lazy bytes only when the entry is written', async () => {
    const picture = Uint8Array.from({ length: 500 }, (_, i) => i % 251);
    const calls: string[] = [];
    const lazy = (name: string, data: Uint8Array | Blob): ZipItem => {
      const size = data instanceof Blob ? data.size : data.length;
      const crc = crc32(data instanceof Blob ? picture : data);
      return { name, size, crc, data: async () => (calls.push(name), data) };
    };
    const blob = await zipBlob([lazy('a.md', bytes(`${'text '.repeat(100)}`)), lazy('b.bin', new Blob([picture]))], WHEN);
    expect(calls).toEqual(['a.md', 'b.bin']);
    const zip = await unzip(blob);
    expect(zip['a.md']?.method).toBe(8);
    expect(zip['b.bin']?.method).toBe(0);
    expect(Array.from(zip['b.bin']?.data ?? [])).toEqual(Array.from(picture));
  });

  it('stores text as it is where the browser has no deflate', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    try {
      const long = 'plain text '.repeat(50);
      const zip = await unzip(await zipBlob([file('a.md', long)], WHEN));
      expect(zip['a.md']?.method).toBe(0);
      expect(text(zip['a.md'])).toBe(long);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses more entries than the classic format can count', async () => {
    const many = Array.from({ length: 0xffff }, (_, i): ZipItem => ({ name: `f${i}`, size: 0, crc: 0 }));
    await expect(zipBlob(many, WHEN)).rejects.toThrow(ZipTooLargeError);
  });
});

describe('zipItems', () => {
  it('adds an entry only for folders that hold nothing, and sorts everything', () => {
    const items = zipItems([file('b/two.md', '2'), file('a.md', '1'), file('b/c/three.md', '3')], ['b', 'b/c', 'empty', 'empty/inner', '']);
    expect(items.map((i) => i.name)).toEqual(['empty/', 'empty/inner/', 'a.md', 'b/c/three.md', 'b/two.md']);
  });
});

describe('partitionZip', () => {
  const sized = (name: string, size: number): ZipItem => ({ name, size, crc: 0 });

  it('splits in order by size and by count, and gives a file bigger than a part a part of its own', () => {
    const items = [sized('a', 40), sized('b', 40), sized('c', 40), sized('big', 500), sized('d', 10)];
    expect(partitionZip(items, { maxBytes: 100 }).map((g) => g.map((i) => i.name))).toEqual([['a', 'b'], ['c'], ['big'], ['d']]);
    expect(partitionZip(items, { maxBytes: 1000, maxEntries: 2 }).map((g) => g.map((i) => i.name))).toEqual([['a', 'b'], ['c', 'big'], ['d']]);
  });

  it('makes one part for a small export, and one (empty) part for nothing', () => {
    expect(partitionZip([sized('a', 1), sized('b', 2)])).toHaveLength(1);
    expect(partitionZip([])).toEqual([[]]);
  });
});
