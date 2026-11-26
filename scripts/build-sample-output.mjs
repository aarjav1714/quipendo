import { build } from 'esbuild';
import { mkdir, mkdtemp, readdir, readFile, rm, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Makes examples/sample-output/: what the real command line tool writes for the made-up demo account (tests/mock/demo.ts).
// Nothing in it comes from a real account. The clock and the time zone are fixed, so the same code always makes the same files.
//
//   npm run sample          write the sample
//   npm run sample -- --check   fail if the sample in the repository is out of date (npm test checks this too)
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const outIndex = args.indexOf('--out');
const target = resolve(outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : `${root}examples/sample-output`);

// The helper is TypeScript, and it needs jsdom from node_modules, so it is bundled next to them rather than in /tmp.
const cache = `${root}node_modules/.cache/quipendo`;
await mkdir(cache, { recursive: true });
const bundle = `${cache}/sample-output.mjs`;
await build({
  entryPoints: [`${root}tests/helpers/sampleOutput.ts`],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['jsdom'],
  logLevel: 'warning',
});
const { generateSample, normalizeSample } = await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`);

const work = await mkdtemp(join(tmpdir(), 'quipendo-sample-'));
try {
  const run = await generateSample(work);
  if (run.code !== 0) {
    console.error(run.lines.join('\n'));
    throw new Error(`The sample export ended with status ${run.code}.`);
  }

  const files = async (dir) => {
    const out = [];
    const walk = async (d) => {
      for (const entry of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) await walk(p);
        else out.push(relative(dir, p));
      }
    };
    await stat(dir).then(() => walk(dir), () => undefined);
    return out;
  };

  if (check) {
    const [made, kept] = [await files(work), await files(target)];
    const problems = [];
    for (const f of made) if (!kept.includes(f)) problems.push(`missing from the repository: ${f}`);
    for (const f of kept) if (!made.includes(f)) problems.push(`no longer produced: ${f}`);
    for (const f of made.filter((x) => kept.includes(x))) {
      const [a, b] = [normalizeSample(f, await readFile(join(work, f))), normalizeSample(f, await readFile(join(target, f)))];
      if (!Buffer.from(a).equals(Buffer.from(b))) problems.push(`changed: ${f}`);
    }
    if (problems.length > 0) {
      console.error(`The sample output is out of date (run "npm run sample"):\n  ${problems.join('\n  ')}`);
      process.exitCode = 1;
    } else console.log(`The sample output is up to date (${made.length} files).`);
  } else {
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(work, target, { recursive: true });
    console.log(`${run.lines.join('\n')}\n\nWrote ${(await files(target)).length} files to ${relative(root, target) || '.'}/`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
