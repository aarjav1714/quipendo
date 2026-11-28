# Quipendo in Firefox

The Firefox package is built from the same code as the Chrome one. Only the manifest differs (`scripts/targets.mjs` says how). It was tested in stock Firefox 160 and 161 with the real extension, not an emulation.

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
npm run build:firefox
npm run verify-build -- --target firefox                              # manifest, permissions, hosts, no test hooks
npx --yes web-ext@10.8.0 lint -s dist-firefox --warnings-as-errors   # 0 errors, 0 warnings, 0 notices
npm run e2e:firefox            # the shared scenarios in stock Firefox, through geckodriver
```

`npm run e2e:firefox` needs Firefox (on macOS `/Applications/Firefox.app`, or set `FIREFOX_BIN`). Selenium Manager fetches geckodriver. Set `E2E_HEADED=1` to watch it. The test build gets a fixed extension address through the `extensions.webextensions.uuids` preference and opens its pages from the browser's own context, because WebDriver may not navigate to a `moz-extension://` address.

## Publish on addons.mozilla.org

You need your own account, so this is the one step that cannot be done from the repository.

**Status:** version 0.1.0 was submitted on 28 Nov 2026 through the classic hub and is awaiting review at [addons.mozilla.org/firefox/addon/quipendo](https://addons.mozilla.org/en-US/firefox/addon/quipendo/). AMO says publication takes up to 24 hours, or longer if the add-on is picked for manual review. The steps below are what that submission went through.

1. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) and choose **Submit Your First Add-on** (or **Submit a New Add-on**), **On this site** (a listed add-on). The first time, AMO asks for the Firefox Add-on Distribution Agreement and the Review Policies and Rules (two checkboxes), which only the account holder can accept. Mozilla is also rolling out a new Developer Hub from December 2026 ([announcement, 20 Nov 2026](https://blog.mozilla.org/addons/2026/11/20/unveiling-the-all-new-firefox-add-on-developer-hub/)): accounts are invited gradually (a *Try the new Developer Hub* link appears), the classic hub stays available, and these steps follow the classic one, so labels may differ. A new version of the agreement and [add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies-preview-2026-12/) takes effect on 1 Dec 2026; this package already provides what they ask of it, which is testing information for reviewers, reproducible source and an accurate data declaration.
2. Upload `quipendo-firefox-<version>.zip`: the package attached to a release (the release workflow builds it from a version tag), or `cd dist-firefox && zip -r -X ../quipendo-firefox.zip .` so `manifest.json` is at the top. AMO validates it with the same linter as `web-ext lint` and answered "validated with no errors or warnings". The manifest's `gecko_android` key (it keeps `data_collection_permissions` valid on Android) makes AMO tick **Firefox for Android** as compatible and lock the box ("Explicitly marked as compatible with Firefox for Android in the manifest"), so the add-on is listed for Android although it has only been tested on desktop; the listing and the reviewer notes say so. To list desktop only, remove `gecko_android` from `scripts/targets.mjs` and check that `web-ext lint` still passes.
3. On the Describe page (the name is taken from the manifest, and the summary starts as the manifest's description, so replace it):
   - **Name** `Quipendo`; **Add-on URL** `quipendo` (both were free on addons.mozilla.org on 28 Nov 2026).
   - **Summary** (up to 250 characters) and **Description** (a limited Markdown: bold, lists and links, no headings): the text in [chrome-web-store.md](chrome-web-store.md). Add a sentence near the top saying that the Quip access token is sent only to Quip, because Firefox's install prompt will say the add-on collects *authentication information*: "Your Quip access token is sent only to Quip (platform.quip.com), to read your documents. Firefox lists that as authentication information when you install. Your documents go only from Quip to your own computer." Leave out `npx quipendo` while the package is not on npm.
   - **Categories**: addons.mozilla.org has no *Productivity*. Tick *My add-on doesn't fit into any of the categories* (**Other**).
   - **Support website** `https://github.com/aarjav1714/quipendo/issues`; **Support email** is optional, and was left empty because the address is shown publicly.
   - **License**: MIT.
   - **Privacy policy**: tick *This add-on has a privacy policy* and paste the text of [PRIVACY.md](../PRIVACY.md), with its headings turned into bold lines. The form stores it as text, not as a link.
   - **Notes to Reviewer**: paste the *Firefox Add-ons* block from [reviewing.md](reviewing.md#ready-to-paste-text): a reviewer has no Quip token, so it points them at the demo, the build steps and the permissions.
   - Leave *experimental* and *requires payment* unticked, then press **Submit Version**.
4. AMO then asks **Do You Need to Submit Source Code?** The code is bundled and minified, so answer **Yes** and upload a source zip: `quipendo-source-<version>.zip` from the same release, or `git archive --format=zip --prefix=quipendo-source/ -o quipendo-source.zip HEAD`. The build steps are in BUILDING.md inside it: *Node 22 or later; `npm ci`; `npm run build-for-amo`; the add-on is `dist-firefox/`.* Rebuilding the source zip this way gives the submitted package byte for byte.
5. After "Version Submitted", open **Edit Product Page**: under *Images* upload the five `screenshot-*.jpg` from [`assets/store/`](../assets/store) in order (1280 x 800, the size Mozilla recommends, all of the built-in demo's made-up documents; each takes a caption) and a custom icon (`extension/icons/icon-128.png`: the listing shows AMO's default icon until the manifest icon is processed). Under *Additional Details* set the homepage. The tags are a fixed list and none of them fits.

**Only for yourself?** Choose **On your own** in step 1 instead. The same zip and source zip go through the validator and the source question, there is no listing to write, and Mozilla emails you when the version is signed; download the signed copy from the version page ([Mozilla's steps](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/#self-distribution)) and open it in ordinary Firefox. A temporary install from `about:debugging` needs no signing but lasts only until Firefox restarts, and for a large export the command-line tool is still the better choice.

**The add-on id cannot change after the first upload.** `quipendo@aarjav1714.github.io` was chosen for this project, and addons.mozilla.org had no add-on with that id (or the `quipendo` address) on 28 Nov 2026. Mozilla only needs an email-like id that is unique; if you want a different one, change `GECKO_ID` in `scripts/targets.mjs` before the first submission. The name and address of the listing can be edited later; the id cannot.

## Checklist

- [x] Name settled ([the trademark risk](chrome-web-store.md#risks-to-know-about)) and add-on id settled (`GECKO_ID` in `scripts/targets.mjs`): submitted as Quipendo
- [x] `quipendo-firefox-<version>.zip` and a source zip uploaded; AMO validated the package with no errors or warnings
- [x] Listing filled in: description with the data sentence, category *Other*, support website, MIT, privacy policy as text, notes for reviewers
- [x] Screenshots, icon and homepage added
- [ ] Publication email received (up to 24 hours, or longer for manual review), and the listing checked at [addons.mozilla.org/firefox/addon/quipendo](https://addons.mozilla.org/en-US/firefox/addon/quipendo/)
- [ ] Decide whether to keep the Android declaration (untested; see step 2) in the next version
