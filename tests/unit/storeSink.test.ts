// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SinkFullError } from '../../src/core/sink';
import { crc32 } from '../../src/core/zip';
import { MemoryBackend, StoreSink, zipFileName, type StoredData, type StoredMeta, type StoreBackend } from '../../src/ui/storeSink';
import { readZip } from '../helpers/unzip';

let counter = 0;
/** The same behaviour is required of both ways of keeping things. */
const backends: Array<[string, () => Promise<StoreSink>]> = [
  ['in memory', () => StoreSink.open(new MemoryBackend())],
  ['in IndexedDB', () => StoreSink.openInBrowser({}, `test-store-${(counter += 1)}`)],
];

describe.each(backends)('a store kept %s', (kind, open) => {
  it('reads back what it wrote, as a folder would', async () => {
    const store = await open();
    await store.writeFile('Private/Notes.md', '---\ntitle: "Notes"\n---\n# héllo wörld\n');
    await store.writeFile('_attachments/t1/pic.png', Uint8Array.from([137, 80, 78, 71, 0, 255]));

    expect(await store.readText('Private/Notes.md')).toBe('---\ntitle: "Notes"\n---\n# héllo wörld\n');
    expect(await store.readHead('Private/Notes.md', 9)).toBe('---\ntitle');
    expect(Array.from((await store.readBytes('_attachments/t1/pic.png')) ?? [])).toEqual([137, 80, 78, 71, 0, 255]);
    expect(Array.from((await store.readBytes('Private/Notes.md')) ?? []).length).toBe(new TextEncoder().encode('---\ntitle: "Notes"\n---\n# héllo wörld\n').length);
    expect(await store.readHead('_attachments/t1/pic.png', 4)).toBe('\uFFFDPNG'); // read as UTF-8, like every other sink
    expect(await store.exists('Private/Notes.md')).toBe(true);
    expect(await store.exists('Private/Other.md')).toBe(false);
    expect(await store.readText('nothing.md')).toBeUndefined();
    expect(await store.readBytes('nothing.md')).toBeUndefined();
    expect(await store.readHead('nothing.md', 5)).toBeUndefined();
    store.close();
  });

  it('keeps the latest write to a path, and counts what it holds', async () => {
    const store = await open();
    await store.writeFile('a/state.json', '{"v":1}');
    await store.writeFile('a/state.json', '{"v":22}');
    await store.writeFile('b.bin', new Uint8Array(10));
    expect(await store.readText('a/state.json')).toBe('{"v":22}');
    expect(await store.stats()).toEqual({ files: 2, bytes: 8 + 10 });
    expect((await store.list()).map((m) => [m.path, m.size, m.binary])).toEqual([
      ['a/state.json', 8, false],
      ['b.bin', 10, true],
    ]);
    store.close();
  });

  it('refuses paths that could escape the archive', async () => {
    const store = await open();
    await expect(store.writeFile('../evil.md', 'x')).rejects.toThrow(/unsafe path/);
    await expect(store.writeFile('/abs.md', 'x')).rejects.toThrow(/unsafe path/);
    await expect(store.ensureDir('a/../b')).rejects.toThrow(/unsafe path/);
    store.close();
  });

  it('forgets everything on request', async () => {
    const store = await open();
    await store.writeFile('a.md', 'x');
    await store.ensureDir('Empty');
    await store.clear();
    expect(await store.stats()).toEqual({ files: 0, bytes: 0 });
    expect(await store.exists('a.md')).toBe(false);
    expect(await (await store.zipParts())[0]?.build().then((b) => b.arrayBuffer().then((a) => readZip(new Uint8Array(a))))).toEqual({});
    store.close();
  });

  it('saves everything as one standard .zip: contents, checksums, empty folders', async () => {
    const store = await open();
    const long = `# Notes\n\n${'A line of text that compresses well. '.repeat(40)}\n`;
    const png = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 251);
    await store.ensureDir('Private/Projects');
    await store.ensureDir('Empty folder');
    await store.writeFile('Private/Projects/Plan.md', long);
    await store.writeFile('Private/Ünïcode – title.md', 'short');
    await store.writeFile('_attachments/t1/pic.png', png);

    const parts = await store.zipParts();
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ index: 1, count: 1, entries: 4, bytes: new TextEncoder().encode(long).length + 'short'.length + 300 + 0 + 0 });
    const zip = readZip(new Uint8Array(await (await (parts[0] as { build(): Promise<Blob> }).build()).arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual(['Empty folder/', 'Private/Projects/Plan.md', 'Private/Ünïcode – title.md', '_attachments/t1/pic.png']);
    expect(new TextDecoder().decode(zip['Private/Projects/Plan.md']?.data)).toBe(long);
    expect(Array.from(zip['_attachments/t1/pic.png']?.data ?? [])).toEqual(Array.from(png));
    for (const [name, entry] of Object.entries(zip)) expect(entry.crc, name).toBe(crc32(entry.data));
    store.close();
  });

  it('makes several .zip files when the export is big, each valid, all together complete', async () => {
    const store = await open();
    for (let i = 0; i < 7; i += 1) await store.writeFile(`Folder ${i % 2}/note ${i}.md`, `note ${i}\n${'x'.repeat(100)}`);
    const parts = await store.zipParts({ maxBytes: 250 });
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((p) => p.index)).toEqual(parts.map((_, i) => i + 1));
    expect(new Set(parts.map((p) => p.count))).toEqual(new Set([parts.length]));
    const names: string[] = [];
    for (const p of parts) names.push(...Object.keys(readZip(new Uint8Array(await (await p.build()).arrayBuffer()))));
    expect(names.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `Folder ${i % 2}/note ${i}.md`).sort());
    store.close();
  });

  it('refuses what would not fit, and counts a replaced file only once', async () => {
    const store = await (kind === 'in memory' ? StoreSink.open(new MemoryBackend(), { maxBytes: 1000 }) : StoreSink.openInBrowser({ maxBytes: 1000 }, `test-limit-${(counter += 1)}`));
    await store.writeFile('a.bin', new Uint8Array(600));
    await expect(store.writeFile('b.bin', new Uint8Array(600))).rejects.toThrow(SinkFullError);
    await expect(store.writeFile('b.bin', new Uint8Array(600))).rejects.toThrow(/no room left to keep the export/);
    await store.writeFile('a.bin', new Uint8Array(900)); // replacing a file only counts the difference
    expect(await store.exists('b.bin')).toBe(false);
    store.close();
  });
});

