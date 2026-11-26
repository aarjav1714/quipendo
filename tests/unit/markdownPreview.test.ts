import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { codeSpan, escapeBlockStart, escapeInline, fencedBlock, linkDest, yamlString } from '../../src/core/markdownUtils';
import { renderMarkdownPreview } from '../../src/ui/markdownPreview';

// A regression that makes a case slow fails it, instead of letting it run for minutes.
vi.setConfig({ testTimeout: 5_000 });

const render = (md: string): HTMLElement => renderMarkdownPreview(md, document);
const all = (root: ParentNode, selector: string): Element[] => Array.from(root.querySelectorAll(selector));
const textOf = (el: Element | null | undefined): string => el?.textContent ?? '';

describe('blocks', () => {
  it('draws headings one to six, resolves escapes and drops a closing run of #', () => {
    const root = render('# One\n\n## Two ##\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\n## \\_Unfiled\n\n#hashtag is text\n\n####### seven is text');
    expect(all(root, 'h1,h2,h3,h4,h5,h6').map((h) => `${h.tagName.toLowerCase()}:${h.textContent}`)).toEqual(['h1:One', 'h2:Two', 'h3:Three', 'h4:Four', 'h5:Five', 'h6:Six', 'h2:_Unfiled']);
    expect(all(root, 'p').map(textOf)).toEqual(['#hashtag is text', '####### seven is text']);
  });

  it('keeps paragraphs apart, and turns hard and plain line breaks into breaks', () => {
    const root = render('one  \ntwo\nthree\n\nsecond paragraph');
    const [first, second] = all(root, 'p');
    expect(first?.querySelectorAll('br')).toHaveLength(2);
    expect(first?.textContent).toBe('onetwothree');
    expect(textOf(second)).toBe('second paragraph');
  });

  it('draws a thematic break', () => {
    const root = render('above\n\n---\n\nbelow');
    expect(all(root, 'p').map(textOf)).toEqual(['above', 'below']);
    expect(all(root, 'hr')).toHaveLength(1);
  });

  it('draws fenced code as text, with the language as a class, whatever the fence length', () => {
    const root = render('```ts\nconst a = "<b>not bold</b>";\n```\n\n````\n```\ninner\n```\n````\n\n```\nunterminated\nstill code');
    const codes = all(root, 'pre > code');
    expect(codes).toHaveLength(3);
    expect(codes[0]?.className).toBe('language-ts');
    expect(codes[0]?.textContent).toBe('const a = "<b>not bold</b>";');
    expect(root.querySelector('b')).toBeNull();
    expect(codes[1]?.textContent).toBe('```\ninner\n```');
    expect(codes[2]?.textContent).toBe('unterminated\nstill code');
    expect(codes[2]?.className).toBe('');
  });

  it('drops an info string that could carry markup instead of using it as a class', () => {
    const root = render('```"><img src=x>\ncode\n```');
    expect(all(root, 'pre > code')[0]?.className).toBe('');
    expect(root.querySelector('img')).toBeNull();
  });

  it('draws quotes, nested ones, and keeps their paragraphs', () => {
    const root = render('> first\n> still first\n>\n> second\n>\n> > inner');
    const quote = root.querySelector('blockquote');
    expect(all(quote as Element, ':scope > p').map(textOf)).toEqual(['firststill first', 'second']);
    expect(textOf(quote?.querySelector('blockquote'))).toBe('inner');
  });

  it('draws a comment as a message with who and when, and tells apart the ones about highlighted text', () => {
    const root = render('> **Ann Lee** · 2026-02-10 10:12 UTC\n> Can we move it?\n> Thanks\n\n> **Jane Doe** · 2026-02-10 10:40 UTC · *on highlighted text*\n> Done\n\n> A plain quote');
    const quotes = all(root, 'blockquote');
    expect(quotes.map((q) => q.classList.contains('md-comment'))).toEqual([true, true, false]);
    const head = quotes[0]?.querySelector('.md-comment-head');
    expect(textOf(head?.querySelector('.md-comment-who'))).toBe('Ann Lee');
    expect(textOf(head?.querySelector('.md-comment-when'))).toBe('2026-02-10 10:12 UTC');
    expect(head?.querySelector('.md-comment-note')).toBeNull();
    expect(textOf(quotes[0]?.querySelector('p'))).toBe('Can we move it?Thanks');
    expect(quotes[0]?.querySelectorAll('p br')).toHaveLength(1);
    expect(textOf(quotes[1]?.querySelector('.md-comment-note'))).toBe('on highlighted text');
    expect(quotes[2]?.querySelector('.md-comment-head')).toBeNull();
  });

  it('does not take a bold first line for a comment unless it has the date', () => {
    const root = render('> **Note:** careful\n\n> **Ann** · tomorrow');
    expect(all(root, 'blockquote.md-comment')).toHaveLength(0);
  });

  it('draws the callout the exporter writes for a moved document', () => {
    const root = render('# Old\n\n> [!info] This Quip document was moved to Archive\n> and more');
    const callout = root.querySelector('blockquote.md-callout.md-callout-info');
    expect(textOf(callout?.querySelector('.md-callout-title'))).toBe('This Quip document was moved to Archive');
    expect(textOf(callout?.querySelector('p'))).toBe('and more');
  });
});

