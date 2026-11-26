# Quipendo in Firefox

The Firefox package is built from the same code as the Chrome one. Only the manifest differs (`scripts/targets.mjs` says how). It was tested in stock Firefox 160 with the real extension, not an emulation.

## Try it

```bash
npm ci
npm run build:firefox          # writes dist-firefox/
```

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and pick `dist-firefox/manifest.json`. It stays until Firefox restarts. A normal installation needs the add-on to be signed by Mozilla (below).

In the Firefox that was tested (160), an extension's `host_permissions` are granted when it is installed, and a person can withdraw them in `about:addons` → Quipendo → Permissions. If that happens the page shows a notice and asks again when **Connect** is pressed (a test does exactly this).

## What is different from Chrome

- **No folder picker.** Firefox has no `showDirectoryPicker`, so the export is kept in the browser's own storage (IndexedDB) and saved as `.zip` files. It can be stopped, continued and updated like a folder export, and a very large one is split into parts of at most 1 GiB or 50,000 files.
- **The background script** runs as an event page (`background.scripts`), not a service worker, which Firefox does not offer.
- **The read-only guard works**, with two adjustments the Firefox tests found: the rule's `initiatorDomains` must be the host of the extension's own `moz-extension://<uuid>/` address (not the add-on id), and Firefox has no `webtransport` or `webbundle` request types. `src/ui/guard.ts` handles both.
- **Manifest keys.** `browser_specific_settings.gecko` carries the add-on id (`quipendo@aarjav1714.github.io`), `strict_min_version` 140.0, and `data_collection_permissions: { required: ["authenticationInfo"] }`. Nothing is sent to the developer; the one thing that leaves the browser is the user's Quip access token, which goes to Quip's own API, and [Mozilla counts that as transmitting authentication information](https://extensionworkshop.com/documentation/publish/add-on-policies/) (its definition of transmission is any data "handled outside of the add-on or the local browser", and authentication information cannot rely on implicit consent). So Firefox asks the user at install, and an add-on that cannot work without it is offered as accept or do not install. Declaring `none` here would be wrong. Firefox reads the key from version 140. `gecko_android` is there to keep the declaration valid; Android was not tested.

## Check it

```bash
npx --yes web-ext@10.8.0 lint -s dist-firefox --warnings-as-errors   # 0 errors, 0 warnings, 0 notices
npm run e2e:firefox            # the shared scenarios in stock Firefox, through geckodriver
```

`npm run e2e:firefox` needs Firefox (on macOS `/Applications/Firefox.app`, or set `FIREFOX_BIN`). Selenium Manager fetches geckodriver. Set `E2E_HEADED=1` to watch it. The test build gets a fixed extension address through the `extensions.webextensions.uuids` preference and opens its pages from the browser's own context, because WebDriver may not navigate to a `moz-extension://` address.

## Publish on addons.mozilla.org

You need your own account, so this is the one step that cannot be done from the repository.

1. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) and choose **Submit a New Add-on**, **On this site** (a listed add-on).
2. Upload `quipendo-firefox-<version>.zip`: the package attached to a release (the release workflow builds it from a version tag), or `cd dist-firefox && zip -r -X ../quipendo-firefox.zip .` so `manifest.json` is at the top.
3. The code is bundled and minified, so Mozilla's reviewers need the source: when asked, upload `quipendo-source-<version>.zip` from the same release (or `git archive --format=zip -o quipendo-source.zip HEAD`) and give these build steps: *Node 22 or later; `npm ci`; `npm run build:firefox`; the add-on is `dist-firefox/`.*
4. Fill in the listing with the text in [chrome-web-store.md](chrome-web-store.md) (name, summary, description, category), the privacy policy at `https://github.com/aarjav1714/quipendo/blob/main/PRIVACY.md`, the licence (MIT), and the permission reasons given there: `storage`, `activeTab`, `declarativeNetRequest` and `https://platform.quip.com/*`. Under data collection nothing is collected or transmitted to the developer.
5. Add the screenshots: the five `screenshot-*.jpg` in [`assets/store/`](../assets/store), all of the built-in demo's made-up documents. In *Notes to reviewer* paste the *Firefox Add-ons* block from [reviewing.md](reviewing.md#ready-to-paste-text): a reviewer has no Quip token, so it points them at the demo and at the build steps.
6. Submit, and watch the account's email for the result.

**The add-on id cannot change after the first upload.** `quipendo@aarjav1714.github.io` was chosen for this project and has not been registered anywhere. Mozilla only needs an email-like id that is unique; if you want a different one, change `GECKO_ID` in `scripts/targets.mjs` before the first submission.

## Checklist

- [ ] Add-on id settled (`GECKO_ID` in `scripts/targets.mjs`)
- [ ] `npm run check` and `npm run e2e:firefox` pass
- [ ] `quipendo-firefox-<version>.zip` and `quipendo-source-<version>.zip` from the release
- [ ] Listing, screenshots, privacy policy URL and licence filled in
- [ ] Notes to reviewer pasted (the demo and the build steps)
- [ ] Source and build steps provided when the review asks
