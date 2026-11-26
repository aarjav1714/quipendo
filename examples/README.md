# Sample output

[`sample-output/`](sample-output) is what Quipendo writes for a **made-up** Quip account: a small design studio ("Acme Studio") with Jane Doe and four colleagues. Every person, company, number and document in it is invented. Nothing comes from a real account.

Open the notes on GitHub: it shows Markdown the way Obsidian, VS Code or any editor will.

## Start with these

- [Website Relaunch: Project Plan](sample-output/Private/Projects/Website%20Relaunch/Website%20Relaunch%20-%20Project%20Plan.md): a status bar, a calendar, a Kanban board, a project tracker, two images, an attachment, and comments, one of them on highlighted text.
- [Team Handbook](sample-output/Team%20Shared/Team%20Handbook.md): a process bar, Salesforce records, a video, code and a link to a document outside the export.
- [Weekly Sync](sample-output/Team%20Shared/Meeting%20Notes/Weekly%20Sync%20-%204%20March%202026.md): a poll, checklists with dates, and comments with mentions.
- [Lisbon Weekend](sample-output/Private/Travel/Lisbon%20Weekend.md): a calendar, an embedded spreadsheet, a picture with a caption, a video and a packing list.
- [Budget 2026](sample-output/Private/Projects/Budget%202026.md): a spreadsheet, saved with its [`.xlsx`](sample-output/Private/Projects/Budget%202026.xlsx) so the formulas survive.
- [Sourdough Notes](sample-output/Private/Home/Sourdough%20Notes.md): every kind of text formatting, code and quotes.
- [The index](sample-output/_Index.md) and [the report](sample-output/_Quip%20export%20report.md), which list everything exported and what needs attention.

## Every kind of embedded content

Calendars, Kanban boards, project trackers, process bars, polls, countdowns, videos, Salesforce records and lists, and spreadsheets (inside a document and on their own), as well as images, file attachments, slide decks (a note plus a PDF), checklists, nested lists, tables, code, quotes, comments and links between documents. `npm test` fails if the converter learns a type that this sample does not show.

## How it is made

```bash
npm run sample          # write examples/sample-output/
npm run sample:check    # fail if what is there is out of date
```

The script runs the real command line tool against the demo account in [`src/demo/`](../src/demo). The same account, answered by the same fake API, is what the extension's **Try the demo** button opens, so a person without a Quip account can try every step. The clock and the time zone (UTC) are fixed, so the same code always writes the same files.