describe('lists', () => {
  it('draws bullet and numbered lists, honouring the first number', () => {
    const root = render('- a\n- b\n\n3. c\n4. d\n\n1. e');
    const lists = all(root, 'ul, ol');
    expect(lists.map((l) => l.tagName)).toEqual(['UL', 'OL', 'OL']);
    expect(all(lists[0] as Element, 'li').map(textOf)).toEqual(['a', 'b']);
    expect(lists[1]?.getAttribute('start')).toBe('3');
    expect(lists[2]?.hasAttribute('start')).toBe(false);
  });

  it('starts a new numbered list when the count does not carry on after a blank line', () => {
    const root = render('1. a\n2. b\n\n1. c\n2. d\n\n3. e');
    const lists = all(root, 'ol');
    expect(lists.map((l) => all(l, 'li').map(textOf).join(''))).toEqual(['ab', 'cde']);
  });

  it('draws task items with a disabled, labelled checkbox and the text', () => {
    const root = render('- [x] done\n- [ ] open\n- plain\n- [x]');
    const boxes = all(root, 'li > input[type=checkbox]') as HTMLInputElement[];
    expect(boxes.map((b) => [b.disabled, b.checked, b.getAttribute('aria-label')])).toEqual([
      [true, true, 'Completed'],
      [true, false, 'Not completed'],
      [true, true, 'Completed'],
    ]);
    expect(all(root, 'li').map(textOf)).toEqual(['done', 'open', 'plain', '']);
    expect(all(root, 'li.md-task-done')).toHaveLength(2);
    expect(root.querySelectorAll('li:not(.md-task)')).toHaveLength(1);
  });

  it('nests by indentation: two blanks under a bullet, three under a number', () => {
    const root = render('- Content\n  - [x] Copy\n  - [ ] Alt text\n- Technical\n  1. one\n  2. two\n\n1. Step\n   - sub\n   - sub two\n2. Next');
    const top = root.querySelector('ul') as Element;
    expect(all(top, ':scope > li')).toHaveLength(2);
    expect(all(top, ':scope > li:first-child > ul > li').map(textOf)).toEqual(['Copy', 'Alt text']);
    expect(all(top, ':scope > li:last-child > ol > li').map(textOf)).toEqual(['one', 'two']);
    const steps = all(root, 'ol')[1] as Element;
    expect(all(steps, ':scope > li')).toHaveLength(2);
    expect(all(steps, ':scope > li:first-child > ul > li').map(textOf)).toEqual(['sub', 'sub two']);
    expect(textOf(steps.querySelector('li'))).toBe('Stepsubsub two');
  });

  it('keeps list items inline text out of paragraphs, and renders inline markup and breaks inside them', () => {
    const root = render('- **bold** and `code`<br>second line\n- item');
    const li = root.querySelector('li') as Element;
    expect(li.querySelector('p')).toBeNull();
    expect(li.querySelector('strong')?.textContent).toBe('bold');
    expect(li.querySelector('code')?.textContent).toBe('code');
    expect(li.querySelectorAll('br')).toHaveLength(1);
  });

  it('draws the Kanban shape: bold column names with cards beneath', () => {
    const root = render('- **Backlog**\n  - Newsletter signup\n- **In progress**\n  - Product pages\n  - Checkout flow');
    const columns = all(root.querySelector('ul') as Element, ':scope > li');
    expect(columns).toHaveLength(2);
    expect(all(columns[1] as Element, 'ul > li').map(textOf)).toEqual(['Product pages', 'Checkout flow']);
    expect(columns[0]?.querySelector('strong')?.textContent).toBe('Backlog');
  });
});

describe('tables', () => {
  const sample = '| Day | Lunch |\n| --- | --- |\n| Mon | Soup |\n| Tue | *Curry* |';

  it('draws a header and body rows in a wrapper that can scroll sideways', () => {
    const root = render(sample);
    const wrap = root.querySelector('div.md-table-wrap') as Element;
    expect(wrap.querySelector('table.md-table')).not.toBeNull();
    expect(all(wrap, 'thead th').map(textOf)).toEqual(['Day', 'Lunch']);
    expect(all(wrap, 'tbody tr')).toHaveLength(2);
    expect(all(wrap, 'tbody tr:last-child td').map(textOf)).toEqual(['Tue', 'Curry']);
    expect(wrap.querySelector('tbody em')?.textContent).toBe('Curry');
  });

  it('reads \\| as a pipe, also in code, and <br> as a line break', () => {
    const root = render('| a | b |\n| --- | --- |\n| x \\| y | `p\\|q`<br>second |');
    const cells = all(root, 'tbody td');
    expect(textOf(cells[0])).toBe('x | y');
    expect(cells[1]?.querySelector('code')?.textContent).toBe('p|q');
    expect(cells[1]?.querySelectorAll('br')).toHaveLength(1);
    expect(textOf(cells[1])).toBe('p|qsecond');
  });

  it('takes alignment from the delimiter row, and shows empty cells', () => {
    const root = render('| l | c | r |\n| :-- | :-: | --: |\n|   |   |   |');
    expect(all(root, 'thead th').map((c) => c.className)).toEqual(['md-align-left', 'md-align-center', 'md-align-right']);
    expect(all(root, 'tbody td')).toHaveLength(3);
  });

  it('leaves a short row short and drops cells beyond the header', () => {
    const root = render('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |');
    expect(all(root, 'tbody tr').map((r) => r.children.length)).toEqual([1, 2]);
  });

  it('ends at a blank line, and is not a table without a matching delimiter row', () => {
    const root = render(`${sample}\n\n| not | a table |\n| --- |\n\nafter`);
    expect(all(root, 'table')).toHaveLength(1);
    expect(textOf(root)).toContain('| not | a table |');
    expect(textOf(root)).toContain('after');
  });
});

describe('footnotes', () => {
  const doc = 'Text with a note[^c1] and another[^c2], again[^c1], missing[^zz].\n\n[^c1]: **Ann Lee** · 2026-02-12 14:20 UTC\n\n    Do the old URLs need to keep working?\n\n    **Jane Doe** · 2026-02-12 15:02 UTC\n\n    Yes: 301 redirects.\n    📎 [map.pdf](map.pdf)\n\n[^c2]: **Bob** · 2026-02-13 09:00 UTC\n\n    Second note.\n\n[^c9]: **Eve** · 2026-02-14 09:00 UTC\n\n    Nobody refers to this one.';

  it('draws references as small numbers that are not links, and keeps a reference without a note as text', () => {
    const root = render(doc);
    const refs = all(root, 'p sup.md-fnref');
    expect(refs.map(textOf)).toEqual(['1', '2', '1']);
    expect(refs.every((r) => r.tagName === 'SUP' && r.querySelector('a') === null)).toBe(true);
    expect(textOf(root.querySelector('p'))).toContain('missing[^zz].');
  });

  it('lists every note in an ordered section at the end, in the order it is first referred to, the unreferenced last', () => {
    const root = render(doc);
    const section = root.querySelector('div.md-footnotes') as Element;
    expect(section.getAttribute('role')).toBe('doc-endnotes');
    expect(textOf(section.querySelector('.md-footnotes-title'))).toBe('Comments on highlighted text');
    expect(section.nextElementSibling).toBeNull();
    const notes = all(section, 'ol.md-footnote-list > li');
    expect(notes).toHaveLength(3);
    expect(all(notes[0] as Element, '.md-comment-who').map(textOf)).toEqual(['Ann Lee', 'Jane Doe']);
    expect(all(notes[0] as Element, 'p').map(textOf)).toEqual(['Do the old URLs need to keep working?', 'Yes: 301 redirects.📎 map.pdf']);
    expect(all(notes[1] as Element, '.md-comment-who').map(textOf)).toEqual(['Bob']);
    expect(all(notes[2] as Element, '.md-comment-who').map(textOf)).toEqual(['Eve']);
  });

  it('draws no section when there are no notes', () => {
    expect(render('plain[^c1]').querySelector('.md-footnotes')).toBeNull();
  });

  it('keeps a reference inside the emphasis around it', () => {
    const root = render('a **bold[^n]** b\n\n[^n]: **Eve** · 2026-01-01 00:00 UTC\n\n    text');
    expect(textOf(root.querySelector('p strong sup.md-fnref'))).toBe('1');
  });
});

