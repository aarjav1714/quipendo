// @vitest-environment node
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipSink, ZipTooLargeError, crc32 } from '../../src/core/zip';

interface Entry {
  data: Uint8Array;
  method: number;
  crc: number;
  mode: number;
}

/** A small independent reader: finds the central directory from the end, then reads each entry through its local header. */
function readZip(buf: Uint8Array): Record<string, Entry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = buf.length - 22;
  while (end >= 0 && dv.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out: Record<string, Entry> = {};
  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const mode = dv.getUint32(p + 38, true) >>> 16;
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLength));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    out[name] = { data: method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw, method, crc, mode };
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const bytesOf = async (sink: ZipSink): Promise<Uint8Array> => new Uint8Array(await (await sink.toBlob()).arrayBuffer());
const text = (e: Entry | undefined): string | undefined => (e ? new TextDecoder().decode(e.data) : undefined);

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('ZipSink', () => {
  it('produces a standard archive: names, contents, checksums, empty folders and permissions', async () => {
    const sink = new ZipSink({}, () => new Date(2026, 10, 25, 14, 30, 8));
    const long = `# Heading\n\n${'A line of text that compresses well. '.repeat(40)}\n`;
    const png = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 251);
    await sink.ensureDir('Private/Projects');
    await sink.ensureDir('Empty folder');
    await sink.writeFile('Private/Projects/Plan.md', long);
    await sink.writeFile('Private/Ünïcode – title.md', 'short');
    await sink.writeFile('_attachments/t1/pic.png', png);
    const zip = readZip(await bytesOf(sink));

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

  it('reads back what it holds, like the other sinks, and keeps the latest write to a path', async () => {
    const sink = new ZipSink();
    await sink.writeFile('a/state.json', '{"v":1}');
    await sink.writeFile('a/state.json', '{"v":2}');
    expect(await sink.readText('a/state.json')).toBe('{"v":2}');
    expect(await sink.readHead('a/state.json', 4)).toBe('{"v"');
    expect(await sink.exists('a/state.json')).toBe(true);
    expect(await sink.exists('a/other.json')).toBe(false);
    expect(await sink.readBytes('nothing.md')).toBeUndefined();
    expect(sink.size).toBe(1);
    expect(Object.keys(readZip(await bytesOf(sink)))).toEqual(['a/state.json']);
  });

  it('refuses paths that could escape the archive', async () => {
    const sink = new ZipSink();
    await expect(Promise.resolve().then(() => sink.writeFile('../evil.md', 'x'))).rejects.toThrow(/unsafe path/);
    await expect(Promise.resolve().then(() => sink.writeFile('/abs.md', 'x'))).rejects.toThrow(/unsafe path/);
  });

  it('stops early, with a clear message, when the export is too big for one archive', async () => {
    const small = new ZipSink({ maxBytes: 1000 });
    await small.writeFile('a.bin', new Uint8Array(600));
    expect(() => small.writeFile('b.bin', new Uint8Array(600))).toThrow(ZipTooLargeError);
    expect(() => small.writeFile('b.bin', new Uint8Array(600))).toThrow(/Save to a folder instead/);
    const rewrite = new ZipSink({ maxBytes: 1000 });
    await rewrite.writeFile('a.bin', new Uint8Array(900));
    await rewrite.writeFile('a.bin', new Uint8Array(950)); // replacing a file only counts the difference

    const few = new ZipSink({ maxEntries: 2 });
    await few.writeFile('1.md', 'a');
    await few.writeFile('2.md', 'b');
    await few.writeFile('2.md', 'c'); // rewriting is not a new entry
    expect(() => few.writeFile('3.md', 'd')).toThrow(/more than 2 files/);
  });
});
