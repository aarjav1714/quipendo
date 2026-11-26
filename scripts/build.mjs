import { build } from 'esbuild';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TARGETS, manifestFor, parseTarget, targetNames } from './targets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const e2e = process.argv.includes('--e2e');
const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
// `--target firefox` builds one browser; `--all` builds every one; no flag builds Chrome, which is where `dist/` has always come from.
const requested = process.argv.includes('--all') ? targetNames : [parseTarget(flag('--target') ?? 'chrome')];

async function buildTarget(target) {
  const { dir, e2eDir, esbuild } = TARGETS[target];
  const outdir = `${root}${e2e ? e2eDir : dir}`;

  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await build({
    entryPoints: { exporter: `${root}src/ui/exporter.ts`, background: `${root}src/background.ts` },
    outdir,
    bundle: true,
    format: 'esm',
    target: esbuild,
    platform: 'browser',
    define: { __E2E__: JSON.stringify(e2e), __TARGET__: JSON.stringify(target) },
    minify: !e2e,
    sourcemap: e2e ? 'inline' : false,
    legalComments: 'none',
    logLevel: 'warning',
  });

  const base = JSON.parse(await readFile(`${root}extension/manifest.json`, 'utf8'));
  const manifest = manifestFor(target, base, { e2e });
  await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of ['exporter.html', 'exporter.css']) await copyFile(`${root}extension/${file}`, `${outdir}/${file}`);
  await cp(`${root}extension/icons`, `${outdir}/icons`, { recursive: true });
  // The Mac app that holds the Safari extension takes its icon from the largest one declared (see targets.mjs).
  if (target === 'safari') await copyFile(`${root}assets/safari-app-icon-1024.png`, `${outdir}/icons/icon-1024.png`);
  // The page header shows the wordmark: one version for a light page and one for a dark page.
  for (const file of ['wordmark-on-light.svg', 'wordmark-on-dark.svg']) await copyFile(`${root}assets/${file}`, `${outdir}/${file}`);

  console.log(`Built ${e2e ? 'E2E ' : ''}${target} extension into ${outdir}`);
}

for (const target of requested) await buildTarget(target);