describe('inline text', () => {
  it('resolves a backslash before any ASCII punctuation to that character', () => {
    const root = render('\\*a\\* \\# \\| \\[x\\] \\_ \\< \\& \\~ \\% \\= \\$ \\. \\\\ \\!');
    expect(textOf(root)).toBe('*a* # | [x] _ < & ~ % = $ . \\ !');
    expect(root.querySelector('p')?.children).toHaveLength(0);
    expect(textOf(render('a\\b and \\é'))).toBe('a\\b and \\é');
  });

  it('draws bold, italic and strikethrough, nested in each other', () => {
    const root = render('**b** *i* ~~s~~ **a *b* c** *a **b** c* ~~**x**~~');
    expect(all(root, 'strong').map(textOf)).toEqual(['b', 'a b c', 'b', 'x']);
    expect(all(root, 'em').map(textOf)).toEqual(['i', 'b', 'a b c']);
    expect(all(root, 'del').map(textOf)).toEqual(['s', 'x']);
    expect(root.querySelector('strong > em')?.textContent).toBe('b');
    expect(root.querySelector('em > strong')?.textContent).toBe('b');
    expect(root.querySelector('del > strong')?.textContent).toBe('x');
  });

  it('draws bold italic and a run of italic then bold the way CommonMark does', () => {
    expect(render('***both***').querySelector('em > strong')?.textContent).toBe('both');
    const root = render('*a***b**');
    expect(root.querySelector('p > em')?.textContent).toBe('a');
    expect(root.querySelector('p > strong')?.textContent).toBe('b');
  });

  it('leaves markers that cannot open or close, and unmatched ones, as text', () => {
    expect(textOf(render('2 * 3 * 4 and a ~~ b'))).toBe('2 * 3 * 4 and a ~~ b');
    expect(textOf(render('**unclosed *and ~~this'))).toBe('**unclosed *and ~~this');
    expect(render('snake_case_name and _x_ and ~one~').querySelector('em, del')).toBeNull();
    expect(textOf(render('a ~~~three~~~ b'))).toBe('a ~~~three~~~ b');
  });

  it('draws inline code with any fence length, strips one padding space, and shows unmatched backticks', () => {
    const root = render('`a` and `` a`b `` and ` pad ` and `  ` and ```x``` and `lone and ``also');
    expect(all(root, 'code').map(textOf)).toEqual(['a', 'a`b', 'pad', '  ', 'x']);
    expect(textOf(root)).toContain('`lone and ``also');
    expect(textOf(render('`a *b* <u>c</u>`'))).toBe('a *b* <u>c</u>');
    expect(render('`a *b* <u>c</u>`').querySelector('em, u')).toBeNull();
  });

  it('draws the four tags the exporter writes, and shows every other tag as text', () => {
    const root = render('<u>under</u> x<sup>2</sup> H<sub>2</sub>O line<br>next <U>caps</U> end<br />x');
    expect(all(root, 'u').map(textOf)).toEqual(['under', 'caps']);
    expect(all(root, 'sup,sub').map((e) => `${e.tagName}:${e.textContent}`)).toEqual(['SUP:2', 'SUB:2']);
    expect(root.querySelectorAll('br')).toHaveLength(2);
    const odd = render('<span>x</span> <b>b</b> <script>alert(1)</script> <img src=x onerror=alert(1)> <u>open and <sup>never closed');
    expect(odd.querySelector('span, b, script, img')).toBeNull();
    expect(textOf(odd)).toBe('<span>x</span> <b>b</b> <script>alert(1)</script> <img src=x onerror=alert(1)> <u>open and <sup>never closed');
  });

  it('omits HTML comments', () => {
    expect(textOf(render('before<!-- an empty Quip control -->after'))).toBe('beforeafter');
    expect(textOf(render('a <!-- never closed'))).toBe('a <!-- never closed');
  });

  it('keeps emoji and text in any script untouched', () => {
    const root = render('Привет мир 你好 مرحبا שלום 😀 👩‍👩‍👧 **жирный** *日本語*');
    expect(textOf(root)).toBe('Привет мир 你好 مرحبا שלום 😀 👩‍👩‍👧 жирный 日本語');
    expect(textOf(root.querySelector('strong'))).toBe('жирный');
    expect(textOf(render('**bold**😀 and 😀**bold**').querySelector('strong'))).toBe('bold');
  });
});

