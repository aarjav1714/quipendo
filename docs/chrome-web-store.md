# Publishing Quipendo on the Chrome Web Store

Everything needed to fill in the listing is here. Submitting it needs your own developer account, so it is the one step that cannot be done from this repository.

## Before you start

1. Register at the [developer dashboard](https://chrome.google.com/webstore/devconsole). There is a one-time registration fee, and Google's page lists the [supported countries](https://developer.chrome.com/docs/webstore/register). Use an email you check often: review messages and policy warnings go there, and it cannot be changed later.
2. Publish the [privacy policy](../PRIVACY.md) at a public address (its address on GitHub works once it is pushed): `https://github.com/aarjav1714/quipendo/blob/main/PRIVACY.md`.
3. Get the package: the `quipendo-extension-<version>.zip` attached to a [release](https://github.com/aarjav1714/quipendo/releases) (the release workflow builds it from a version tag), or build it yourself with `npm run build` and zip the *contents* of `dist/`, so `manifest.json` is at the top of the zip.
4. The listing images are in [`assets/store/`](../assets/store). `npm run store-assets` rebuilds them from the real extension page and the test account, and `npm run icons` rebuilds the store icon.

## Listing

**Name:** Quipendo

**Summary** (the limit is 132 characters; this is 116):

> Save your Quip folders and documents as Markdown, with calendars, boards and spreadsheets. Read-only, private, free.

**Category:** Productivity. **Language:** English.

**Description:**

> Quip is being retired. Quipendo copies your Quip folders and documents to Markdown files on your computer, keeping the folder structure, so you can keep them in Obsidian, Git or any editor.
>
> What you get
> • One Markdown note per document, with front matter, in the same folders as in Quip
> • Calendars, Kanban boards, project trackers, process bars and spreadsheets, which other exporters leave out (a spreadsheet's .xlsx is saved next to its note, because only that keeps the formulas)
> • Comments and conversation (a comment on highlighted text is placed next to that text when Quip's data allows it); images and attachments saved and linked
> • Links between your documents rewritten to work offline
> • An index of everything exported, and a report of what needs attention
>
> You stay in control
> • Preview one document before exporting anything
> • Tick the folders and documents you want, filter by name, or export only what changed since a date
> • Save to a folder (it can be stopped, continued and updated later) or download one .zip
> • Optional Word (.docx) copies
>
> Read-only and private
> • It can only read from Quip. It cannot create, edit or delete a document, and the browser itself blocks any write it might try
> • Your access token and your documents go to Quip and your own computer, nowhere else. No analytics, no ads, no account, no server
> • Open source (MIT): github.com/aarjav1714/quipendo
>
> How to start
> 1. Sign in to Quip and create a personal access token at quip.com/dev/token
> 2. Click the Quipendo icon, paste the token and press Connect
> 3. Scan, choose what to export, and start
>
> A command line version (npx quipendo) uses the same code, and is better for a large export because nothing has to stay on screen.
>
> Limits: Quip's API must be available on your plan, because the token comes from it. Chats are not exported, slide decks become a note plus a PDF, and Quip sites on a dedicated domain (such as customer.onquip.com) are not supported yet.
>
> Quipendo is an independent project. It is not affiliated with, endorsed by or sponsored by Salesforce. Quip is a trademark of Salesforce, Inc.

## Privacy tab

**Single purpose:** Export the user's own Quip documents and folders to Markdown files on the user's computer.

**Permission justifications** (the dashboard asks for one per permission):

- `storage`: Saves the user's export choices (ticked options, selected folders, folder or .zip output) and, only if the user ticks "Remember", the Quip access token. Without "Remember" the token is kept in session storage only.
- `activeTab`: When the user clicks the toolbar icon while a Quip page is open, reads that tab's address so the export can be limited to that document or folder. Nothing else is read from the page and no script is injected.
- `declarativeNetRequest`: Installs one dynamic rule that blocks every POST, PUT, PATCH and DELETE request the extension itself sends, so it can never change anything in Quip. It does not block, redirect or modify pages the user visits. (Chrome describes this permission to users as "Block content on any page"; that is the general wording for the API.)
- Host permission `https://platform.quip.com/*`: Quip's API. Used only for read (GET) requests for the user's documents, folders, comments and files.

**Remote code:** No. All code is in the package, and the extension's content security policy allows scripts from the extension only.

**Data usage:** tick *Authentication information* (the user's Quip access token, used only to read from Quip). The user's Quip content is handled on the user's computer only; if the dashboard asks about *Website content* or *Personal communications*, the same applies: it is read from Quip at the user's request, written to the user's chosen folder, and not sent to the developer or anyone else. Then tick all three certifications: no selling or transferring of user data outside approved uses, no use unrelated to the single purpose, and no use for creditworthiness or lending.

**Privacy policy URL:** `https://github.com/aarjav1714/quipendo/blob/main/PRIVACY.md`

## Graphics

Upload from [`assets/store/`](../assets/store):

- Store icon (128 x 128, artwork 96 x 96 with 16 px of transparent padding, as Google recommends): `store-icon-128.png`
- Screenshots (1280 x 800, full bleed with square corners; at least one is required and five are allowed): `screenshot-1-preview.jpg`, `screenshot-2-choose.jpg`, `screenshot-3-export.jpg`
- Small promo tile (440 x 280): `promo-tile-440x280.jpg`
- Marquee promo tile (1400 x 560, optional, needed to be featured): `marquee-1400x560.jpg`

The tiles carry the QuipEnd! wordmark; the listing's name field stays plain text, *Quipendo*. The screenshots show the real extension page working on the made-up account that the tests use. No real document or account appears in them. They are JPEG, so there is no alpha channel for the store's validation to trip over (a browser screenshot saved as PNG has one). Google suggests promo tiles that communicate the brand with little text; these are plain and can be replaced.

## Test instructions for the reviewer

The extension needs a Quip personal access token, which a reviewer cannot get without a Quip account. Say so in the *Test instructions* field and either give a test account and token (use a throwaway account with a few made-up documents, and revoke the token afterwards) or point to a short screen recording of a scan, a preview and an export. A listing the reviewer cannot try is the likeliest reason for a rejection.

## Risks to know about

- **The name.** "Quip" is a Salesforce trademark and the name Quipendo contains it. Referring to Quip to say what the extension works with is normal, and the description says it is independent, but the store can still ask for a change. If it does, keep "for Quip" in the description and rename the item to something without the word, then update the README and `manifest.json`.
- **The permission warning.** Chrome shows `declarativeNetRequest` as "Block content on any page", which can look alarming for an extension that only reads. The justification above is the explanation; the same text is in the README.
- **Review.** Extensions that ask for broad permissions get a closer look. This one asks for one host, and the access token never leaves the user's computer except to that host.

## Checklist

- [ ] Developer account registered and verified
- [ ] `quipendo` published to npm (the description mentions `npx quipendo`), or that sentence removed
- [ ] Package uploaded (`manifest.json` at the top of the zip; version matches the tag)
- [ ] Listing text, category and language filled in
- [ ] Store icon, three screenshots, small tile (and marquee) uploaded
- [ ] Privacy policy URL set; single purpose and permission justifications pasted
- [ ] Data usage and certifications ticked
- [ ] Test instructions written, with an account or a recording
- [ ] Submit, and watch the developer email for the result
