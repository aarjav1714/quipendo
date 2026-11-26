# Building Quipendo from source

For reviewers (for example at addons.mozilla.org) who need to reproduce a submitted package from the source.

**Tested on:** macOS 27 and Ubuntu (GitHub Actions `ubuntu-latest`), with Node.js 22.17 and npm 10.9. Nothing else needs installing: esbuild and TypeScript come from `package-lock.json`.

**No third-party code is in the extension.** The package is built from the first-party files under `src/` only (38 files); the one runtime dependency in `package.json`, `jsdom`, is used by the command line tool and is not bundled into the extension.

## Build the Firefox package

```bash
npm ci
npm run build-for-amo                       # the same as: npm run build:firefox  (writes dist-firefox/)
npm run verify-build -- --target firefox    # checks the manifest, permissions, hosts, and that no test hooks are in the package
```

`dist-firefox/` is the submitted package: its contents are zipped so that `manifest.json` is at the top. The code in it is bundled and minified by esbuild (`scripts/build.mjs`) from the TypeScript in `src/ui/exporter.ts` and `src/background.ts`; `scripts/targets.mjs` holds the per-browser manifest differences.

`npm run build:all` builds all three packages: `dist/` (Chrome and other Chromium browsers), `dist-firefox/` and `dist-safari/`.

## Check it

```bash
npm test                  # unit and integration tests (they include the demo account and the sample output)
npm run check             # typecheck, tests, all three builds, and verify-build
npm run e2e:firefox       # drives a real Firefox with the extension loaded (needs Firefox and geckodriver)
```

## Try it without a Quip account

Open the extension's page and press **Try the demo**: a made-up account is built into the extension, so nothing needs a login or the network. See [docs/reviewing.md](docs/reviewing.md).