describe('links and images', () => {
  it('draws links as inert spans with the decoded destination as a tooltip, never as links', () => {
    const root = render('[Plan](<Projects/Website%20Relaunch/Plan%20(v2).md>) [site](https://example.com/a?b=c) [file](../_attachments/x/doc.pdf) [mail](mailto:a@b.co)');
    const spans = all(root, 'span.md-link');
    expect(spans.map((s) => [s.textContent, s.getAttribute('title'), s.className])).toEqual([
      ['Plan', 'Projects/Website Relaunch/Plan (v2).md', 'md-link md-link-doc'],
      ['site', 'https://example.com/a?b=c', 'md-link md-link-web'],
      ['file', '../_attachments/x/doc.pdf', 'md-link md-link-file'],
      ['mail', 'mailto:a@b.co', 'md-link md-link-web'],
    ]);
    expect(all(root, 'a, [href]')).toHaveLength(0);
    expect(spans.every((s) => s.getAttributeNames().sort().join() === 'class,title')).toBe(true);
  });

  it('recognises a note in the export by a relative address ending in .md, whatever follows it', () => {
    const kinds = ['a.md', '../b/c%20d.md#section', 'x.MD?v=1', 'plain.txt', 'notes.md.pdf'].map((dest) => render(`[t](${dest})`).querySelector('.md-link')?.className);
    expect(kinds).toEqual(['md-link md-link-doc', 'md-link md-link-doc', 'md-link md-link-doc', 'md-link md-link-file', 'md-link md-link-file']);
  });

  it('keeps emphasis, code and escapes inside link text', () => {
    const root = render('[**bold** and `code` and \\[x\\]](https://example.com)');
    const link = root.querySelector('.md-link') as Element;
    expect(link.textContent).toBe('bold and code and [x]');
    expect(link.querySelector('strong')?.textContent).toBe('bold');
    expect(link.querySelector('code')?.textContent).toBe('code');
  });

  it('draws autolinks with the address as the text', () => {
    const root = render('<https://example.com/videos/tram-28> and <mailto:a@b.co> and <baker@example.com> and <not a link> and <x>');
    const spans = all(root, 'span.md-link');
    expect(spans.map(textOf)).toEqual(['https://example.com/videos/tram-28', 'mailto:a@b.co', 'baker@example.com']);
    expect(spans.map((s) => s.getAttribute('title'))).toEqual(['https://example.com/videos/tram-28', 'mailto:a@b.co', 'mailto:baker@example.com']);
    expect(textOf(root)).toContain('<not a link> and <x>');
  });

  it('shows text for a link whose destination does not close or whose text is empty', () => {
    expect(textOf(render('[a](b and [c](d'))).toBe('[a](b and [c](d');
    expect(textOf(render('[a] [b][c] [d]()'))).toBe('[a] [b][c] d');
    expect(render('[](x.md)').querySelector('.md-link')?.textContent).toBe('x.md');
  });

  it('draws an image as a card with the description and the file name, and never as an image', () => {
    const root = render('![Architecture diagram](../../../_attachments/RELAUNCHpl1/IMG%20arch.png)');
    const card = root.querySelector('span.md-image') as Element;
    expect(card.getAttribute('role')).toBe('img');
    expect(card.getAttribute('aria-label')).toBe('Architecture diagram');
    expect(textOf(card.querySelector('.md-image-alt'))).toBe('Architecture diagram');
    expect(textOf(card.querySelector('.md-image-file'))).toBe('IMG arch.png');
    expect(textOf(card.querySelector('.md-image-icon'))).toContain('\u{1F5BC}');
    expect(root.querySelector('img')).toBeNull();
  });

  it('names no file for a data or script address, and says "Image" when there is no description', () => {
    const root = render('![](data:image/png;base64,AAAA) ![x](javascript:alert(1)) ![y](https://example.com/p/pic.jpg?s=1)');
    const cards = all(root, 'span.md-image');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Image', 'x', 'y']);
    expect(cards.map((c) => c.querySelector('.md-image-file')?.textContent ?? null)).toEqual([null, null, 'pic.jpg']);
  });

  it('draws the placeholder a preview writes for a left-out image as the same card', () => {
    const root = render('*[image: Wireframe \\[v2\\]]*\n\n*[image]*\n\n*[missing image: gone.png]*\n\n*[image of cats]* stays italic');
    const cards = all(root, 'span.md-image');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Wireframe [v2]', 'Image', 'gone.png']);
    expect(root.querySelectorAll('.md-image-file')).toHaveLength(0);
    expect(textOf(all(root, 'em')[0])).toBe('[image of cats]');
  });
});

describe('the details at the top of a note', () => {
  const note = [
    '---',
    'title: "Website Relaunch: Project Plan"',
    'quip_id: "RELAUNCHpl1"',
    'quip_url: "https://acme.quip.com/RELAUNCHpl1"',
    'quip_type: "document"',
    'created: "2026-02-02T09:00:00.000Z"',
    'updated: "2026-03-05T17:30:00.000Z"',
    'author: "Jane Doe"',
    'folder: "Private/Projects/Website Relaunch"',
    'also_in:',
    '  - "Desktop"',
    'embeds:',
    '  - "calendar"',
    '  - "kanban"',
    '  - "project_tracker"',
    'exported: "2026-03-06T09:30:00.000Z"',
    'exporter: "Quipendo 0.1.0"',
    '---',
    '',
    '# Website Relaunch: Project Plan',
    '',
    'Body text.',
  ].join('\n');

  it('shows who and when, a chip for each embed, and folds everything else into a closed details element', () => {
    const root = render(note);
    expect(Array.from(root.children).map((c) => c.tagName.toLowerCase() + (c.className ? `.${c.className}` : ''))).toEqual(['h1', 'div.md-meta', 'p']);
    expect(textOf(root.querySelector('.md-meta-author'))).toBe('Jane Doe');
    expect(all(root, '.md-meta-date').map(textOf)).toEqual(['Created 2026-02-02', 'Updated 2026-03-05']);
    expect(root.querySelector('.md-meta-date')?.getAttribute('title')).toBe('2026-02-02T09:00:00.000Z');
    expect(all(root, '.md-chips .md-chip').map(textOf)).toEqual(['Calendar', 'Kanban board', 'Project tracker']);
    expect(all(root, '.md-chip').map((c) => c.className)).toEqual(['md-chip md-chip-calendar', 'md-chip md-chip-kanban', 'md-chip md-chip-project-tracker']);
    const details = root.querySelector('details.md-front') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(textOf(details.querySelector('summary'))).toBe('Document details');
    expect(all(details, 'dl > dt').map(textOf)).toEqual(['title', 'quip_id', 'quip_url', 'quip_type', 'created', 'updated', 'author', 'folder', 'also_in', 'embeds', 'exported', 'exporter']);
    expect(all(details, 'dl > dd').map(textOf)[0]).toBe('Website Relaunch: Project Plan');
    expect(all(details, 'dl > dd')[8]?.querySelector('.md-front-item')?.textContent).toBe('Desktop');
  });

  it('never shows the YAML itself', () => {
    const root = render(note);
    expect(textOf(root)).not.toContain('quip_id:');
    expect(textOf(root)).not.toContain('---');
    expect(root.querySelector('hr')).toBeNull();
  });

  it('reads JSON escapes in a value, and shows markup in a value as text', () => {
    const root = render('---\ntitle: "A \\"quoted\\" \\\\ caf\\u00e9"\nauthor: "<script>alert(1)</script>"\n---\n\nbody');
    expect(textOf(root.querySelector('.md-meta-title'))).toBe('A "quoted" \\ café');
    expect(textOf(root.querySelector('.md-meta-author'))).toBe('<script>alert(1)</script>');
    expect(root.querySelector('script')).toBeNull();
  });

  it('gives the note a title of its own when the text has no first heading', () => {
    expect(render('---\ntitle: "Only a title"\n---\n\nbody').querySelector('h1.md-meta-title')?.textContent).toBe('Only a title');
    expect(render('---\ntitle: "Only a title"\n---\n\n## Not first level').querySelector('h1.md-meta-title')?.textContent).toBe('Only a title');
    expect(render(note).querySelector('.md-meta-title')).toBeNull();
  });

  it('treats a leading --- as a rule unless what follows is all keys and values', () => {
    expect(all(render('---\n\ntext\n\n---\n\nmore'), 'hr')).toHaveLength(2);
    expect(render('---\nnot: yaml\nbut this line is prose\n---').querySelector('.md-meta')).toBeNull();
    expect(render('---\n---\n\ntext').querySelector('.md-meta')).toBeNull();
    expect(render('---\ntitle: "never closed"\n\ntext').querySelector('.md-meta')).toBeNull();
  });
});

