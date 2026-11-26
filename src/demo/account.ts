/**
 * A made-up Quip account for demonstrations: the extension's "Try the demo", the sample output in examples/sample-output/ and
 * the pictures in the store listings are all made from it. Every person, company, number and document here is invented;
 * nothing comes from a real account.
 *
 * api.ts serves it through the same endpoints as Quip's API, so the real exporter runs against it unchanged. The documents are
 * written to show every kind of content Quipendo converts: text formatting, lists, checklists, tables and spreadsheets, code,
 * quotes, images, attachments, slides, comments (including those on highlighted text), links between documents, and the live
 * apps: calendar, Kanban board, project tracker, process bar, poll, countdown, video and Salesforce records and lists.
 */
import { ANN, BOB, F_ARCH, F_DESK, F_PRIV, F_SHARED, F_STAR, F_TRASH, ME, SITE, type Fixture, type FixtureFolder, type FixtureMessage, type FixtureThread } from './model';
import { makePdf, makeXlsx } from './files';
import { DEMO_IMAGES } from './images';

export const CARLOS = { id: 'uCARLOS0001', name: 'Carlos Mendes' };
export const PRIYA = { id: 'uPRIYA00001', name: 'Priya Nair' };

// Folders below the account's own (Private, Desktop, Team Shared, ... come from fixture.ts).
export const F_PROJECTS = 'fPROJECTSdm';
export const F_RELAUNCH = 'fRELAUNCH01';
export const F_TRAVEL = 'fTRAVEL0001';
export const F_HOME = 'fHOME000001';
export const F_MEETINGS = 'fMEETINGS01';

// A thread id is 11 letters and digits with a capital letter in them, as Quip's are. (An address is cut to 11 characters to find
// the document, so a longer id here could be listed and exported but never previewed from its address.)
export const T_WELCOME = 'WELCOMEdemo';
export const T_PLAN = 'RELAUNCHpl1';
export const T_CHECKLIST = 'LAUNCHlist1';
export const T_DECK = 'KICKOFFdeck';
export const T_BUDGET = 'BUDGET2026x';
export const T_LISBON = 'LISBONtrip1';
export const T_MEALS = 'MEALplanner';
export const T_BREAD = 'SOURDOUGHn1';
export const T_SYNC = 'WEEKLYsync1';
export const T_RETRO = 'RETROsprint';
export const T_HANDBOOK = 'HANDBOOKtm1';
export const T_OLD_PLAN = 'PLAN2025old';
export const T_SCRATCH = 'SCRATCHpad1';
/** A document that is not in the demo account, which the handbook still links to. */
const T_WIKI = 'OUTSIDEdoc1';

const B_ARCH = 'IMGarch00001';
const B_WIRE = 'IMGwire00001';
const B_LISBON = 'IMGlisbon001';
const B_BRIEF = 'FILEbrief001';
const B_FLIGHT = 'FILEflight01';
const B_REDIRECTS = 'FILEredirect1';

const US = 1_000;
/** A moment in 2026 as Quip counts it, in microseconds since 1970 (UTC). */
const at = (month: number, d: number, hour = 9, minute = 0): number => Date.UTC(2026, month - 1, d, hour, minute) * US;
/** A date-only value as Quip stores it for a person working in UTC: midnight. */
const day = (month: number, d: number): number => Date.UTC(2026, month - 1, d);

const image = (name: string): { type: string; bytes: Uint8Array } => {
  const found = DEMO_IMAGES[name];
  if (!found) throw new Error(`The demo image ${name} is missing. Run "npm run demo-assets".`);
  return { type: found.type, bytes: Uint8Array.from(atob(found.base64), (c) => c.charCodeAt(0)) };
};

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
const link = (id: string, slug: string): string => `${SITE}/${id}/${slug}`;
const ref = (id: string, slug: string, text: string): string => `<a href='${link(id, slug)}'>${text}</a>`;
const mentionUrl = (person: { id: string }): string => `${SITE}/${person.id}`;

/** The address the page offers to preview first: the document with the most kinds of content in it. */
export const DEMO_START_URL = link(T_PLAN, 'Website-Relaunch-Project-Plan');

let built: Fixture | undefined;

