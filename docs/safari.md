# Quipendo in Safari

The Safari package is built from the same code as the Chrome one. Only the manifest differs (`scripts/targets.mjs`). It is for **Safari on a Mac, version 16.4 or later**; the iPhone and iPad are not covered. It has been run in the real Safari 27.0.1 on macOS 27, and nothing older was available to test, so the older versions in that range are an assumption taken from MDN's compatibility data.

## Try it

```bash
npm ci
npm run build:safari           # writes dist-safari/
```

In Safari:

1. Settings → **Advanced**: tick *Show features for web developers* (this adds the **Developer** tab).
2. Settings → **Developer**: tick *Allow unsigned extensions*. Safari forgets this each time it quits.
3. In the same pane press **Add Temporary Extension…** and pick the `dist-safari` folder.
4. Settings → **Extensions**: Quipendo is listed under *Temporary*. Make sure its box is ticked.
5. Press its toolbar button. The exporter page opens in a new tab. Safari asks you to let Quipendo use `platform.quip.com` the first time it is needed; allow it. If it has not been given, the page says so and where to change it.

A temporary extension is removed when Safari quits. After you rebuild, press **Reload** under the extension in Settings → Extensions; the extension's address changes when it reloads.

These steps were followed on Safari 27.0.1. The prompt for `platform.quip.com` itself was not seen: the test runs only used a local test server.

## What is different from Chrome

- **No folder picker.** Safari has no `showDirectoryPicker`, so the export is kept in the browser's own storage (IndexedDB) and saved as `.zip` files, which can be stopped, continued and updated like a folder export. Safari may ask where to save each file (Settings → General → *File download location*). If it blocks a download that starts after a long wait, a **Save it again** link appears under the status line.
- **No browser-level read-only guard.** Safari accepts a `declarativeNetRequest` rule without an error and then never applies it to the requests an extension's own pages make. On Safari 27 a rule that blocked every request to a server, with no condition on who sent it, let all of them through. So the Safari build does not ask for the permission, and the page says "Browser-level read-only guard: unavailable" with the reason. What still protects you is the client, which can only send `GET`; the page's content security policy, which lets it connect only to `platform.quip.com`; and the tests. The other browsers keep the guard.
- **Site access is per site.** Safari grants nothing at install. The page checks, and asks from the **Connect** click, because Safari only shows its prompt for a request that comes straight from a click.
- **The token** is kept in session storage (Safari 16.4 and later), and in the page's memory only before that.
- **Safari will not open an extension's page from outside.** Typing or scripting `safari-web-extension://…` gives "Failed to open page"; only the extension, from its toolbar button or `tabs.create`, can open it. The test driver relies on that (below).

## Build it with Xcode

Safari extensions that stay installed, and the ones other people use, are shipped inside a small Mac app. Apple's converter makes the project:

```bash
npm run build:safari
xcrun safari-web-extension-converter dist-safari \
  --project-location ~/quipendo-safari --app-name Quipendo \
  --bundle-identifier io.github.aarjav1714.quipendo \
  --macos-only --no-prompt --copy-resources
open ~/quipendo-safari/Quipendo/Quipendo.xcodeproj
```

In Xcode choose your team (or *Sign to Run Locally*), run the *Quipendo (macOS)* scheme, then enable the extension in Safari's Settings → Extensions. Xcode on that Mac must have finished its first-launch setup (`xcodebuild -runFirstLaunch`, which needs an administrator), or the converter stops with "A required plugin failed to load".

These commands come from Apple's documentation. They could not be run on the Mac this was developed on, because Xcode there had not finished that setup, so the CI workflow's **Safari package** job is the first place they run (it converts and builds without signing, on a macOS runner).

`io.github.aarjav1714.quipendo` is a placeholder; use an identifier you own. Giving the extension to other people means signing it: the Mac App Store or a notarized download, both of which need Apple's paid developer program. That is the one step that cannot be done from this repository.

## Check the page in WebKit, without a Mac

Safari's engine is WebKit, and Playwright ships a build of it that runs anywhere:

```bash
npx playwright install webkit
npm run e2e:webkit
```

It serves the Safari build of the page from a local web server and stands in for the extension API (`tests/e2e/harness/shim.ts`), so it checks the page's own behaviour in that engine: the export and its `.zip` files, IndexedDB, Blob, `CompressionStream`, `DOMParser` and several tabs at once. It skips the scenarios that need a real extension (the toolbar button, site access, the request guard). CI runs it on every push. It found that a temporary WebKit session cannot keep a Blob in IndexedDB, which the store now handles by keeping the bytes as plain data.

## Run the end-to-end tests in the real Safari

`npm run e2e:safari` runs the same scenarios as for the other browsers in your real Safari, through AppleScript. It uses one window or tab per page and runs JavaScript in it with `do JavaScript`. It does not drive Safari's windows, so it works while the Mac is locked once it has started, but the setup needs a person at the screen.

1. `npm run build:e2e:safari` (writes `dist-e2e-safari/`, the test build).
2. Safari's Settings → Developer: tick *Allow unsigned extensions* and *Allow JavaScript from Apple Events*.
3. **Add Temporary Extension…** → pick `dist-e2e-safari`, and make sure it is ticked in Settings → Extensions.
4. Press the extension's toolbar button once and leave that tab open: the test reads the extension's address from it, and uses it to open the other pages (Safari will not let anything else). Set `E2E_SAFARI_ORIGIN=safari-web-extension://<uuid>` instead if the tab is not open.
5. `npm run e2e:safari`. If Quipendo has no access to the test server (`127.0.0.1`) yet, the run opens a page and waits for you to press **Connect** in it and allow it.

After each rebuild: Settings → Extensions → the E2E build → **Reload**, press the toolbar button again, and run the tests. A scenario a browser cannot run is skipped, with the reason in its name: Safari has no folder picker and no guard, and does not let a test withdraw its site access.

What the Safari run does not check is what lands on disk: Safari shows its save dialog, which a script cannot press without Accessibility access and an unlocked screen, so the test checks the name and bytes the page hands to Safari. In a manual check, pressing **Download .md** showed Safari's save sheet.

## What was tested

- **The page in WebKit 27.2** (Playwright, `npm run e2e:webkit`), with the final code: 30 scenarios passed and 6 were skipped, because they need a real extension. This covers the export, the stored copy, the `.zip` files (one and several), resuming, clearing, a full browser and several tabs at once, in Safari's engine.
- **The real Safari 27.0.1** (`npm run e2e:safari`), on earlier builds of the page:
  - The first run passed 25 scenarios and skipped 2. Of 8 failures, two showed that Safari does not apply the guard rule (so the Safari build now says the guard is unavailable) and six were checks of files on disk behind Safari's save dialog (now left to the page-level check above).
  - A second run, after those changes, passed 28 and skipped 3, with 5 failures that came from the run, not from the page: Safari keeps serving the files an extension had when it was loaded, so the page was an older build than the one under test; and the driver could not close the selected tab, so later scenarios counted tabs left open (fixed).
- **Not yet run:** the real Safari against the final build. It needs *Reload* in Settings → Extensions, the toolbar button, and **Connect** pressed once with a real click, none of which a script can do while the screen is locked. Until it is run, what is known of the final code in the real Safari is what the earlier runs showed (the toolbar button, opening the page, connecting and exporting, the guard's absence, the stored export and its `.zip` hand-off) plus the WebKit run above.
- **Not seen at all:** Safari's prompt for `platform.quip.com` itself, and what Safari does when a `.zip` download starts after a long build rather than straight from a click (the **Save it again** link is there for that case).