describe('long documents', () => {
  it('cuts a document longer than 400 000 characters, and says the rest is not shown', () => {
    const root = render(`# Start\n\n${'a'.repeat(400_100)}`);
    const notice = root.querySelector('p.md-notice') as Element;
    expect(notice.textContent).toMatch(/400,000/);
    expect(notice.textContent).toMatch(/not shown/);
    expect(notice.textContent).toMatch(/Markdown tab/);
    expect(root.querySelector('h1')?.textContent).toBe('Start');
    expect(textOf(all(root, 'p')[0]).length).toBe(400_000 - '# Start\n\n'.length);
  });

  it('shows no notice for a document that fits', () => {
    expect(render(`${'a'.repeat(399_000)}`).querySelector('.md-notice')).toBeNull();
  });
});

/** Tags and attributes the preview may ever produce; anything else in the output is a bug. */
const TAGS = new Set('div span p h1 h2 h3 h4 h5 h6 hr br pre code blockquote ul ol li input table thead tbody tr th td em strong del u sup sub details summary dl dt dd'.split(' '));
const ATTRIBUTES = new Set(['class', 'title', 'role', 'aria-label', 'aria-level', 'aria-hidden', 'start', 'type', 'disabled', 'checked']);
const FORBIDDEN = 'img, a, script, iframe, link, object, embed, video, audio, form, style, svg, canvas, base, meta, [style], [src], [srcset], [href], [action], [formaction], [data]';

/**
 * Visits every element of a tree, `top` first, with its depth. It follows first-child and next-sibling links on purpose: jsdom's
 * `children` and `getElementsByTagName` look an item up by walking the parent, so using them on a paragraph of 100 000 children
 * takes quadratic time (minutes), while this is linear.
 */
function walk(top: Element, visit: (el: Element, depth: number) => void): void {
  let el: Element = top;
  let depth = 1;
  for (;;) {
    visit(el, depth);
    if (el.firstElementChild) {
      el = el.firstElementChild;
      depth += 1;
      continue;
    }
    while (el !== top && !el.nextElementSibling) {
      el = el.parentElement as Element;
      depth -= 1;
    }
    if (el === top) return;
    el = el.nextElementSibling as Element;
  }
}

/** Everything that must never be in the output, as a list of what was found (empty when the output is inert). */
function offenders(root: Element): string[] {
  const found: string[] = [];
  walk(root, (el) => {
    if (found.length >= 5) return;
    if (!TAGS.has(el.tagName.toLowerCase())) found.push(`tag ${el.tagName}`);
    for (const name of el.getAttributeNames()) {
      if (!ATTRIBUTES.has(name) || name.startsWith('on')) found.push(`${el.tagName} attribute ${name}`);
    }
    if (el.tagName === 'INPUT' && (el.getAttribute('type') !== 'checkbox' || !el.hasAttribute('disabled'))) found.push('input that is not a disabled checkbox');
  });
  return found;
}

/** The allow-list check, plus the named elements and attributes from the brief (a selector search is slow on a big tree, so only small ones). */
function expectInert(root: Element): void {
  expect(offenders(root)).toEqual([]);
  let count = 0;
  walk(root, () => (count += 1));
  if (count < 2000) expect(root.querySelector(FORBIDDEN)?.outerHTML).toBeUndefined();
}

function depthOf(root: Element): number {
  let max = 0;
  walk(root, (_el, depth) => (max = Math.max(max, depth)));
  return max;
}

const SAMPLES = join(__dirname, '../../examples/sample-output');
const sampleFiles = (readdirSync(SAMPLES, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).sort();
const sourceOf = (file: string): string => readFileSync(join(SAMPLES, file), 'utf8');
const unescapeMd = (s: string): string => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

function sourceHeadings(md: string): Array<{ level: number; text: string }> {
  const found: Array<{ level: number; text: string }> = [];
  let fenced = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6}) (.+)$/.exec(line);
    if (m) found.push({ level: (m[1] as string).length, text: unescapeMd(m[2] as string) });
  }
  return found;
}

describe('the sample output', () => {
  it('has notes to draw', () => {
    expect(sampleFiles.length).toBeGreaterThanOrEqual(10);
    expect(sampleFiles).toContain('_Index.md');
    expect(sampleFiles).toContain('_Quip export report.md');
  });

  describe.each(sampleFiles)('%s', (file) => {
    const md = sourceOf(file);
    const root = render(md);

    it('draws without a script, image, link, style or event handler anywhere', () => {
      expectInert(root);
      expect(root.querySelector('.md-notice')).toBeNull();
    });

    it('draws every heading line as a heading of that level with the same text', () => {
      const drawn = all(root, 'h1,h2,h3,h4,h5,h6').map((h) => `${h.tagName.toLowerCase()}:${h.textContent}`);
      for (const h of sourceHeadings(md)) expect(drawn, h.text).toContain(`h${h.level}:${h.text}`);
    });

    it('draws as many table rows as the note has, and as many task checkboxes', () => {
      const sourceRows = md.split('\n').filter((l) => l.startsWith('|') && !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(l)).length;
      expect(root.querySelectorAll('tr')).toHaveLength(sourceRows);
      expect(root.querySelectorAll('input[type=checkbox]')).toHaveLength((md.match(/^\s*- \[[ xX]\]/gm) ?? []).length);
    });

    it('shows the label of every calendar, board and tracker as text', () => {
      for (const label of ['Calendar', 'Kanban board', 'Project tracker']) {
        const wanted = md.split(`**${label}**`).length - 1;
        expect(all(root, 'strong').filter((s) => s.textContent === label), label).toHaveLength(wanted);
      }
    });

    it('leaves no Markdown syntax showing', () => {
      const shown = root.textContent ?? '';
      expect(shown).not.toMatch(/\*\*|\]\(|<!--|\[\^c\d|^---$|^\|/m);
    });

    it('draws one message for each comment, and one numbered note for each footnote, in the order they come', () => {
      const text = md.replace(/^---\n[\s\S]*?\n---\n/, '');
      const who = [...text.matchAll(/^> \*\*(.+?)\*\* · \d{4}-\d{2}-\d{2} /gm)].map((m) => unescapeMd(m[1] as string));
      expect(all(root, 'blockquote.md-comment .md-comment-who').map(textOf)).toEqual(who);
      const definitions = (text.match(/^\[\^[^\]]+\]:/gm) ?? []).length;
      expect(root.querySelectorAll('li.md-footnote')).toHaveLength(definitions);
      expect(root.querySelectorAll('.md-footnotes')).toHaveLength(definitions > 0 ? 1 : 0);
      const references = text
        .split('\n')
        .filter((l) => !l.startsWith('[^') && !l.startsWith('    '))
        .reduce((n, l) => n + (l.match(/\[\^[^\]]+\]/g) ?? []).length, 0);
      expect(all(root, 'sup.md-fnref').map(textOf)).toEqual(Array.from({ length: references }, (_, i) => String(i + 1)));
    });

    it('draws a card for each image, a chip for each embed and a block for each fenced code', () => {
      const text = md.replace(/^---\n[\s\S]*?\n---\n/, '');
      const files = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => decodeURIComponent((m[1] as string).slice((m[1] as string).lastIndexOf('/') + 1)));
      expect(all(root, 'span.md-image .md-image-file').map(textOf)).toEqual(files);
      expect(root.querySelectorAll('span.md-image')).toHaveLength(files.length);
      const embeds = /^embeds:\n((?:  - ".*"\n)+)/m.exec(md)?.[1]?.split('\n').filter(Boolean).length ?? 0;
      expect(root.querySelectorAll('.md-chips .md-chip')).toHaveLength(embeds);
      const fences = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
      expect(all(root, 'pre > code').map(textOf)).toEqual(fences);
    });

    it('draws every link as exactly one inert span, by what it points at', () => {
      const text = md.replace(/^---\n[\s\S]*?\n---\n/, '');
      const dests = [...text.matchAll(/(?<!!)\[[^\]]*\]\((?:<([^>]*)>|([^)\s]*))\)/g)].map((m) => (m[1] ?? m[2]) as string);
      const autolinks = [...text.matchAll(/<((?:https?|mailto):[^>\s]+)>/g)].map((m) => m[1] as string);
      const kindOf = (dest: string): string => (/^(?:https?|mailto):/.test(dest) ? 'web' : /\.md(?:[?#].*)?$/i.test(decodeURIComponent(dest)) ? 'doc' : 'file');
      const wanted = [...dests, ...autolinks].map(kindOf);
      const drawn = all(root, 'span.md-link');
      const kinds = (list: string[]): Record<string, number> => list.reduce<Record<string, number>>((n, k) => ({ ...n, [k]: (n[k] ?? 0) + 1 }), {});
      expect(kinds(drawn.map((s) => /md-link-(\w+)/.exec(s.className)?.[1] ?? ''))).toEqual(kinds(wanted));
      for (const dest of [...dests, ...autolinks]) expect(drawn.map((s) => s.getAttribute('title')), dest).toContain(decodeURIComponent(dest));
    });
  });
});

