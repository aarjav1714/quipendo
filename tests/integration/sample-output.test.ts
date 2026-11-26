// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSample, normalizeSample, type SampleRun } from '../helpers/sampleOutput';

const SAMPLE = fileURLToPath(new URL('../../examples/sample-output/', import.meta.url));

/** The index and the report are the two top-level files that are not notes. */
const isNote = (path: string): boolean => path.endsWith('.md') && path !== '_Index.md' && path !== '_Quip export report.md';

/** Every kind of embedded content the converter knows. Add a type here when the converter learns one, and to the demo account. */
const EMBED_TYPES = ['calendar', 'countdown', 'kanban', 'poll', 'process_bar', 'project_tracker', 'salesforce_list', 'salesforce_record', 'spreadsheet', 'video'];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(dir, path));
    }
  };
  await walk(dir);
  return out.sort();
}

let work: string;
let run: SampleRun;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'quipendo-sample-test-'));
  run = await generateSample(work);
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('the sample output in examples/sample-output', () => {
  it('is what the tool makes from the demo account today (run "npm run sample" after changing the converter or the demo)', async () => {
    expect(run.code, run.lines.join('\n')).toBe(0);
    const made = await files(work);
    const kept = await files(SAMPLE);
    expect(kept).toEqual(made);
    const changed: string[] = [];
    for (const path of made) {
      const a = normalizeSample(path, await readFile(join(work, path)));
      const b = normalizeSample(path, await readFile(join(SAMPLE, path)));
      if (!Buffer.from(a).equals(Buffer.from(b))) changed.push(path);
    }
    expect(changed, 'These files differ from the sample in the repository. Run "npm run sample" and commit the result.').toEqual([]);
  });

  it('shows every kind of embedded content the converter knows', async () => {
    const seen = new Set<string>();
    for (const path of (await files(SAMPLE)).filter(isNote)) {
      const front = /^---\n([\s\S]*?)\n---/.exec(await readFile(join(SAMPLE, path), 'utf8'))?.[1] ?? '';
      for (const m of front.matchAll(/^\s+- "([a-z_]+)"$/gm)) seen.add(m[1] as string);
    }
    expect([...seen].sort()).toEqual(EMBED_TYPES);
  });

  it('is complete: notes, attachments, spreadsheets, the index and the report', async () => {
    const kept = await files(SAMPLE);
    expect(kept).toEqual(expect.arrayContaining(['_Index.md', '_index.json', '_Quip export report.md']));
    expect(kept.filter(isNote).length).toBe(13);
    expect(kept.filter((p) => p.endsWith('.xlsx')).length).toBe(5);
    expect(kept.filter((p) => p.startsWith('_attachments/')).length).toBe(6);
    expect(kept).toEqual(expect.arrayContaining(['Private/Projects/Website Relaunch/Kickoff Deck.pdf', '_Unfiled/Scratchpad.md']));
  });

  it('links every note it names to a file that exists, and every attachment to a saved file', async () => {
    const all = new Set(await files(SAMPLE));
    for (const path of [...all].filter((p) => p.endsWith('.md'))) {
      const text = await readFile(join(SAMPLE, path), 'utf8');
      for (const m of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
        const target = decodeURIComponent((m[1] as string).replace(/^<|>$/g, ''));
        const resolved = join(path, '..', target).split('\\').join('/');
        expect(all.has(resolved), `${path} links to ${target}`).toBe(true);
      }
    }
  });
});
