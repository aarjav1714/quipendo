# Publishing Quipendo on the Chrome Web Store

Everything needed to fill in the listing is here. Submitting it needs your own developer account, so it is the one step that cannot be done from this repository.

## Before you start

1. Register at the [developer dashboard](https://chrome.google.com/webstore/devconsole). There is a one-time registration fee, and Google's page lists the [supported countries](https://developer.chrome.com/docs/webstore/register). Use an email you check often: review messages and policy warnings go there, and it cannot be changed later.
2. Set up the account before the first upload. Turn on **2-Step Verification** for the Google account: until it is on, the upload fails with "Enabling 2 step verification on your account is required for security purposes". Then, in *Settings*, add a **contact email** and verify it from the mailbox (it is shown publicly, and the dashboard blocks publishing without it) and make the **trader declaration**. A *trader* account shows the name, address and phone number of the verified Google payments profile on the public listing, so check what that profile holds; a free personal project is normally a non-trader. The publisher display name, also public, starts out as the account's email address.
3. Publish the [privacy policy](../PRIVACY.md) at a public address (its address on GitHub works once it is pushed): `https://github.com/aarjav1714/quipendo/blob/main/PRIVACY.md`.
4. Get the package: the `quipendo-chrome-<version>.zip` attached to a [release](https://github.com/aarjav1714/quipendo/releases) (the release workflow builds it from a version tag), or build it yourself with `npm run build` and zip the *contents* of `dist/`, so `manifest.json` is at the top of the zip.
5. The listing images are in [`assets/store/`](../assets/store). `npm run store-assets` rebuilds them from the real extension page running its built-in demo, and `npm run icons` rebuilds the store icon.

## Listing

**Name:** Quipendo (from the manifest)

**Summary:** the dashboard takes it from `description` in [`extension/manifest.json`](../extension/manifest.json) and shows it read-only (107 characters; the limit is 132). There is no field to paste it into.

**Category:** Productivity › Tools (addons.mozilla.org has no such category: see [firefox-addons.md](firefox-addons.md)). **Language:** English.

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
> • Preview one document before exporting anything, drawn the way it reads, with the Markdown it will be saved as a tab away
> • Tick the folders and documents you want, filter by name, or export only what changed since a date
> • Save to a folder (it can be stopped, continued and updated later), or keep the export in the browser and download it as a .zip
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
> Just looking? Press "Try the demo": a made-up account with documents of every kind opens inside the page, with no token, no Quip account and no network.
>
> A command-line version built from the same code is in the repository, and suits a large export because nothing has to stay on screen.
>
> Limits: Quip's API must be available on your plan, because the token comes from it. Chats are not exported, slide decks become a note plus a PDF, and Quip sites on a dedicated domain (such as customer.onquip.com) are not supported yet.
>
> Quipendo is an independent project. It is not affiliated with, endorsed by or sponsored by Salesforce. Quip is a trademark of Salesforce, Inc.

## Privacy tab

**Single purpose:** Export the user's own Quip documents and folders to Markdown files on the user's computer.

**Permission justifications** (the dashboard asks for one per permission):

- `storage`: Saves the user's export choices (ticked options, selected folders, folder or browser-storage output) and, only if the user ticks "Remember", the Quip access token. Without "Remember" the token is kept in session storage only.
- `activeTab`: When the user clicks the toolbar icon while a Quip page is open, reads that tab's address so the export can be limited to that document or folder. Nothing else is read from the page and no script is injected.
- `declarativeNetRequest`: Installs one dynamic rule that blocks every POST, PUT, PATCH and DELETE request the extension itself sends, so it can never change anything in Quip. It does not block, redirect or modify pages the user visits. (Chrome describes this permission to users as "Block content on any page"; that is the general wording for the API.)
- Host permission `https://platform.quip.com/*`: Quip's API. Used only for read (GET) requests for the user's documents, folders, comments and files.

**Remote code:** the dashboard did not ask (28 Nov 2026). The answer would be No: all code is in the package, and the extension's content security policy allows scripts from the extension only.

**Data usage:** tick *Personally identifiable information* (the names of the user and of the people in their documents, and the account's email), *Authentication information* (the Quip access token), *Personal communications* (comments and conversation) and *Website content* (the documents). Google's [user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) says handling must be disclosed even when the data stays on the user's computer (question 3), and lists reading documents from a user's cloud service as handling (question 2). All of it is read from Quip at the user's request, written to the user's chosen folder, and not sent to the developer or anyone else. The three certifications under the list (no selling or transferring of user data outside approved uses, no use unrelated to the single purpose, no use for creditworthiness or lending) are the developer's own attestation, as is the item-level statement that data usage complies with the Developer Program Policies, so the developer ticks them.

**Privacy policy URL:** `https://github.com/aarjav1714/quipendo/blob/main/PRIVACY.md`

## Graphics

Upload from [`assets/store/`](../assets/store):

- Store icon (128 x 128, artwork 96 x 96 with 16 px of transparent padding, as Google recommends): `store-icon-128.png`
- Screenshots (1280 x 800, full bleed with square corners; at least one is required and five are allowed, and these are five): `screenshot-1-preview.jpg`, `screenshot-2-board.jpg`, `screenshot-3-markdown.jpg`, `screenshot-4-choose.jpg`, `screenshot-5-export.jpg`
- Small promo tile (440 x 280): `promo-tile-440x280.jpg`
- Marquee promo tile (1400 x 560, optional, needed to be featured): `marquee-1400x560.jpg`

The tiles carry the QuipEnd! wordmark; the listing's name field stays plain text, *Quipendo*. The screenshots show the real extension page running its built-in demo, a made-up account: no real document or account appears in them. They are JPEG, so there is no alpha channel for the store's validation to trip over (a browser screenshot saved as PNG has one). Google suggests promo tiles that communicate the brand with little text; these are plain and can be replaced.

## Test instructions for the reviewer

The extension needs a Quip personal access token, which a reviewer cannot get without a Quip account, so it has a built-in demo with made-up documents that needs no token and makes no network request. Paste the *Chrome Web Store, Test instructions* block from [reviewing.md](reviewing.md#ready-to-paste-text) into *Additional instructions* on the dashboard's *Test instructions* page (500 characters at most; leave *Username* and *Password* empty, since nothing needs signing in to); the same file has the full steps for anyone who wants to check the extension by hand. A listing the reviewer cannot try is the likeliest reason for a rejection.

## Distribution tab

The defaults are what is wanted: free of charge, public, all regions.

## Risks to know about

- **The name.** "Quip" is a Salesforce trademark, and [Salesforce's guidelines](https://www.salesforce.com/company/legal/tmcusageguidelines/) (last updated 12 June 2023) name Quip in their scope. Without written permission they forbid putting "any recognizable portion" of a mark into a product name, and they say a trademark "must not be a part of the offering's name". The *prefix* they allow is referential wording in plain text ("compatible with Quip", "integrates with Quip"), not a name that starts with the mark, so Quipendo is on the wrong side of their rule. The law's test is likelihood of confusion, and [adding a word to a mark does not necessarily avoid it](https://www.bitlaw.com/source/tmep/1207-01-b-iii.html) when the dominant part is the same. Whether anyone enforces this against a free, open-source exporter for a product Salesforce is retiring is not certain either way, but the likeliest outcome of a complaint is a rename request. The stores' own rules point the same way: Apple's [guideline 5.2.1](https://developer.apple.com/app-store/review/guidelines/) is the most direct (no protected third-party trademarks in the app without permission), Chrome's [policy](https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property/) bans trademark infringement, and Mozilla's [policy](https://extensionworkshop.com/documentation/publish/add-on-policies/) requires that add-ons conform to US law. The safe form is a name without the word and a description that says what it works with ("exports your Quip documents to Markdown", plus the attribution already in the README). If you rename, change the README, `manifest.json`, `package.json`, `GECKO_ID` and the Apple bundle identifier **before** the first submission: the last two cannot change afterwards.
- **The permission warning.** Chrome shows `declarativeNetRequest` as "Block content on any page", which can look alarming for an extension that only reads. The justification above is the explanation; the same text is in the README.
- **Review.** Extensions that ask for broad permissions get a closer look. This one asks for one host, and the access token never leaves the user's computer except to that host.

## Checklist

- [ ] Developer account registered and verified
- [ ] If `quipendo` gets published to npm, the description can say `npx quipendo` (it is not on npm yet, so it does not)
- [ ] Package uploaded (`manifest.json` at the top of the zip; version matches the tag)
- [ ] Listing text, category and language filled in
- [ ] Store icon, five screenshots, small tile (and marquee) uploaded
- [ ] Privacy policy URL set; single purpose and permission justifications pasted
- [ ] Data usage and certifications ticked
- [ ] Test instructions pasted (the built-in demo; no account or recording needed)
- [ ] Submit, and watch the developer email for the result