describe('hostile text', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">click</a>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](  javascript:alert(1)  "title")',
    '![x](javascript:alert(1))',
    '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
    '![x](https://evil.example/pixel.png)',
    '![x](//evil.example/pixel.png)',
    '[x](data:text/html,<script>alert(1)</script>)',
    '<javascript:alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg onload=alert(1)></svg>',
    '<style>body { display: none }</style>',
    '<form action=https://evil.example><input name=x></form>',
    '<link rel=stylesheet href=https://evil.example/x.css>',
    '<base href=https://evil.example/>',
    '<object data=x></object><embed src=x><video src=x></video><audio src=x></audio>',
    '<u onclick=alert(1)>x</u> <br onclick=alert(1)> <sup style="x">y</sup>',
    '| <script> | <img src=x onerror=1> |\n| --- | --- |\n| <a href=x>y</a> | <iframe> |',
    '# <script>alert(1)</script>',
    '- <img src=x onerror=alert(1)>\n- [ ] <svg onload=1>',
    '> <svg onload=alert(1)>',
    '> **<img src=x onerror=1>** · 2026-01-01 10:00 UTC\n> text',
    '```<script>\n<script>alert(1)</script>\n```',
    '`<script>alert(1)</script>`',
    '[^x]: <script>alert(1)</script>\n\ntext[^x]',
    '---\ntitle: "<script>alert(1)</script>"\nembeds:\n  - "<img src=x onerror=1>"\n  - "a b\\"c"\n---\n\n# t',
    '![<img src=x onerror=alert(1)>](x.png "title")',
    '[<script>](x)',
    '[x](<javascript:alert(1)>)',
    '&lt;script&gt;alert(1)&lt;/script&gt; &#60;img src=x&#62;',
    '<!-- --><script>alert(1)</script>',
    '*[image: <img src=x onerror=1>]*',
    '> [!<script>] <img src=x>\n> body',
    '\u0000<script>\u0000alert(1)</script>',
  ];

  it.each(hostile)('draws %j as inert text', (md) => {
    expectInert(render(md));
  });

  it('shows raw HTML as the text it is', () => {
    const root = render('<script>alert(1)</script> and <img src=x onerror=alert(1)> and <a href="x">y</a>');
    expect(root.textContent).toBe('<script>alert(1)</script> and <img src=x onerror=alert(1)> and <a href="x">y</a>');
    expect(render('# <b>x</b>').querySelector('h1')?.textContent).toBe('<b>x</b>');
    expect(render('&lt;b&gt; &amp; &#60;').textContent).toBe('&lt;b&gt; &amp; &#60;');
  });

  it('keeps a script address visible as a tooltip and marks it, without making it a link', () => {
    const root = render('[click](javascript:alert(1)) and [safe](https://example.com)');
    const [bad, good] = all(root, 'span.md-link');
    expect(bad?.getAttribute('title')).toBe('javascript:alert(1)');
    expect(bad?.classList.contains('md-link-unsafe')).toBe(true);
    expect(good?.classList.contains('md-link-unsafe')).toBe(false);
    expect(all(root, 'a, [href]')).toHaveLength(0);
  });

  it('never draws an image from an address, whatever it is', () => {
    const root = render('![a](https://evil.example/a.png) ![b](data:image/png;base64,AAAA) ![c](/local/c.png) ![d](<x y.png>)');
    expect(all(root, 'span.md-image')).toHaveLength(4);
    expectInert(root);
  });

  it('puts nothing but text into attribute values that come from the note', () => {
    const root = render('[a"b<c>](x"y<z>) ![q"<r>](s)');
    for (const el of all(root, '[title], [aria-label]')) expect(el.children.length === 0 || el.getAttribute('class')?.startsWith('md-image') === true).toBe(true);
    expectInert(root);
  });
});