/** The demo's documents by title and Quip address, for the list the page offers to choose from. */
export function demoDocuments(): Array<{ title: string; url: string }> {
  built ??= buildDemoFixture();
  return Object.values(built.threads).map((t) => ({ title: t.title, url: link(t.id, t.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')) }));
}

function sheetTable(title: string, rows: string[][], cell: (text: string, r: number, c: number) => string): string {
  const letters = rows[0]?.map((_, i) => String.fromCharCode(65 + i)) ?? [];
  const head = `<thead><tr><th></th>${letters.map((l) => `<th>${l}</th>`).join('')}</tr></thead>`;
  const body = rows.map((row, r) => `<tr><td>${r + 1}</td>${row.map((text, c) => cell(text, r, c)).join('')}</tr>`).join('');
  return `<table title='${attr(title)}'>${head}<tbody>${body}</tbody></table>`;
}

/** The part of a live app that Quip itself renders as a table, which the exporter keeps when it knows nothing else about the app. */
function dumpTable(summary: string, rows: string[][]): string {
  const [head = [], ...body] = rows;
  return `<details><summary>${summary}</summary><table><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></details>`;
}

interface CellMarks {
  bold?: number[];
  italic?: Array<[row: number, column: number]>;
  strike?: Array<[row: number, column: number]>;
}

/** Builds the HTML of one document the way Quip's API sends it, with ids that are the same on every run. */
function html(prefix: string) {
  let n = 0;
  const id = (): string => `temp:C:${prefix}${(n += 1).toString(36).padStart(3, '0')}`;
  const li = (inner: string, cls = ''): string => `<li id='${id()}'${cls ? ` class='${cls}'` : ''}>${inner}</li>`;
  const ul = (...items: string[]): string => `<ul id='${id()}'>${items.join('')}</ul>`;
  const wrap = (style: number, ...items: string[]): string => `<div data-section-style='${style}'>${ul(...items)}</div>`;
  const live = (appId: string, payload: unknown, dump = ''): string =>
    `<div id='${id()}' data-live-app-id='${appId}'${payload === undefined ? '' : ` data-live-app-payload='${attr(JSON.stringify(payload))}'`}>${dump}</div>`;
  return {
    li,
    h: (level: 1 | 2 | 3, text: string): string => `<h${level} id='${id()}'>${text}</h${level}>`,
    p: (inner: string): string => `<p id='${id()}' class='line'>${inner}</p>`,
    bullets: (...items: string[]): string => wrap(5, ...items),
    numbers: (...items: string[]): string => wrap(6, ...items),
    checks: (...items: string[]): string => wrap(7, ...items),
    done: (text: string): string => li(text, 'checked'),
    todo: (text: string): string => li(text),
    group: (text: string, ...children: string[]): string => li(`${text}${ul(...children)}`, 'parent'),
    quote: (inner: string): string => `<blockquote id='${id()}'><p class='line'>${inner}</p></blockquote>`,
    pre: (text: string): string => `<pre id='${id()}'>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
    hr: (): string => '<hr/>',
    image: (thread: string, blob: string, alt: string, caption?: string): string =>
      `<div data-section-style='11'><img id='${id()}' src='/blob/${thread}/${blob}' alt='${attr(alt)}'/>${caption ? `<figcaption>${caption}</figcaption>` : ''}</div>`,
    date: (month: number, d: number): string => `<control date-ms='${day(month, d)}'></control>`,
    /** A spreadsheet inside a document: the first row is the header. */
    sheet: (title: string, rows: string[][], marks: CellMarks = {}): string => {
      const cell = (text: string, r: number, c: number): string => {
        const classes = [
          r === 0 || marks.bold?.includes(r) ? 'bold' : '',
          marks.italic?.some(([a, b]) => a === r && b === c) ? 'italic' : '',
          marks.strike?.some(([a, b]) => a === r && b === c) ? 'strikethrough' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<td${classes ? ` class='${classes}'` : ''}>${text}</td>`;
      };
      return `<div id='${id()}' data-section-style='13'>${sheetTable(title, rows, cell)}</div>`;
    },
    /** A spreadsheet document: one table per sheet. */
    sheets: (tables: Array<{ title: string; rows: string[][] }>): string =>
      `<div id='${id()}' data-section-style='13'>${tables.map((t) => sheetTable(t.title, t.rows, (text, r) => `<td${r === 0 ? " class='bold'" : ''}>${text}</td>`)).join('')}</div>`,
    calendar: (events: Array<{ color: string; start: string; end?: string; content: string }>, displayMonth: string): string =>
      live('AbNBjAC13no', { events: events.map((e) => ({ color: e.color, dateRange: { start: e.start, end: e.end ?? e.start }, content: e.content })), displayMonth }),
    kanban: (columns: Array<{ color: string; header: string; cards: string[] }>): string =>
      live('KORAjAYHE50', { columns: columns.map((c) => ({ color: c.color, headerContent: c.header, cards: c.cards.map((content) => ({ color: c.color, content })) })) }),
    tracker: (payload: unknown): string => live('JdGAjAc35Es', payload),
    processBar: (steps: string[], current: number): string =>
      live('ProcBar0001', undefined, `<details><table><tr>${steps.map((s, i) => `<td${i === current ? ' data-live-app-process-bar-step-selected' : ''}>${s}</td>`).join('')}</tr></table></details>`),
    poll: (question: string, options: Array<[string, number]>): string =>
      live('PollApp0001', undefined, `<details><summary>Poll</summary><p>${question}</p><table><tr><th>Option</th><th>Votes</th></tr>${options.map(([o, v]) => `<tr><td>${o}</td><td>${v}</td></tr>`).join('')}</table></details>`),
    countdown: (label: string, when: string, left: string): string => live('Countdown01', undefined, `<details><summary>Countdown</summary><p>${label}</p><p>${when}</p><p>${left}</p></details>`),
    video: (url: string): string =>
      live('RNLAjA8V1C2', undefined, `<details><summary></summary><ul><details><summary>Body</summary><pre style="white-space: pre-wrap"><code>elementBody:\n  jsonData:\n    videoUrl:\n      t: 0\n      v: ${url}\n  localId: demo\n</code></pre></details></ul></details>`),
    salesforceRecord: (payload: unknown, rows: string[][]): string => live('XdJAjAN5Jbi', payload, dumpTable('Account', rows)),
    salesforceList: (payload: unknown, rows: string[][]): string => live('QYUAjAGNxIo', payload, dumpTable('Open deals', rows)),
  };
}

// ---- the documents ----------------------------------------------------------------------------------------------------

function welcome(): string {
  const b = html('wl');
  return [
    b.h(1, 'Welcome to the Quipendo demo'),
    b.p("This is a <b>made-up Quip account</b>. Every document, person, company and number in it is invented, so you can see what Quipendo makes of a real account without anyone's real documents being involved."),
    b.h(2, 'What is in here'),
    b.bullets(
      b.li(`${ref(T_PLAN, 'Website-Relaunch-Project-Plan', 'Website Relaunch: Project Plan')}: a status bar, calendar, Kanban board and project tracker, images, an attachment, and comments on highlighted text`),
      b.li(`${ref(T_CHECKLIST, 'Launch-Checklist', 'Launch Checklist')}: nested checklists, a countdown, numbered steps and dates`),
      b.li(`${ref(T_DECK, 'Kickoff-Deck', 'Kickoff Deck')}: a slide deck, saved as a note with a PDF beside it`),
      b.li(`${ref(T_BUDGET, 'Budget-2026', 'Budget 2026')}: a spreadsheet, with its .xlsx saved alongside so the formulas survive`),
      b.li(`${ref(T_LISBON, 'Lisbon-Weekend', 'Lisbon Weekend')}: a video, a calendar, an image with a caption, an embedded spreadsheet and a packing list`),
      b.li(`${ref(T_MEALS, 'Weekly-Meal-Planner', 'Weekly Meal Planner')} and ${ref(T_BREAD, 'Sourdough-Notes', 'Sourdough Notes')}: tables, every kind of text formatting, code and quotes`),
      b.li(`${ref(T_SYNC, 'Weekly-Sync', 'Weekly Sync')} and ${ref(T_RETRO, 'Retro-Sprint-12', 'Retro: Sprint 12')} (in Team Shared): a poll, comments with mentions and replies, a second Kanban board`),
      b.li(`${ref(T_HANDBOOK, 'Team-Handbook', 'Team Handbook')} (in Team Shared): a process bar, Salesforce records, a welcome video and a link to a document outside the export`),
    ),
    b.h(2, 'What to look for'),
    b.numbers(
      b.li('The notes sit in the same folders as in Quip: <b>Private</b>, <b>Team Shared</b> and <b>Archive</b>.'),
      b.li('This note is also on the <b>Desktop</b>, so its header says <code>also_in</code> and the index lists it once.'),
      b.li('Links between documents work offline. The one link to a document outside the export is listed in the report.'),
    ),
    b.quote('Quipendo only ever reads from Quip. It cannot create, change or delete a document.'),
  ].join('\n');
}

function plan(): string {
  const b = html('pl');
  return [
    b.h(1, 'Website Relaunch: Project Plan'),
    b.p(`<b>Goal:</b> ship the new Acme Outdoors website on <b>14 April</b>. Owner: Jane Doe. See the ${ref(T_CHECKLIST, 'Launch-Checklist', 'Launch Checklist')} and the ${ref(T_DECK, 'Kickoff-Deck', 'Kickoff Deck')}.`),
    b.h(2, 'Status'),
    b.processBar(['Discovery', 'Design', 'Build', 'Launch'], 2),
    b.h(2, 'Scope'),
    b.checks(
      b.done('Audit the current site'),
      b.done('Agree the sitemap'),
      b.todo("Build the <span annotationid='temp:C:ann-pages'>product pages</span>"),
      b.todo('Migrate 120 blog posts'),
      b.todo('Set up 301 redirects'),
    ),
    b.h(2, 'Timeline'),
    b.calendar(
      [
        { color: 'BLUE', start: '2026-03-02', content: 'Kickoff' },
        { color: 'GREEN', start: '2026-03-16', end: '2026-03-18', content: 'Design review' },
        { color: 'ORANGE', start: '2026-03-27', content: 'Content freeze' },
        { color: 'PURPLE', start: '2026-04-07', end: '2026-04-09', content: 'Soft launch to staff' },
        { color: 'RED', start: '2026-04-14', content: 'Launch day' },
      ],
      '2026-04',
    ),
    b.h(2, 'Board'),
    b.kanban([
      { color: 'RED', header: 'Backlog', cards: ['Newsletter signup', 'Size guide page'] },
      { color: 'YELLOW', header: 'In progress', cards: ['Product pages', 'Checkout flow'] },
      { color: 'BLUE', header: 'In review', cards: ['Homepage hero'] },
      { color: 'GREEN', header: 'Done', cards: ['Sitemap', 'Brand colours', 'Hosting set up'] },
    ]),
    b.h(2, 'Tracker'),
    b.tracker({
      columns: [
        { content: 'Task\n', type: 'TEXT', id: '0' },
        { content: 'Owner\n', type: 'PERSON', id: '1' },
        {
          content: 'Status\n',
          type: 'STATUS',
          id: '2',
          options: [
            { label: 'Not started', devName: 'not_started', color: 'GRAY' },
            { label: 'In progress', devName: 'in_progress', color: 'YELLOW' },
            { label: 'Done', devName: 'done', color: 'GREEN' },
          ],
        },
        { content: 'Due\n', type: 'DATE', id: '3' },
      ],
      rows: [
        { '0': 'Product pages\n', '1': [CARLOS.id], '2': 'in_progress', '3': day(3, 27) },
        { '0': 'Checkout flow\n', '1': [BOB.id], '2': 'in_progress', '3': day(4, 3) },
        { '0': 'Photography\n', '1': [PRIYA.id], '2': 'done', '3': day(3, 13) },
        { '0': 'Redirect map\n', '1': [ANN.id], '2': 'not_started', '3': day(4, 6) },
      ],
    }),
    b.h(2, 'Design'),
    b.p(`The design brief is attached: <a href='/blob/${T_PLAN}/${B_BRIEF}'>design-brief.pdf</a>.`),
    b.image(T_PLAN, B_ARCH, 'Architecture diagram', 'Architecture, version 3'),
    b.image(T_PLAN, B_WIRE, 'Homepage wireframe', 'Homepage wireframe, version 2'),
  ].join('\n');
}

function checklist(): string {
  const b = html('ck');
  return [
    b.h(1, 'Launch Checklist'),
    b.p(`Everything that has to be true before the domain points at the new site. Questions go to <b>Jane Doe</b>; DNS access is with <b>Carlos Mendes</b>. Part of the ${ref(T_PLAN, 'Website-Relaunch-Project-Plan', 'Project Plan')}.`),
    b.countdown('Launch day', 'Tuesday 14 April 2026', '39 days to go'),
    b.h(2, 'Before launch'),
    b.checks(
      b.group('Content', b.done('Copy approved by the client'), b.done('Photos licensed'), b.todo('Alt text on every image')),
      b.group('Technical', b.done('Redirect map reviewed'), b.todo('Load test at 5x normal traffic'), b.todo('Backups verified')),
      b.group('People', b.done('Support team briefed'), b.todo('Out-of-hours contact list sent')),
    ),
    b.h(2, 'Launch day'),
    b.numbers(
      b.li('Freeze content in the CMS.'),
      b.li('Run <code>make deploy ENV=production</code>.'),
      b.li('Switch DNS to the new site (the TTL is 300 s).'),
      b.li('Check the <b>top 20 pages</b> and the checkout.'),
      b.li('Tell the client at <b>10:00</b>.'),
    ),
    b.h(2, 'After launch'),
    b.bullets(
      b.li(`Review the analytics on ${b.date(4, 21)}.`),
      b.li(`Retire the old server by ${b.date(5, 14)}.`),
      b.li(`Run the retrospective: ${ref(T_RETRO, 'Retro-Sprint-12', 'Retro: Sprint 12')}.`),
    ),
  ].join('\n');
}

const BUDGET_ROWS = [
  ['Category', 'Planned', 'Actual', 'Variance'],
  ['Design', '12,000', '11,250', '-750'],
  ['Development', '30,000', '27,400', '-2,600'],
  ['Content', '8,000', '9,100', '1,100'],
  ['Photography', '4,500', '4,500', '0'],
  ['Hosting', '1,800', '1,650', '-150'],
  ['Total', '56,300', '53,900', '-2,400'],
];
const FORECAST_ROWS = [
  ['Quarter', 'Revenue', 'Costs', 'Margin'],
  ['Q1', '40,000', '31,000', '9,000'],
  ['Q2', '52,000', '36,500', '15,500'],
  ['Q3', '58,000', '39,000', '19,000'],
  ['Q4', '61,000', '41,500', '19,500'],
];

const budgetXlsx = (): Uint8Array =>
  makeXlsx([
    {
      name: 'Budget',
      boldRows: [1, 7],
      rows: [
        ['Category', 'Planned', 'Actual', 'Variance'],
        ['Design', 12000, 11250, { f: 'C2-B2', v: -750 }],
        ['Development', 30000, 27400, { f: 'C3-B3', v: -2600 }],
        ['Content', 8000, 9100, { f: 'C4-B4', v: 1100 }],
        ['Photography', 4500, 4500, { f: 'C5-B5', v: 0 }],
        ['Hosting', 1800, 1650, { f: 'C6-B6', v: -150 }],
        ['Total', { f: 'SUM(B2:B6)', v: 56300 }, { f: 'SUM(C2:C6)', v: 53900 }, { f: 'SUM(D2:D6)', v: -2400 }],
      ],
    },
    {
      name: 'Forecast',
      boldRows: [1],
      rows: [
        ['Quarter', 'Revenue', 'Costs', 'Margin'],
        ['Q1', 40000, 31000, { f: 'B2-C2', v: 9000 }],
        ['Q2', 52000, 36500, { f: 'B3-C3', v: 15500 }],
        ['Q3', 58000, 39000, { f: 'B4-C4', v: 19000 }],
        ['Q4', 61000, 41500, { f: 'B5-C5', v: 19500 }],
      ],
    },
  ]);

const ITINERARY_ROWS = [
  ['Day', 'Morning', 'Afternoon', 'Evening'],
  ['Fri', 'Land, tram 28 to the hotel', 'Walk through Alfama', 'Dinner at a miradouro'],
  ['Sat', 'Pastéis de Belém before 10', 'LX Factory market', 'Fado night'],
  ['Sun', 'Day trip to Sintra', 'Palace gardens', 'Fly home at 21:40'],
];

function lisbon(): string {
  const b = html('ls');
  return [
    b.h(1, 'Lisbon Weekend'),
    b.p("<i>Three days, no alarm clocks.</i> We land on Friday 13 March and fly home on Sunday evening. Most of it is walking: start in <a href='https://example.com/lisbon/alfama'>Alfama</a> and let the hills decide."),
    b.image(T_LISBON, B_LISBON, 'Rooftops and a yellow tram at sunset', 'Golden hour over Alfama (an illustration)'),
    b.h(2, 'Itinerary'),
    b.sheet('Itinerary', ITINERARY_ROWS, { italic: [[2, 1]] }),
    b.h(2, 'Calendar'),
    b.calendar(
      [
        { color: 'BLUE', start: '2026-03-13', content: 'Flight out, 07:15' },
        { color: 'GREEN', start: '2026-03-13', end: '2026-03-15', content: 'Hotel in Alfama' },
        { color: 'ORANGE', start: '2026-03-14', content: 'Fado night, 21:00' },
        { color: 'PURPLE', start: '2026-03-15', content: 'Day trip to Sintra' },
        { color: 'RED', start: '2026-03-15', content: 'Flight home, 21:40' },
      ],
      '2026-03',
    ),
    b.h(2, 'Packing list'),
    b.checks(b.done('Passports'), b.done('Charger and a plug adapter'), b.done('Camera'), b.todo('Comfortable shoes (the hills!)'), b.todo('Rain jacket')),
    b.h(2, 'Ride the 28'),
    b.video('https://example.com/videos/tram-28'),
    b.quote('&ldquo;Go early, take the first tram, and walk back downhill.&rdquo; Priya'),
    b.p(`Booking confirmation: <a href='/blob/${T_LISBON}/${B_FLIGHT}'>flight-confirmation.pdf</a>`),
  ].join('\n');
}

const MEAL_ROWS = [
  ['Day', 'Lunch', 'Dinner'],
  ['Mon', 'Lentil soup', 'Vegetable curry'],
  ['Tue', 'Curry wraps', 'Pasta e fagioli'],
  ['Wed', 'Greek salad', 'Tofu stir fry'],
  ['Thu', 'Pasta e fagioli', 'Pizza night'],
  ['Fri', 'Soup and toast', 'Out with friends'],
];

const mealsXlsx = (): Uint8Array => sheetXlsx('Plan', MEAL_ROWS);

function meals(): string {
  const b = html('ml');
  return [
    b.h(1, 'Weekly Meal Planner'),
    b.p(`Week of ${b.date(3, 9)}. Batch cook on Sunday, then <b>assemble</b> the rest of the week.`),
    b.sheet('Plan', MEAL_ROWS, {
      italic: [
        [2, 1],
        [4, 1],
      ],
      strike: [[3, 2]],
    }),
    b.h(2, 'Groceries'),
    b.checks(b.done('Lentils and chickpeas'), b.done('Tinned tomatoes'), b.todo('Fresh basil'), b.todo('Feta'), b.todo('Sourdough loaf')),
    b.h(2, 'Prep on Sunday'),
    b.numbers(b.li('Soak the chickpeas overnight.'), b.li('Make a big pot of lentil soup and <b>freeze half</b>.'), b.li('Chop vegetables for the curry and the salad.')),
  ].join('\n');
}

function bread(): string {
  const b = html('sd');
  return [
    b.h(1, 'Sourdough Notes'),
    b.p('Our house loaf: <b>78% hydration</b>, <i>slow</i> and <u>cold</u>, <s>no commercial yeast</s> only wild yeast. The starter is fed 1:5:5 and lives on the second shelf.'),
    b.h(2, 'Ingredients'),
    b.bullets(b.li('500 g strong white flour'), b.li('390 g water'), b.li('10 g fine salt'), b.li('100 g active starter')),
    b.h(2, 'Method'),
    b.numbers(
      b.li('Mix everything and rest for <b>30 minutes</b>.'),
      b.li('Fold four times, 30 minutes apart.'),
      b.li('Shape, then proof in the fridge overnight.'),
      b.li('Bake in a hot dutch oven: 20 minutes lid on, 25 minutes lid off.'),
    ),
    b.h(3, 'Notes'),
    b.p('Dough at 24 &deg;C doubles in about five hours. The hydration is water over flour, so 390 / 500 = 0.78, and in my head a loaf rises as <i>x</i><sup>2</sup>. Water is H<sub>2</sub>O, whatever the loaf thinks.'),
    b.quote('Patience is the main ingredient. Everything else is flour.'),
    b.hr(),
    b.h(2, 'Feeding schedule'),
    b.pre('# morning feed\n06:30  discard all but 20 g\n06:35  add 100 g flour and 100 g water\n06:40  stir, mark the jar, loosen the lid\n\n# before baking\n18:00  feed again, use when doubled'),
    b.p("Read more in <a href='https://example.com/baking/sourdough'>the baking guide</a>, or write to <a href='mailto:baker@example.com'>baker@example.com</a>."),
  ].join('\n');
}

function sync(): string {
  const b = html('sy');
  return [
    b.h(1, 'Weekly Sync: 4 March 2026'),
    b.p('<b>Attendees:</b> Jane, Ann, Bob, Carlos, Priya. <b>Notes:</b> Ann.'),
    b.h(2, 'Agenda'),
    b.numbers(b.li('Relaunch status'), b.li('Team offsite'), b.li('Hiring'), b.li('Any other business')),
    b.h(2, 'Decisions'),
    b.bullets(
      b.li(`Content freeze moves to <b>27 March</b> (see the ${ref(T_PLAN, 'Website-Relaunch-Project-Plan', 'Project Plan')}).`),
      b.li('Carlos owns the redirect map; Ann reviews it.'),
      b.li('No launches on Fridays, ever.'),
    ),
    b.h(2, 'Action items'),
    b.checks(
      b.todo(`<b>Ann:</b> send the redirect map, due ${b.date(3, 11)}`),
      b.done('<b>Carlos:</b> book the staging environment'),
      b.todo(`<b>Bob:</b> finalise the homepage hero photo, due ${b.date(3, 13)}`),
      b.todo('<b>Priya:</b> draft the launch announcement'),
    ),
    b.h(2, 'Offsite'),
    b.poll('Where should we hold the offsite?', [
      ['Lisbon', 5],
      ['Porto', 2],
      ['Lake District', 1],
    ]),
    b.p(`Last sprint's notes are in ${ref(T_RETRO, 'Retro-Sprint-12', 'Retro: Sprint 12')}.`),
  ].join('\n');
}

function retro(): string {
  const b = html('rt');
  return [
    b.h(1, 'Retro: Sprint 12'),
    b.p('Facilitator: <b>Carlos Mendes</b>. We sort cards into <i>Went well</i>, <i>To improve</i> and <i>Actions</i>, then vote.'),
    b.kanban([
      { color: 'GREEN', header: 'Went well', cards: ['Design review finished early', 'Fewer meetings', 'New staging server'] },
      { color: 'YELLOW', header: 'To improve', cards: ['Late content from the client', 'Unclear ownership of redirects'] },
      { color: 'BLUE', header: 'Actions', cards: ['Agree a content deadline', 'Write down who owns what'] },
    ]),
    b.h(2, 'Next sprint'),
    b.countdown('Sprint 13 planning', 'Monday 16 March 2026', '10 days to go'),
    b.checks(b.done('Collect the cards'), b.done('Dot-vote'), b.todo('Turn the top three into tickets')),
  ].join('\n');
}

const CONTACT_ROWS = [
  ['Area', 'Person', 'Channel', 'Hours'],
  ['Design', 'Ann Lee', 'design', '09:00 to 17:00'],
  ['Engineering', 'Carlos Mendes', 'engineering', '10:00 to 18:00'],
  ['Accounts', 'Bob Stone', 'accounts', '08:00 to 16:00'],
  ['Everything else', 'Jane Doe', 'general', '09:00 to 17:00'],
];

function handbook(): string {
  const b = html('hb');
  return [
    b.h(1, 'Team Handbook'),
    b.p('Welcome to <b>Acme Studio</b>. This is the one place for how we work: who to ask, how we onboard, and where things live.'),
    b.h(2, 'Who to ask'),
    b.sheet('Contacts', CONTACT_ROWS),
    b.h(2, 'Onboarding'),
    b.processBar(['Offer', 'Day 1', 'Week 1', 'Month 1', 'Review'], 3),
    b.h(2, 'A customer account'),
    b.salesforceRecord({ record_id: '001DEMO000000AC01', org_id: '00DDEMO00000ORG01' }, [
      ['Field', 'Value'],
      ['Account', 'Northwind Outfitters'],
      ['Owner', 'Bob Stone'],
      ['Stage', 'Negotiation'],
      ['Amount', '48,000'],
    ]),
    b.h(2, 'Open deals'),
    b.salesforceList({ list_id: 'DEMOLIST00000001', related_list_type: 'Opportunities' }, [
      ['Deal', 'Stage', 'Amount'],
      ['Northwind Outfitters', 'Negotiation', '48,000'],
      ['Contoso Trails', 'Proposal', '22,500'],
      ['Fabrikam Camping', 'Qualified', '9,800'],
    ]),
    b.h(2, 'Welcome video'),
    b.video('https://example.com/videos/welcome-to-acme'),
    b.h(2, 'Dev setup'),
    b.pre('git clone git@example.com:acme/website.git\ncd website\nmake setup\nmake dev   # then open the address it prints'),
    b.p(`The old wiki is retired: ${ref(T_WIKI, 'Company-Wiki', 'Company Wiki')} (that page is not part of this export).`),
    b.quote('Office hours: Thursdays at 15:00, in person or on a call.'),
  ].join('\n');
}

const GOAL_ROWS = [
  ['Goal', 'Owner', 'Result'],
  ['Launch the shop', 'Jane Doe', 'Done'],
  ['Move to a new host', 'Carlos Mendes', 'Done'],
  ['Redesign the logo', 'Ann Lee', 'Cancelled'],
];

function oldPlan(): string {
  const b = html('op');
  return [
    b.h(1, '2025 Planning'),
    b.p(`<s>Hire a second designer</s> Done in ${b.date(9, 1)}. The numbers moved to ${ref(T_BUDGET, 'Budget-2026', 'Budget 2026')}.`),
    b.sheet('Goals', GOAL_ROWS),
  ].join('\n');
}

/** A workbook of one sheet, with a bold header row, for the .xlsx Quip would send for a document that holds a spreadsheet. */
const sheetXlsx = (name: string, rows: string[][]): Uint8Array => makeXlsx([{ name, boldRows: [1], rows }]);

function scratchpad(): string {
  const b = html('sp');
  return [b.h(1, 'Scratchpad'), b.p('Quick notes that belong in no folder.'), b.bullets(b.li('Buy a new whiteboard'), b.li('Ask Priya about the font licence'), b.li('Book the dentist'))].join('\n');
}

// ---- the account ------------------------------------------------------------------------------------------------------

type Person = { id: string; name: string };

export function buildDemoFixture(): Fixture {
  let counter = 0;
  const say = (who: Person, when: number, text: string, extra: Partial<FixtureMessage> = {}): FixtureMessage => {
    counter += 1;
    return { id: `demomsg${String(counter).padStart(3, '0')}`, author_id: who.id, author_name: who.name, created_usec: when, text, ...extra };
  };
  const thread = (id: string, title: string, pages: string[], extra: Partial<FixtureThread> = {}): FixtureThread => ({
    id,
    title,
    type: 'DOCUMENT',
    authorId: ME.id,
    created: at(1, 12),
    updated: at(3, 4, 16),
    pages,
    ...extra,
  });

  const slides = makePdf(
    [
      { title: 'Website Relaunch', lines: ['Kickoff, 2 March 2026', 'Acme Studio'] },
      { title: 'Goals', lines: ['Ship on 14 April', 'Keep the old URLs working', 'Cut the page weight in half'] },
      { title: 'Timeline', lines: ['March: design and build', 'April: soft launch, then launch', 'May: retire the old server'] },
      { title: 'Team', lines: ['Jane Doe: owner', 'Ann Lee: design', 'Carlos Mendes: engineering', 'Bob Stone: accounts', 'Priya Nair: photography'] },
      { title: 'Risks', lines: ['Late content from the client', 'Redirects missed on launch day', 'Holiday cover in April'] },
    ],
    'slide',
  );

  const threads: FixtureThread[] = [
    thread(T_WELCOME, 'Welcome to the Quipendo demo', [welcome()], { created: at(1, 5), updated: at(3, 1, 8) }),
    thread(T_PLAN, 'Website Relaunch: Project Plan', [plan()], {
      created: at(2, 2),
      updated: at(3, 5, 17, 30),
      messages: [
        say(ANN, at(2, 10, 10, 12), 'Can we move the content freeze to the 27th? The photographer is away until the 24th.'),
        say(ME, at(2, 10, 10, 40), `Yes, done. ${mentionUrl(CARLOS)} please update the calendar.`, { mention_user_ids: [CARLOS.id] }),
        say(BOB, at(2, 11, 9, 5), 'Design brief attached, version 3.', { files: [{ hash: B_BRIEF, name: 'design-brief.pdf' }] }),
        say(ANN, at(2, 12, 14, 20), 'Do the old product URLs need to keep working?', { annotation: { id: 'ann-pages' } }),
        say(ME, at(2, 12, 15, 2), 'Yes: 301 redirects for everything under /shop. The map is attached.', { annotation: { id: 'ann-pages' }, files: [{ hash: B_REDIRECTS, name: 'redirect-map.pdf' }] }),
      ],
    }),
    thread(T_CHECKLIST, 'Launch Checklist', [checklist()], { created: at(2, 20), updated: at(3, 3, 11) }),
    thread(T_DECK, 'Kickoff Deck', [], { type: 'SLIDES', created: at(2, 27), updated: at(3, 2, 9), exports: { pdf: slides } }),
    thread(T_BUDGET, 'Budget 2026', [html('bg').sheets([{ title: 'Budget', rows: BUDGET_ROWS }, { title: 'Forecast', rows: FORECAST_ROWS }])], {
      type: 'SPREADSHEET',
      created: at(1, 20),
      updated: at(3, 2, 15),
      exports: { xlsx: budgetXlsx() },
    }),
    thread(T_LISBON, 'Lisbon Weekend', [lisbon()], {
      created: at(2, 14),
      updated: at(3, 4, 21),
      exports: { xlsx: sheetXlsx('Itinerary', ITINERARY_ROWS) },
      messages: [say(PRIYA, at(2, 15, 18, 4), 'Pastéis de Belém before 10am, the queue is wild after.'), say(ME, at(2, 15, 18, 30), 'Noted, moving it to Saturday morning.')],
    }),
    thread(T_MEALS, 'Weekly Meal Planner', [meals()], { created: at(3, 1), updated: at(3, 8, 20), exports: { xlsx: mealsXlsx() } }),
    thread(T_BREAD, 'Sourdough Notes', [bread()], { created: at(1, 30), updated: at(2, 22, 7) }),
    thread(T_SYNC, 'Weekly Sync: 4 March 2026', [sync()], {
      authorId: ANN.id,
      created: at(3, 4, 10),
      updated: at(3, 4, 12, 15),
      messages: [
        say(BOB, at(3, 4, 12, 30), `Great notes. ${mentionUrl(ANN)} can you also add the hiring numbers?`, { mention_user_ids: [ANN.id] }),
        say(ANN, at(3, 4, 12, 41), 'Will do after lunch.'),
        say(PRIYA, at(3, 4, 13, 2), 'Voted Lisbon. Flights are cheaper before the 20th.'),
      ],
    }),
    thread(T_RETRO, 'Retro: Sprint 12', [retro()], { authorId: CARLOS.id, created: at(3, 2, 15), updated: at(3, 3, 9) }),
    thread(T_HANDBOOK, 'Team Handbook', [handbook()], { authorId: BOB.id, created: at(1, 8), updated: at(2, 27, 10), exports: { xlsx: sheetXlsx('Contacts', CONTACT_ROWS) } }),
    thread(T_OLD_PLAN, '2025 Planning', [oldPlan()], { created: at(1, 6), updated: at(1, 6, 12), exports: { xlsx: sheetXlsx('Goals', GOAL_ROWS) } }),
    thread(T_SCRATCH, 'Scratchpad', [scratchpad()], { created: at(3, 3, 8), updated: at(3, 3, 8, 20) }),
  ];

  const folders: FixtureFolder[] = [
    { id: F_PRIV, title: 'Private', children: [{ thread_id: T_WELCOME }, { folder_id: F_PROJECTS }, { folder_id: F_TRAVEL }, { folder_id: F_HOME }] },
    { id: F_PROJECTS, title: 'Projects', children: [{ folder_id: F_RELAUNCH }, { thread_id: T_BUDGET }] },
    { id: F_RELAUNCH, title: 'Website Relaunch', children: [{ thread_id: T_PLAN }, { thread_id: T_CHECKLIST }, { thread_id: T_DECK }] },
    { id: F_TRAVEL, title: 'Travel', children: [{ thread_id: T_LISBON }] },
    { id: F_HOME, title: 'Home', children: [{ thread_id: T_MEALS }, { thread_id: T_BREAD }] },
    { id: F_DESK, title: 'Desktop', children: [{ thread_id: T_WELCOME }] },
    { id: F_SHARED, title: 'Team Shared', children: [{ folder_id: F_MEETINGS }, { thread_id: T_HANDBOOK }] },
    { id: F_MEETINGS, title: 'Meeting Notes', children: [{ thread_id: T_SYNC }, { thread_id: T_RETRO }] },
    { id: F_ARCH, title: 'Archive', children: [{ thread_id: T_OLD_PLAN }] },
    { id: F_STAR, title: 'Starred', children: [{ thread_id: T_PLAN }] },
    { id: F_TRASH, title: 'Trash', children: [] },
  ];

  const pdf = (title: string, lines: string[]): { type: string; bytes: Uint8Array } => ({ type: 'application/pdf', bytes: makePdf([{ title, lines }]) });
  return {
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    threads: Object.fromEntries(threads.map((t) => [t.id, t])),
    blobs: {
      [`${T_PLAN}/${B_ARCH}`]: image('site-architecture.png'),
      [`${T_PLAN}/${B_WIRE}`]: image('homepage-wireframe.png'),
      [`${T_PLAN}/${B_BRIEF}`]: pdf('Design brief', ['Acme Outdoors website relaunch', 'Audience: weekend walkers and cyclists', 'Tone: friendly, practical, a little dry', 'Palette: forest green, sand and a warm orange']),
      [`${T_PLAN}/${B_REDIRECTS}`]: pdf('Redirect map', ['/shop/boots -> /products/boots', '/shop/packs -> /products/packs', '/shop/sale -> /offers']),
      [`${T_LISBON}/${B_LISBON}`]: image('lisbon-sunset.jpg'),
      [`${T_LISBON}/${B_FLIGHT}`]: pdf('Flight confirmation', ['Outbound: Fri 13 March, 07:15', 'Return: Sun 15 March, 21:40', 'Booking reference: DEMO42']),
    },
    owned: threads.filter((t) => t.authorId === ME.id).map((t) => t.id),
    restrictedFolders: [],
    users: [CARLOS, PRIYA],
  };
}
