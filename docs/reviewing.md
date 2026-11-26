# Testing Quipendo without a Quip account

For store reviewers, and for anyone who wants to see it work before connecting a real account. Quipendo copies a person's own Quip documents to Markdown on their computer. A reviewer rarely has a Quip account (and Quip is being retired), so the extension has a built-in demo: a made-up account that runs entirely inside the page.

## Steps

1. Install the extension and click its toolbar icon. The Quipendo page opens in a tab.
2. In step 1, press **Try the demo**. A banner says *Demo. This is a made-up account. Nothing is read from or sent to Quip*, and the page says it is connected to the demo account. No token is asked for, and none is kept.
3. Under **Optional: preview one document**, the address of a document is already filled in, and the box offers the demo's other documents. Press **Preview**. The **Preview** tab shows the converted document formatted: a process bar, a calendar, a Kanban board, a project tracker, images and comments. The **Markdown** tab shows the same text as plain Markdown, which **Copy Markdown** and **Download .md** save.
4. In step 2 choose **Keep it in this browser, then save it as a .zip** (it works in every browser; Chrome can also write straight into a folder). In step 3 press **Scan**: it lists 13 documents in 9 folders, which can be unticked. In step 4 press **Start export**, then **Save as .zip**.
5. Unzip it. It holds 13 Markdown notes in Quip's folder structure, with attachments, `.xlsx` and `.pdf` copies, an index and a report. [`examples/sample-output/`](../examples/sample-output) in this repository is the same export, file for file apart from timestamps, and a test checks it.
6. Press **Leave the demo**.

## What can be checked

- **No network in the demo.** Open the browser's developer tools on the Quipendo page and watch the Network tab: the demo makes no request at all. (The extension's pages may connect only to `https://platform.quip.com`; the content security policy forbids everything else.)
- **The preview cannot be used against the page.** A document's text is drawn as text nodes and a short list of plain elements ([`src/ui/markdownPreview.ts`](../src/ui/markdownPreview.ts)). Raw HTML in a document is shown as the characters it is, links are inert (they have no `href`), images are placeholders, and nothing in it makes a request. A test feeds it hostile documents (scripts, `javascript:` and `data:` links, event handlers) and checks the result.
- **Only reads with a real account.** The only requests are `GET`s to `platform.quip.com`. The code refuses anything else, and in Chrome and Firefox the browser itself blocks any write request the extension tries to send. See [PRIVACY.md](../PRIVACY.md).
- **No remote code and no third-party code.** The extension bundles only the first-party files in `src/`. [BUILDING.md](../BUILDING.md) rebuilds the submitted package from the source.
- **Permissions.** `storage`, `activeTab`, `declarativeNetRequest` (not in Safari) and `https://platform.quip.com/*`, each explained under [Permission justifications](chrome-web-store.md#privacy-tab).

## Ready-to-paste text

**Chrome Web Store, Test instructions**

> No Quip account is needed. Click the Quipendo toolbar icon. On the page that opens, press "Try the demo" in step 1: it opens a made-up account inside the page (a banner says so), with no token and no network. Press "Preview" to see a document with a calendar, Kanban board, project tracker and process bar, formatted, and see the plain Markdown on the "Markdown" tab. Then in step 2 choose "Keep it in this browser", press "Scan" (13 documents), "Start export", then "Save as .zip": 13 Markdown notes with attachments are saved. They match examples/sample-output in the source repository. With a real Quip token the only requests are GETs to platform.quip.com. Steps: https://github.com/aarjav1714/quipendo/blob/main/docs/reviewing.md

**Firefox Add-ons, Notes for reviewers**

> The extension is a read-only exporter for Quip (Salesforce's documents product). It needs a Quip access token, which a reviewer cannot get, so it has a built-in demo with made-up documents: open the extension page and press "Try the demo" (step 1). Nothing is sent anywhere in the demo. The code is bundled and minified with esbuild from first-party TypeScript only (no third-party code is bundled). BUILDING.md in the source zip has the exact commands: `npm ci && npm run build-for-amo` reproduces the submitted package. `data_collection_permissions` declares authenticationInfo because the user's Quip token is sent to Quip's own API (platform.quip.com); nothing goes to the developer.

**App Review, Notes**

> Quipendo exports a person's Quip documents to Markdown on their Mac. Quip requires a login that a reviewer will not have, so the app has a built-in demo (Guideline 2.1): open Safari, enable the Quipendo extension, click its toolbar button, and press "Try the demo" on the page that opens. It uses a made-up account and makes no network request. Safari asks for permission to access platform.quip.com only when a real token is used.

Questions: [open an issue](https://github.com/aarjav1714/quipendo/issues).