describe('text that cannot be a document', () => {
  it('draws an empty string, whitespace and binary-looking junk without throwing', () => {
    expect(render('').childNodes).toHaveLength(0);
    expect(render(' \n\t\n  \r\n').childNodes).toHaveLength(0);
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let round = 0; round < 20; round += 1) {
      let junk = '';
      for (let i = 0; i < 5000; i += 1) junk += String.fromCharCode(next() % 0x10000);
      expectInert(render(junk));
    }
  });

  it('draws unterminated constructs as text', () => {
    for (const md of ['```js\nnever closed', '**never closed', '*', '**', '~~', '`', '[', ']', '![', '[a](', '[a](b', '<', '<!--', '[^', '[^c1', '| a |\n| --- |\n| b', '> ', '-', '1.', '- [ ]', '---\ntitle: "x', '#', '\\']) {
      const root = render(md);
      expectInert(root);
      expect(root.textContent, md).not.toBeNull();
    }
    expect(textOf(render('```js\nnever closed'))).toBe('never closed');
    expect(textOf(render('| a | b |\n| --- | --- |'))).toBe('ab');
  });

  it('draws the same thing every time', () => {
    const md = readFileSync(join(SAMPLES, 'Team Shared/Team Handbook.md'), 'utf8');
    expect(render(md).innerHTML).toBe(render(md).innerHTML);
  });

  it('survives random mixtures of Markdown characters', () => {
    let seed = 987654321;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const pieces = ['*', '**', '***', '~~', '_', '`', '``', '[', ']', '![', '(', ')', '<', '>', '<u>', '</u>', '<sup>', '</sup>', '<br>', '<!--', '-->', '\\', '|', ' | ', '| --- |', '\n', '\n\n', '\n> ', '\n- ', '\n1. ', '\n    ', '\n```', '\n---', '# ', '\n## ', '[^c1]', '\n[^c1]: ', '  \n', 'text', ' word ', 'é', '😀', '&amp;', '<https://x.y>', '[x](y)', '- [ ] ', '- [x] '];
    for (let round = 0; round < 1500; round += 1) {
      let md = '';
      for (let i = next(60); i >= 0; i -= 1) md += pieces[next(pieces.length)] as string;
      expect(offenders(render(md)), JSON.stringify(md)).toEqual([]);
    }
  });

  it('keeps going, with a notice, when the page refuses to build part of the document', () => {
    const refusing = new Proxy(document, {
      get(target, prop) {
        if (prop === 'createElement') {
          return (tag: string) => {
            if (tag === 'table') throw new Error('refused');
            return target.createElement(tag);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Document;
    const root = renderMarkdownPreview('| a |\n| - |\n| b |', refusing);
    expect(root.className).toBe('md-preview');
    expect(root.textContent).toMatch(/could not be drawn/);
  });
});

describe('pathological text', () => {
  /** Characters of text that is hard to parse but draws little. */
  const N = 200_000;
  /** Characters of text that draws a lot: jsdom needs about a second for 100 000 elements, so these are kept smaller. */
  const H = 50_000;
  const cases: Array<[string, string]> = [
    ['stars', '*'.repeat(N)],
    ['stars and words', '*a '.repeat(N / 3)],
    ['nested emphasis', `${'*a '.repeat(N / 12)}b${' a*'.repeat(N / 12)}`],
    ['nested bold and italic', `${'**a *b '.repeat(N / 24)}c${' b* a**'.repeat(N / 24)}`],
    ['mixed runs', '*a**b***c'.repeat(H / 9)],
    ['strikethrough', '~~a '.repeat(N / 4)],
    ['nested tags', `${'<u>'.repeat(N / 8)}x${'</u>'.repeat(N / 8)}`],
    ['unclosed tags', '<sup>a<sub>b'.repeat(N / 12)],
    ['open brackets', '['.repeat(N)],
    ['close brackets', ']'.repeat(N)],
    ['empty links', '[a]()'.repeat(H / 5)],
    ['unclosed links', '[a](b'.repeat(N / 5)],
    ['unclosed link destinations', '[a](<b'.repeat(N / 6)],
    ['nested parentheses', `[a](${'('.repeat(N)}`],
    ['images', '![a](b)'.repeat(H / 7)],
    ['image placeholders', '*[image: '.repeat(N / 9)],
    ['footnote references', '[^c1]'.repeat(N / 5)],
    ['backticks', '`'.repeat(N)],
    ['backtick runs', '` `` ``` ```` ``````'.repeat(N / 20)],
    ['alternating backticks', '`a'.repeat(H / 2)],
    ['backslashes', '\\'.repeat(N)],
    ['backslash and backtick', '\\``'.repeat(N / 3)],
    ['angle brackets', '<'.repeat(N)],
    ['unclosed comments', '<!--'.repeat(N / 4)],
    ['autolink starts', '<a:b'.repeat(N / 4)],
    ['one long line', 'word '.repeat(N / 5)],
    ['many short lines', 'a\n'.repeat(H / 2)],
    ['blank lines', '\n'.repeat(N)],
    ['nested quotes on one line', '> '.repeat(N / 2)],
    ['nested quotes over lines', '> a\n'.repeat(H / 4)],
    ['staircase of lists', Array.from({ length: 400 }, (_, i) => `${' '.repeat(2 * i)}- item ${i}`).join('\n')],
    ['lists of lists', '- '.repeat(N / 2)],
    ['numbered lists', '1. '.repeat(N / 3)],
    ['many list items', '- a\n'.repeat(H / 4)],
    ['task items', '- [ ] a\n'.repeat(H / 8)],
    ['fence openers', '```a\n'.repeat(N / 5)],
    ['unclosed fence', `\`\`\`\n${'code line\n'.repeat(N / 10)}`],
    ['headings', '# h\n'.repeat(H / 4)],
    ['rules', '---\n'.repeat(H / 4)],
    ['footnote definitions', '[^a]: x\n\n    y\n\n'.repeat(N / 17)],
    ['pipes', '|'.repeat(N)],
    ['wide table', `${'| h '.repeat(H / 4)}|\n${'| - '.repeat(H / 4)}|\n`],
    ['many table rows', `| a | b |\n| - | - |\n${'| x | y |\n'.repeat(H / 10)}`],
    ['escaped pipes', `| a |\n| - |\n| ${'\\|'.repeat(N / 2)} |`],
    ['table delimiters', '| - '.repeat(N / 4)],
    ['callouts', '> [!x]\n> [!x]\n'.repeat(H / 15)],
    ['comment headers', '> **A** · 2026-01-01 10:00 UTC\n> hi\n\n'.repeat(H / 40)],
  ];

  it.each(cases)('draws %s in well under two seconds', (_name, md) => {
    expect(md.length).toBeLessThanOrEqual(N + 20);
    const started = performance.now();
    const root = render(md);
    const took = performance.now() - started;
    expect(took).toBeLessThan(2000);
    expect(depthOf(root)).toBeLessThan(80);
    expect(offenders(root)).toEqual([]);
  });

  it('cuts one million characters of markers at 400 000 and still says so', () => {
    const started = performance.now();
    const root = render('*'.repeat(1_000_000));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(root.querySelector('p.md-notice')?.textContent).toMatch(/not shown/);
  });

  it('stops drawing, and says so, when a document would need more elements than the page should build', () => {
    const columns = 200;
    const row = `${'|a'.repeat(columns)}|\n`;
    const started = performance.now();
    const root = render(`${'|h'.repeat(columns)}|\n${'|-'.repeat(columns)}|\n${row.repeat(900)}`);
    expect(performance.now() - started).toBeLessThan(3000);
    const notices = all(root, 'p.md-notice').map(textOf);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/too large/);
    expect(notices[0]).toMatch(/Markdown tab/);
    const cells = root.querySelectorAll('td').length;
    expect(cells).toBeGreaterThan(50_000);
    expect(cells).toBeLessThan(900 * columns);
  });

  it('draws nesting no deeper than the limits, and keeps the text of what it flattens', () => {
    const quotes = render(`${'> '.repeat(3000)}deep text`);
    expect(depthOf(quotes)).toBeLessThan(40);
    expect(quotes.textContent).toContain('deep text');
    const lists = render(Array.from({ length: 300 }, (_, i) => `${' '.repeat(2 * i)}- level ${i}`).join('\n'));
    expect(depthOf(lists)).toBeLessThan(60);
    expect(lists.textContent).toContain('level 299');
    const emphasis = render(`${'*a '.repeat(500)}core${' a*'.repeat(500)}`);
    expect(depthOf(emphasis)).toBeLessThan(40);
    expect(emphasis.textContent).toContain('core');
    const tags = render(`${'<u>'.repeat(2000)}core${'</u>'.repeat(2000)}`);
    expect(depthOf(tags)).toBeLessThan(40);
    expect(tags.textContent).toContain('core');
  });
});

describe('text the exporter escapes', () => {
  // The preview has to show back exactly what the exporter's own escaping was given, for any text.
  const pieces = ['a', 'b', 'Z', '0', '1', ' ', ' ', '*', '_', '`', '[', ']', '(', ')', '<', '>', '&', '~', '%', '=', '$', '#', '-', '+', '.', '!', '|', ':', '^', '{', '}', '@', '"', "'", '/', '?', ',', ';', 'é', '日', '😀', '<u>', '<br>', '&amp;', '[^c1]', '![x](y)', '1. ', '2) ', '- ', '# ', '> ', '---', '***', '~~', '==', '%%', '[[', ']]', '$$', '\\*', '\\', '\\\\', '`code`', '<https://x.y>', '<!--', '-->', '<script>', '</u>', '[x](y)', '[!note]', '|'];
  let seed = 424242;
  const pick = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % n;
  };
  const randomText = (): string => {
    let text = '';
    for (let n = 1 + pick(12); n > 0; n -= 1) text += pieces[pick(pieces.length)];
    return text.replace(/\s+/g, ' ').trim();
  };
  const texts = Array.from({ length: 4000 }, randomText).filter((t) => t !== '');

  /** The paragraph-like element a single block of text is drawn as, and whether it drew nothing but that text. */
  const plain = (root: Element, selector: string): string | null => {
    const holder = root.querySelector(selector);
    return holder && holder.children.length === 0 ? holder.textContent : null;
  };

  it('draws escaped text, in a paragraph, a list item and a quote, as the text it was', () => {
    for (const t of texts) {
      const md = escapeBlockStart(escapeInline(t));
      // The exporter leaves a lone "-", "+" or "1." as it is, and every CommonMark reader takes that for an empty list item.
      if (/^(?:[-+]|\d+[.)])$/.test(md)) continue;
      expect(plain(render(md), 'p'), JSON.stringify(md)).toBe(t);
      expect(plain(render(`- ${md}`), 'li'), JSON.stringify(`- ${md}`)).toBe(t);
      expect(plain(render(`> ${md}`), 'blockquote > p'), JSON.stringify(`> ${md}`)).toBe(t);
    }
  });

  it('draws escaped text in a table cell as the text it was, pipes included', () => {
    for (const t of texts) {
      const md = `| h |\n| --- |\n| ${escapeInline(t).replace(/\|/g, '\\|')} |`;
      expect(plain(render(md), 'tbody td'), JSON.stringify(md)).toBe(t);
      expect(render(md).querySelectorAll('tbody td'), JSON.stringify(md)).toHaveLength(1);
    }
  });

  it('draws what codeSpan writes as code with the same text', () => {
    for (const t of texts) {
      const md = codeSpan(t);
      const root = render(md);
      expect(all(root, 'code').map(textOf), JSON.stringify(md)).toEqual([t]);
      expect(root.querySelector('p')?.children, JSON.stringify(md)).toHaveLength(1);
    }
  });

  it('draws what fencedBlock writes as one block of code with the same text', () => {
    for (const t of texts) {
      const body = `${t}\n  ${t}\n\n${t}`;
      const root = render(fencedBlock(body, 'txt'));
      expect(all(root, 'pre > code').map(textOf), JSON.stringify(body)).toEqual([body]);
      expect(root.children).toHaveLength(1);
    }
  });

  it('draws what linkDest writes as a link whose tooltip is the address', () => {
    for (const t of texts) {
      const url = t.replace(/[%\\]/g, '');
      if (url === '') continue;
      const root = render(`[label](${linkDest(url)})`);
      expect(all(root, 'span.md-link').map((s) => s.getAttribute('title')), JSON.stringify(url)).toEqual([url]);
      expect(textOf(root.querySelector('p'))).toBe('label');
    }
  });

  it('keeps a front matter value as written, whatever characters it has', () => {
    for (const t of texts.slice(0, 500)) {
      const root = render(`---\ntitle: ${yamlString(t)}\nauthor: ${yamlString(t)}\n---\n\nbody`);
      expect(textOf(root.querySelector('.md-meta-author')), JSON.stringify(t)).toBe(t);
      expect(textOf(root.querySelector('h1.md-meta-title')), JSON.stringify(t)).toBe(t);
    }
  });
});

describe('the module itself', () => {
  const source = readFileSync(join(__dirname, '../../src/ui/markdownPreview.ts'), 'utf8');

  it('never parses HTML, writes markup, evaluates text, or touches the network', () => {
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'DOMParser', 'document.write', 'eval(', 'new Function', '.href', '.src', "setAttribute('href'", "setAttribute('src'", "setAttribute('style'", 'setAttribute("href"', 'setAttribute("src"', 'setAttribute("style"', 'fetch(', 'XMLHttpRequest']) {
      expect(source, banned).not.toContain(banned);
    }
  });

  it('imports nothing, so no sanitiser or parser can be in it', () => {
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it('exports only the one function', () => {
    expect(Array.from(source.matchAll(/^export\s+(\w+)\s+(\w+)/gm)).map((m) => `${m[1]} ${m[2]}`)).toEqual(['function renderMarkdownPreview']);
  });
});
