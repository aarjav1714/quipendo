import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDemoFixture } from '../../src/demo/account';
import { createDemoFetch, DEMO_TOKEN } from '../../src/demo/api';
import type { Fixture } from '../../src/demo/model';
import { main, type CliIo } from '../../src/node/cli';

/** The moment the sample export is said to have happened, so the "exported" stamps in its files never change. */
export const SAMPLE_NOW = new Date('2026-03-06T09:30:00Z');

export interface SampleRun {
  code: number;
  /** What the command line tool printed, line by line. */
  lines: string[];
}

/**
 * The bytes of a sample file as they are compared. Text files have Quipendo's version number masked, so a release does not
 * make the sample out of date; a change in what the tool writes does.
 */
export function normalizeSample(path: string, bytes: Uint8Array): Uint8Array {
  if (!/\.(md|json)$/.test(path)) return bytes;
  return new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/Quipendo \d+\.\d+\.\d+[\w.+-]*/g, 'Quipendo X.Y.Z'));
}

/**
 * Runs the real command line tool against the made-up demo account and writes what it makes into `outDir`.
 * The account is answered by the same fake API the extension's "Try the demo" uses, with no network. The clock and the
 * time zone are fixed, so the same code always makes the same files. Quipendo's own bookkeeping (`.quip-md-export/`, used
 * to resume a run) is not part of the sample.
 */
export async function generateSample(outDir: string, fixture: Fixture = buildDemoFixture()): Promise<SampleRun> {
  const lines: string[] = [];
  const io: CliIo = { out: (l) => lines.push(l), err: (l) => lines.push(l), readStdin: () => Promise.resolve('') };
  const code = await main(['--out', outDir, '--no-raw'], { QUIP_TOKEN: DEMO_TOKEN }, io, {
    now: () => SAMPLE_NOW,
    timeZone: 'UTC',
    client: { fetch: createDemoFetch(fixture), minIntervalMs: 0 },
  });
  await rm(join(outDir, '.quip-md-export'), { recursive: true, force: true });
  return { code, lines };
}