describe('a store kept in IndexedDB', () => {
  it('is still there when the page is closed and opened again, so an export can be continued', async () => {
    const name = `test-persist-${(counter += 1)}`;
    const first = await StoreSink.openInBrowser({}, name);
    await first.writeFile('.quip-md-export/state.json', '{"version":2}');
    await first.writeFile('Private/Notes.md', '# Notes');
    await first.ensureDir('Empty');
    first.close();

    const second = await StoreSink.openInBrowser({}, name);
    expect(await second.readText('.quip-md-export/state.json')).toBe('{"version":2}');
    expect(await second.stats()).toEqual({ files: 2, bytes: 13 + 7 });
    const zip = readZip(new Uint8Array(await (await (await second.zipParts())[0]!.build()).arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual(['.quip-md-export/state.json', 'Empty/', 'Private/Notes.md']);
    // The size limit counts what was already there.
    const limited = await StoreSink.openInBrowser({ maxBytes: 25 }, name);
    await expect(limited.writeFile('big.bin', new Uint8Array(10))).rejects.toThrow(SinkFullError);
    second.close();
    limited.close();
  });
});

describe('a store whose browser is out of room', () => {
  it('stops the export with a message that says what to do', async () => {
    class Full extends MemoryBackend implements StoreBackend {
      override put(_meta: StoredMeta, _data: StoredData): Promise<void> {
        return Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
      }
    }
    const store = await StoreSink.open(new Full());
    await expect(store.writeFile('a.md', 'x')).rejects.toThrow(SinkFullError);
    await expect(store.writeFile('a.md', 'x')).rejects.toThrow(/Save what is stored as a \.zip, then clear it/);
  });
});

describe('zipFileName', () => {
  it('names one file by the day, and several by the day and their place', () => {
    const day = new Date('2026-11-25T10:00:00Z');
    expect(zipFileName({ index: 1, count: 1 }, day)).toBe('quipendo-export-2026-11-25.zip');
    expect(zipFileName({ index: 2, count: 3 }, day)).toBe('quipendo-export-2026-11-25-part-2-of-3.zip');
  });
});
