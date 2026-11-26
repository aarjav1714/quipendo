# Quipendo privacy policy

*Last updated 26 November 2026.*

Quipendo copies your own Quip documents to Markdown files on your computer. It has no server, no accounts, no analytics and no advertising. This page says exactly what it handles. It applies to the browser extension (Chrome and other Chromium browsers, Firefox and Safari) and to the command line tool, which share one code base.

## What it handles

- **Your Quip access token.** You create it at `quip.com/dev/token` and paste it into Quipendo (the command line reads it from `QUIP_TOKEN` or standard input). It is sent only to Quip's API at `platform.quip.com`, in the `Authorization` header of read requests, and nowhere else. It is never printed or logged.
- **Your Quip content.** Documents, folders, comments, images, attachments and spreadsheets are fetched from Quip so they can be converted. They pass through your browser (or your terminal) and are written only to the folder you choose, or, if you choose to keep the export in the browser (the only choice in Firefox and Safari), are kept in the browser's own storage until you save them as `.zip` files and clear them. They are not sent to the developer or to anyone else.
- **Your choices.** Which options are ticked, which folders are selected, a document limit and whether to save to a folder or keep the export in the browser.
- **The demo.** The extension's *Try the demo* button opens a made-up Quip account that is built into the extension. It needs no token, makes no network request and keeps nothing; exporting it writes made-up files to the folder or stored copy you choose, like any export.

## Where it is kept

- **The token** is kept in the browser's session storage, which is erased when the browser closes. Only if you tick *Remember the token on this computer* is it also kept in the extension's local storage, which is unencrypted and inside your browser profile. Unticking *Remember* removes that copy at once, and *Forget token* removes it from the page and from both kinds of storage.
- **Your choices** are kept in the extension's local storage. The date in *Only documents changed since* is not kept.
- **The folder you chose** (Chromium browsers). The browser keeps a handle to it (not its contents), so the page can ask for access again next time.
- **A stored copy of your export**, if you keep the export in the browser. The exported files (your documents as Markdown, their attachments and the files the exporter uses to continue later) are kept in the extension's own IndexedDB storage, on your computer, inside your browser profile and unencrypted, until you press *Clear stored copy* or uninstall the extension. Closing the browser does not remove them. Other websites and extensions cannot read them, but anyone who can read your browser profile can.
- **Exported files** are only in the folder you chose, in the stored copy above, or in the `.zip` files you downloaded. Quipendo does not delete or overwrite files it did not create.

Uninstalling the extension removes everything it stored in the browser. Files already exported stay where you put them.

## What it never does

- It does not send your token, your documents or anything about you anywhere except Quip's API. The extension's content security policy lets its pages connect only to `https://platform.quip.com`, and the browser enforces that.
- It does not collect analytics, usage statistics or crash reports, use cookies (requests are sent without credentials), load remote code or show advertising.
- It does not sell or share data, and it does not use data for anything other than the export you asked for.
- It does not change anything in Quip. Every request is a read. In Chrome and Firefox the browser also blocks any write request (`POST`, `PUT`, `PATCH`, `DELETE`) that the extension itself would send, to any address. Safari has no way to do that for an extension's own requests, so the Safari version relies on its own checks and says so on its page.

The use of information handled by Quipendo adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requirements: it is used only to provide the export you asked for, is not transferred to anyone else, is not used for advertising, and no person reads it.

## Permissions

- `storage`: your choices and, only if you ask, the token. (The stored copy of an export uses the browser's IndexedDB, which needs no permission.)
- `activeTab`: when you click the toolbar icon on a Quip page, the address of that tab is read so the export can be limited to that document or folder. Nothing else is read from the page, and no scripts are injected.
- `declarativeNetRequest` (Chrome and Firefox; the Safari version does not ask for it): one rule that blocks write requests sent by the extension, as described above. It does not touch the pages you visit.
- Access to `https://platform.quip.com/*`: Quip's API, for the read requests. Chrome grants it at install; Firefox and Safari may ask you to allow it, and you can withdraw it in the browser's settings.

In Firefox the add-on's manifest declares that the one thing that leaves the browser is the user's Quip access token, sent to Quip's own API (`data_collection_permissions: authenticationInfo`), and Firefox asks you to accept that when you install it. Nothing is sent to the developer.

## Third parties

Quip (a Salesforce service) receives the requests, as it does from any API client, and its own privacy policy applies to the data it holds. Quipendo is an independent project, not affiliated with, endorsed by or sponsored by Salesforce.

## Changes and contact

Changes to this policy are made in this file, so its history shows what changed and when. Questions and reports: [github.com/aarjav1714/quipendo/issues](https://github.com/aarjav1714/quipendo/issues).
