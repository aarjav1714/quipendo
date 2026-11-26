/**
 * Draws the Markdown the exporter writes as a read-only document.
 *
 * Everything on screen is built from text nodes and a short list of plain elements. Nothing in the Markdown is ever parsed as
 * HTML or turned into a link, an image or a request, so a document written by someone else cannot act on the page that shows
 * it: raw HTML is shown as the text it is, links are inert, and images are placeholders.
 */

/** A longer note is cut here, and the preview says so. */
const MAX_CHARS = 400_000;
/** Elements and text nodes one preview may create, so that no note can make the page build millions of them. */
const MAX_NODES = 200_000;
/** Quotes and lists inside quotes and lists; anything deeper is shown as the text it is. */
const MAX_BLOCK_DEPTH = 16;
/** Emphasis, links and tags inside each other; anything deeper is shown without its styling. */
const MAX_INLINE_DEPTH = 24;

// ---- the tree

type Align = 'left' | 'center' | 'right' | null;

interface TextRun {
  t: 'text';
  v: string;
}

type Inline =
  | TextRun
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'em' | 'strong' | 'del' | 'u' | 'sup' | 'sub'; c: Inline[] }
  | { t: 'link'; c: Inline[]; dest: string }
  | { t: 'image'; alt: string; dest: string }
  | { t: 'fnref'; label: string };

interface Item {
  task: 'open' | 'done' | null;
  c: Block[];
}

interface Callout {
  kind: string;
  title: Inline[];
}

type Block =
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'hr' }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[]; comment: boolean; callout: Callout | null }
  | { t: 'list'; ordered: boolean; start: number; items: Item[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'chead'; who: string; when: string; note: boolean };

// ---- small helpers

const isPunct = (c: number): boolean => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\u2026` : s);
const cleanText = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ');
/** Backslash escapes resolved, nothing else. */
const unescapeMd = (s: string): string => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function plainText(nodes: readonly Inline[]): string {
  // Walks with its own stack: emphasis can be nested as deep as the text allows.
  let out = '';
  const stack: Inline[] = [];
  for (let k = nodes.length - 1; k >= 0; k -= 1) stack.push(nodes[k] as Inline);
  while (stack.length > 0) {
    const n = stack.pop() as Inline;
    if (n.t === 'text' || n.t === 'code') out += n.v;
    else if (n.t === 'br') out += ' ';
    else if (n.t === 'image') out += n.alt;
    else if (n.t !== 'fnref') for (let k = n.c.length - 1; k >= 0; k -= 1) stack.push(n.c[k] as Inline);
  }
  return out;
}

const WS = /^\s$/u;
const PUNCT = /^[\p{P}\p{S}]$/u;

/** The code point that ends just before `i`. */
function charBefore(s: string, i: number): string {
  if (i <= 0) return '';
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 2, i);
  }
  return s.charAt(i - 1);
}

/** The code point that starts at `i`. */
function charAfter(s: string, i: number): string {
  const high = s.charCodeAt(i);
  if (high >= 0xd800 && high <= 0xdbff) {
    const low = s.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return s.slice(i, i + 2);
  }
  return s.charAt(i);
}

/** CommonMark's left- and right-flanking rules: whether a run of markers can open or close emphasis. */
function flanks(before: string, after: string): { open: boolean; close: boolean } {
  const spaceBefore = before === '' || WS.test(before);
  const spaceAfter = after === '' || WS.test(after);
  const punctBefore = !spaceBefore && PUNCT.test(before);
  const punctAfter = !spaceAfter && PUNCT.test(after);
  return {
    open: !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
    close: !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
  };
}

// ---- inline parser

type Wrap = 'em' | 'strong' | 'del' | 'u' | 'sup' | 'sub';
type DelimKind = '*' | '~' | 'u' | 'sup' | 'sub';

interface Tok {
  prev: Tok | null;
  next: Tok | null;
  node: Inline;
}

interface Delim {
  prev: Delim | null;
  next: Delim | null;
  tok: Tok;
  kind: DelimKind;
  count: number;
  orig: number;
  open: boolean;
  close: boolean;
}

interface Bracket {
  prev: Bracket | null;
  tok: Tok;
  image: boolean;
  /** Top of the delimiter stack when the bracket was opened: what is above it belongs to the link text. */
  delim: Delim | null;
}

interface Runs {
  pos: number[];
  len: number[];
  /** For each run of backticks, the next run of the same length (what closes a code span), or -1. */
  next: Int32Array;
}

const SPECIAL = new Uint8Array(128);
for (const ch of '\\`*~[]!<\n') SPECIAL[ch.charCodeAt(0)] = 1;
const isSpecial = (c: number): boolean => c < 128 && SPECIAL[c] === 1;

const TAGS: ReadonlyArray<readonly [string, 'br' | 'u' | 'sup' | 'sub', boolean]> = [
  ['<br>', 'br', false],
  ['<br/>', 'br', false],
  ['<br />', 'br', false],
  ['<u>', 'u', false],
  ['</u>', 'u', true],
  ['<sup>', 'sup', false],
  ['</sup>', 'sup', true],
  ['<sub>', 'sub', false],
  ['</sub>', 'sub', true],
];

/** The four tags the exporter writes. Any other tag is text. */
function tagAt(s: string, i: number): { kind: 'br' | 'u' | 'sup' | 'sub'; close: boolean; len: number } | null {
  const head = s.slice(i, i + 6).toLowerCase();
  for (const [text, kind, close] of TAGS) if (head.startsWith(text)) return { kind, close, len: text.length };
  return null;
}

/** `<scheme:address>` or `<name@host>`, found within a bounded stretch so a stray `<` costs little. */
function autolinkAt(s: string, i: number): { text: string; dest: string; end: number } | null {
  if (!isLetter(s.charCodeAt(i + 1))) return null;
  const limit = Math.min(s.length, i + 2048);
  let colon = -1;
  let at = -1;
  let j = i + 1;
  for (; j < limit; j += 1) {
    const c = s.charCodeAt(j);
    if (c === 62) break;
    if (c <= 32 || c === 60 || c === 127) return null;
    if (c === 58 && colon < 0) colon = j;
    else if (c === 64 && at < 0) at = j;
  }
  if (j >= limit || s.charCodeAt(j) !== 62) return null;
  const inner = s.slice(i + 1, j);
  if (colon > 0) {
    const scheme = colon - i - 1;
    if (scheme < 2 || scheme > 32) return null;
    for (let k = i + 1; k < colon; k += 1) {
      const c = s.charCodeAt(k);
      if (!isLetter(c) && !isDigit(c) && c !== 43 && c !== 46 && c !== 45) return null;
    }
    return { text: inner, dest: inner, end: j + 1 };
  }
  if (at > i + 1 && at < j - 1) return { text: inner, dest: `mailto:${inner}`, end: j + 1 };
  return null;
}

const skipSpace = (s: string, i: number): number => {
  let j = i;
  while (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10) j += 1;
  return j;
};

/** The `(destination "title")` part of an inline link, starting at the `(`. The title is read and dropped. */
function linkTail(s: string, i: number): { dest: string; end: number } | null {
  if (s.charCodeAt(i) !== 40) return null;
  let p = skipSpace(s, i + 1);
  let dest = '';
  if (s.charCodeAt(p) === 60) {
    let q = p + 1;
    for (;;) {
      const c = s.charCodeAt(q);
      if (c === 62) break;
      if (Number.isNaN(c) || c === 60 || c === 10) return null;
      if (c === 92 && isPunct(s.charCodeAt(q + 1))) {
        dest += s.charAt(q + 1);
        q += 2;
      } else {
        dest += s.charAt(q);
        q += 1;
      }
    }
    p = q + 1;
  } else {
    // Parentheses must balance, and only so many may nest: that bounds how far a failed link reads.
    let depth = 0;
    let q = p;
    for (;;) {
      const c = s.charCodeAt(q);
      if (Number.isNaN(c) || c <= 32 || c === 127) break;
      if (c === 92 && isPunct(s.charCodeAt(q + 1))) {
        dest += s.charAt(q + 1);
        q += 2;
        continue;
      }
      if (c === 40) {
        depth += 1;
        if (depth > 32) return null;
      } else if (c === 41) {
        if (depth === 0) break;
        depth -= 1;
      }
      dest += s.charAt(q);
      q += 1;
    }
    if (depth !== 0) return null;
    p = q;
  }
  p = skipSpace(s, p);
  const quote = s.charAt(p);
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    const limit = Math.min(s.length, p + 200);
    let e = p + 1;
    while (e < limit && s.charAt(e) !== closer) e += s.charAt(e) === '\\' ? 2 : 1;
    if (s.charAt(e) !== closer) return null;
    p = skipSpace(s, e + 1);
  }
  return s.charCodeAt(p) === 41 ? { dest, end: p + 1 } : null;
}

/** The end (just after the `]`) of a footnote reference `[^label]` that starts at `i`, or -1. */
function noteRefEnd(s: string, i: number): number {
  if (s.charCodeAt(i) !== 91 || s.charCodeAt(i + 1) !== 94) return -1;
  const limit = Math.min(s.length, i + 66);
  for (let j = i + 2; j < limit; j += 1) {
    const c = s.charCodeAt(j);
    if (c === 93) return j > i + 2 ? j + 1 : -1;
    if (c <= 32 || c === 91 || c === 94 || c === 92 || c === 127) return -1;
  }
  return -1;
}

const slotOf = (d: Delim): number => {
  if (d.kind === '*') return (d.open ? 3 : 0) + (d.orig % 3);
  return d.kind === '~' ? 6 + (d.open ? 1 : 0) : d.kind === 'u' ? 8 : d.kind === 'sup' ? 9 : 10;
};

/** CommonMark's "multiple of 3" rule for runs that can both open and close. */
const oddMatch = (opener: Delim, closer: Delim): boolean =>
  closer.kind === '*' && (closer.open || opener.close) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0;

const wrapOf = (kind: DelimKind, used: number): Wrap => (kind === '*' ? (used === 2 ? 'strong' : 'em') : kind === '~' ? 'del' : kind);

/**
 * Inline Markdown, read once from left to right. Emphasis follows CommonMark's delimiter-stack method, which is linear, and the
 * scanner never searches the rest of the text for something it may not find, so no input can make it take quadratic time.
 */
class InlineParser {
  private head: Tok | null = null;
  private tail: Tok | null = null;
  private delims: Delim | null = null;
  private brackets: Bracket | null = null;
  private buf = '';
  private runs: Runs | null = null;
  private cursor = 0;
  private commentsLeft = true;

  constructor(private readonly s: string) {}

  parse(): Inline[] {
    const s = this.s;
    const len = s.length;
    let i = 0;
    while (i < len) {
      const c = s.charCodeAt(i);
      if (c === 92) i = this.escape(i);
      else if (c === 96) i = this.code(i);
      else if (c === 42) i = this.star(i);
      else if (c === 126) i = this.tilde(i);
      else if (c === 91) i = this.open(i, false);
      else if (c === 33 && s.charCodeAt(i + 1) === 91) i = this.open(i, true);
      else if (c === 93) i = this.close(i);
      else if (c === 60) i = this.angle(i);
      else if (c === 10) i = this.lineBreak(i);
      else i = this.plain(i);
    }
    this.flush();
    this.emphasis(null);
    return trimInline(this.collect(this.head, null));
  }

  private flush(): void {
    if (this.buf === '') return;
    this.push({ t: 'text', v: this.buf });
    this.buf = '';
  }

  private push(node: Inline): Tok {
    const tok: Tok = { prev: this.tail, next: null, node };
    if (this.tail) this.tail.next = tok;
    else this.head = tok;
    this.tail = tok;
    return tok;
  }

  /** A stretch of ordinary characters (the first one may be a marker that turned out to be plain). */
  private plain(i: number): number {
    const s = this.s;
    let j = i + 1;
    while (j < s.length && !isSpecial(s.charCodeAt(j))) j += 1;
    this.buf += s.slice(i, j);
    return j;
  }

  private escape(i: number): number {
    const next = this.s.charCodeAt(i + 1);
    if (isPunct(next)) {
      this.buf += this.s.charAt(i + 1);
      return i + 2;
    }
    if (next === 10) return this.lineBreak(i + 1);
    this.buf += '\\';
    return i + 1;
  }

  private lineBreak(i: number): number {
    let e = this.buf.length;
    while (e > 0 && this.buf.charCodeAt(e - 1) === 32) e -= 1;
    if (e < this.buf.length) this.buf = this.buf.slice(0, e);
    this.flush();
    this.push({ t: 'br' });
    let j = i + 1;
    while (this.s.charCodeAt(j) === 32 || this.s.charCodeAt(j) === 9) j += 1;
    return j;
  }

  private index(): Runs {
    if (this.runs) return this.runs;
    const s = this.s;
    const pos: number[] = [];
    const len: number[] = [];
    for (let i = 0; i < s.length; i += 1) {
      if (s.charCodeAt(i) !== 96) continue;
      let j = i + 1;
      while (s.charCodeAt(j) === 96) j += 1;
      pos.push(i);
      len.push(j - i);
      i = j - 1;
    }
    const next = new Int32Array(pos.length).fill(-1);
    const last = new Map<number, number>();
    for (let r = pos.length - 1; r >= 0; r -= 1) {
      const n = len[r] as number;
      next[r] = last.get(n) ?? -1;
      last.set(n, r);
    }
    this.runs = { pos, len, next };
    return this.runs;
  }

  private code(i: number): number {
    const s = this.s;
    const { pos, len, next } = this.index();
    let r = this.cursor;
    while (r < pos.length && (pos[r] as number) + (len[r] as number) <= i) r += 1;
    this.cursor = r;
    const start = pos[r] as number;
    const n = len[r] as number;
    if (start < i) {
      // The run began with an escaped backtick: what is left of it is text.
      this.buf += s.slice(i, start + n);
      this.cursor = r + 1;
      return start + n;
    }
    const close = next[r] as number;
    if (close < 0) {
      this.buf += s.slice(i, i + n);
      this.cursor = r + 1;
      return i + n;
    }
    const end = pos[close] as number;
    let body = s.slice(i + n, end).replace(/\n/g, ' ');
    if (body.length >= 2 && body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '') body = body.slice(1, -1);
    this.flush();
    this.push({ t: 'code', v: body });
    this.cursor = close + 1;
    return end + n;
  }

  private star(i: number): number {
    const s = this.s;
    if (s.charCodeAt(i + 1) === 91 && (s.startsWith('[image', i + 1) || s.startsWith('[missing image', i + 1))) {
      const end = this.placeholder(i);
      if (end > 0) return end;
    }
    let j = i + 1;
    while (s.charCodeAt(j) === 42) j += 1;
    const f = flanks(charBefore(s, i), charAfter(s, j));
    this.delim('*', s.slice(i, j), j - i, f.open, f.close);
    return j;
  }

  private tilde(i: number): number {
    const s = this.s;
    let j = i + 1;
    while (s.charCodeAt(j) === 126) j += 1;
    if (j - i !== 2) {
      this.buf += s.slice(i, j);
      return j;
    }
    const f = flanks(charBefore(s, i), charAfter(s, j));
    this.delim('~', '~~', 2, f.open, f.close);
    return j;
  }

  /** What the preview writes where an attachment is left out: `*[image: name]*`. It becomes the same card as an image. */
  private placeholder(i: number): number {
    const s = this.s;
    let j = i + 1 + (s.startsWith('[missing image', i + 1) ? '[missing image'.length : '[image'.length);
    let label = '';
    if (s.charCodeAt(j) === 58 && s.charCodeAt(j + 1) === 32) {
      const from = j + 2;
      const limit = Math.min(s.length, from + 400);
      let k = from;
      while (k < limit && !(s.charCodeAt(k) === 93 && s.charCodeAt(k + 1) === 42)) {
        if (s.charCodeAt(k) === 10) return -1;
        k += s.charCodeAt(k) === 92 ? 2 : 1;
      }
      label = unescapeMd(s.slice(from, k));
      j = k;
    }
    if (s.charCodeAt(j) !== 93 || s.charCodeAt(j + 1) !== 42) return -1;
    this.flush();
    this.push({ t: 'image', alt: label, dest: '' });
    return j + 2;
  }

  private delim(kind: DelimKind, text: string, count: number, open: boolean, close: boolean): void {
    if (!open && !close) {
      this.buf += text;
      return;
    }
    this.flush();
    const tok = this.push({ t: 'text', v: text });
    const d: Delim = { prev: this.delims, next: null, tok, kind, count, orig: count, open, close };
    if (this.delims) this.delims.next = d;
    this.delims = d;
  }

  private open(i: number, image: boolean): number {
    if (!image) {
      const end = noteRefEnd(this.s, i);
      if (end > 0) {
        this.flush();
        this.push({ t: 'fnref', label: this.s.slice(i + 2, end - 1) });
        return end;
      }
    }
    this.flush();
    const tok = this.push({ t: 'text', v: image ? '![' : '[' });
    this.brackets = { prev: this.brackets, tok, image, delim: this.delims };
    return i + (image ? 2 : 1);
  }

  private close(i: number): number {
    const b = this.brackets;
    if (!b) {
      this.buf += ']';
      return i + 1;
    }
    this.brackets = b.prev;
    const tail = linkTail(this.s, i + 1);
    if (!tail) {
      this.buf += ']';
      return i + 1;
    }
    this.flush();
    this.emphasis(b.delim);
    const inner = this.collect(b.tok.next, null);
    b.tok.node = b.image ? { t: 'image', alt: plainText(inner), dest: tail.dest } : { t: 'link', c: inner, dest: tail.dest };
    b.tok.next = null;
    this.tail = b.tok;
    return tail.end;
  }

  private angle(i: number): number {
    const s = this.s;
    const tag = tagAt(s, i);
    if (tag) {
      if (tag.kind === 'br') {
        this.flush();
        this.push({ t: 'br' });
      } else {
        this.delim(tag.kind, s.slice(i, i + tag.len), 1, !tag.close, tag.close);
      }
      return i + tag.len;
    }
    if (this.commentsLeft && s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end >= 0) return end + 3;
      this.commentsLeft = false;
    }
    const auto = autolinkAt(s, i);
    if (auto) {
      this.flush();
      this.push({ t: 'link', c: [{ t: 'text', v: auto.text }], dest: auto.dest });
      return auto.end;
    }
    this.buf += '<';
    return i + 1;
  }

  private drop(d: Delim): void {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    else this.delims = d.prev;
  }

  /** Pairs up the delimiters above `bottom`, wrapping what lies between each pair; unmatched ones stay as text. */
  private emphasis(bottom: Delim | null): void {
    if (this.delims === bottom) return;
    const lows: Array<Delim | null> = new Array<Delim | null>(11).fill(bottom);
    let closer: Delim | null = this.delims;
    while (closer && closer.prev !== bottom) closer = closer.prev;
    while (closer) {
      if (!closer.close) {
        closer = closer.next;
        continue;
      }
      const slot = slotOf(closer);
      let opener = closer.prev;
      let found = false;
      while (opener && opener !== bottom && opener !== lows[slot]) {
        if (opener.kind === closer.kind && opener.open && !oddMatch(opener, closer)) {
          found = true;
          break;
        }
        opener = opener.prev;
      }
      if (!found || !opener) {
        const next: Delim | null = closer.next;
        lows[slot] = closer.prev;
        if (!closer.open) this.drop(closer);
        closer = next;
        continue;
      }
      const used = closer.kind === '*' ? (closer.count >= 2 && opener.count >= 2 ? 2 : 1) : closer.count;
      opener.count -= used;
      closer.count -= used;
      for (const d of [opener, closer]) {
        const node = d.tok.node;
        if (node.t === 'text') node.v = d.count === 0 ? '' : node.v.slice(0, d.count);
      }
      const inner = this.collect(opener.tok.next, closer.tok);
      if (inner.length > 0) {
        const wrapper: Tok = { prev: opener.tok, next: closer.tok, node: { t: wrapOf(closer.kind, used), c: inner } };
        opener.tok.next = wrapper;
        closer.tok.prev = wrapper;
      }
      // Delimiters between the pair can no longer match anything.
      opener.next = closer;
      closer.prev = opener;
      if (opener.count === 0) this.drop(opener);
      if (closer.count === 0) {
        const next: Delim | null = closer.next;
        this.drop(closer);
        closer = next;
      }
    }
    this.delims = bottom;
    if (bottom) bottom.next = null;
  }

  /** The nodes of the tokens from `from` up to (not including) `until`, with neighbouring text joined. */
  private collect(from: Tok | null, until: Tok | null): Inline[] {
    const out: Inline[] = [];
    for (let t = from; t && t !== until; t = t.next) {
      const n = t.node;
      if (n.t !== 'text') {
        out.push(n);
      } else if (n.v !== '') {
        const last = out[out.length - 1];
        if (last && last.t === 'text') last.v += n.v;
        else out.push({ t: 'text', v: n.v });
      }
    }
    return out;
  }
}

/** No line breaks or blanks at either end of a run of inline content. */
function trimInline(nodes: Inline[]): Inline[] {
  let a = 0;
  let b = nodes.length;
  while (a < b && nodes[a]?.t === 'br') a += 1;
  while (b > a && nodes[b - 1]?.t === 'br') b -= 1;
  const out = nodes.slice(a, b);
  const first = out[0];
  if (first && first.t === 'text') first.v = first.v.trimStart();
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v = last.v.trimEnd();
  return out;
}

const parseInline = (text: string): Inline[] => new InlineParser(text).parse();

// ---- front matter

interface Field {
  key: string;
  value: string;
  items: string[];
}

const FRONT_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
const FRONT_MAX_LINES = 400;

/** A YAML scalar as the exporter writes it: a JSON string, or plain text for numbers and booleans. */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not valid JSON: shown as written, without the quotes.
    }
    return v.replace(/^"|"$/g, '');
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** The `---` block at the very top, only when every line in it is `key: value`, `key:` or an indented `- item`. */
function parseFrontMatter(lines: readonly string[]): { fields: Field[]; end: number } | null {
  if ((lines[0] ?? '').trimEnd() !== '---') return null;
  const fields: Field[] = [];
  const limit = Math.min(lines.length, FRONT_MAX_LINES);
  for (let i = 1; i < limit; i += 1) {
    const line = lines[i] ?? '';
    if (line.trimEnd() === '---') return fields.length > 0 ? { fields, end: i + 1 } : null;
    const body = line.trimStart();
    if (body === '') continue;
    const last = fields[fields.length - 1];
    if (body.length < line.length) {
      if (!last || !(body === '-' || body.startsWith('- '))) return null;
      last.items.push(scalar(body.slice(1)));
      continue;
    }
    const colon = body.indexOf(':');
    if (colon < 1 || !FRONT_KEY.test(body.slice(0, colon))) return null;
    fields.push({ key: body.slice(0, colon), value: scalar(body.slice(colon + 1)), items: [] });
  }
  return null;
}

// ---- block parser

interface ParseCtx {
  /** Footnote bodies by label, the first definition of each. */
  notes: Map<string, Block[]>;
}

function scanIndent(line: string): { col: number; pos: number } {
  let col = 0;
  let pos = 0;
  for (; pos < line.length; pos += 1) {
    const c = line.charCodeAt(pos);
    if (c === 32) col += 1;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return { col, pos };
}

function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Removes up to `width` columns of leading blanks (a tab counts to the next multiple of four). */
function stripCols(line: string, width: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < width) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col += 1;
    } else if (c === 9) {
      const next = col + 4 - (col % 4);
      if (next > width) return ' '.repeat(next - width) + line.slice(i + 1);
      col = next;
    } else {
      break;
    }
    i += 1;
  }
  return line.slice(i);
}

interface Fence {
  ch: string;
  len: number;
  info: string;
}

function fenceAt(rest: string): Fence | null {
  const ch = rest.charAt(0);
  if (ch !== '`' && ch !== '~') return null;
  let len = 1;
  while (rest.charAt(len) === ch) len += 1;
  if (len < 3) return null;
  const info = rest.slice(len).trim();
  return ch === '`' && info.includes('`') ? null : { ch, len, info };
}

function closesFence(line: string, fence: Fence): boolean {
  const { col, pos } = scanIndent(line);
  if (col >= 4) return false;
  let n = 0;
  while (line.charAt(pos + n) === fence.ch) n += 1;
  return n >= fence.len && isBlank(line.slice(pos + n));
}

const SAFE_LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;

function parseFence(lines: string[], start: number, col: number, fence: Fence): { block: Block; next: number } {
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    i += 1;
    if (closesFence(line, fence)) break;
    body.push(stripCols(line, col));
  }
  const word = fence.info.split(/\s/, 1)[0] ?? '';
  return { block: { t: 'code', lang: SAFE_LANGUAGE.test(word) ? word : '', v: body.join('\n') }, next: i };
}

function headingAt(rest: string): { level: number; text: string } | null {
  let level = 0;
  while (rest.charAt(level) === '#') level += 1;
  if (level < 1 || level > 6) return null;
  const after = rest.charAt(level);
  if (after !== '' && after !== ' ' && after !== '\t') return null;
  let text = rest.slice(level).trim();
  let e = text.length;
  while (e > 0 && text.charAt(e - 1) === '#') e -= 1;
  // A closing run of # counts only when a blank comes before it (an escaped one does not).
  if (e < text.length && (e === 0 || text.charAt(e - 1) === ' ' || text.charAt(e - 1) === '\t')) text = text.slice(0, e).trimEnd();
  return { level, text };
}

function isRule(rest: string): boolean {
  const ch = rest.charAt(0);
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let count = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest.charAt(i);
    if (c === ch) count += 1;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

interface Marker {
  col: number;
  /** Column where the item's text starts: the lines that belong to the item are indented at least this far. */
  width: number;
  bullet: string;
  delim: string;
  num: number;
  text: string;
}

function markerAt(line: string): Marker | null {
  const { col, pos } = scanIndent(line);
  const c = line.charCodeAt(pos);
  let len: number;
  let bullet = '';
  let delim = '';
  let num = 0;
  if (c === 45 || c === 42 || c === 43) {
    bullet = line.charAt(pos);
    len = 1;
  } else if (isDigit(c)) {
    let e = pos + 1;
    while (isDigit(line.charCodeAt(e))) e += 1;
    const d = line.charAt(e);
    if (e - pos > 9 || (d !== '.' && d !== ')')) return null;
    delim = d;
    num = Number(line.slice(pos, e));
    len = e - pos + 1;
  } else {
    return null;
  }
  const after = line.charCodeAt(pos + len);
  if (!Number.isNaN(after) && after !== 32 && after !== 9) return null;
  let k = pos + len;
  let gap = 0;
  while (gap < 5 && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) {
    k += 1;
    gap += 1;
  }
  const rest = line.slice(k);
  const empty = rest.trim() === '';
  // Five or more blanks after the marker leave the text starting one blank after it.
  return {
    col,
    width: col + len + (empty || gap > 4 ? 1 : gap),
    bullet,
    delim,
    num,
    text: empty ? '' : gap > 4 ? line.slice(pos + len + 1) : rest,
  };
}

/** Whether a line may end a paragraph that has no blank line before it. */
function interrupts(line: string, depth: number): boolean {
  const { col, pos } = scanIndent(line);
  if (pos >= line.length) return true;
  if (col >= 4) return false;
  const c = line.charCodeAt(pos);
  if (c === 35) return headingAt(line.slice(pos)) !== null;
  if (c === 96 || c === 126) return fenceAt(line.slice(pos)) !== null;
  if (c === 62) return depth < MAX_BLOCK_DEPTH;
  if (c === 45 || c === 42 || c === 95) {
    if (isRule(line.slice(pos))) return true;
  }
  if (depth < MAX_BLOCK_DEPTH && (c === 45 || c === 42 || c === 43 || isDigit(c))) {
    const m = markerAt(line);
    // An empty item, or a number other than 1, cannot interrupt a paragraph.
    return m !== null && m.text !== '' && (m.delim === '' || m.num === 1);
  }
  return depth === 0 && c === 91 && noteAt(line.slice(pos)) !== null;
}

function noteAt(rest: string): { label: string; text: string } | null {
  const end = noteRefEnd(rest, 0);
  if (end < 0 || rest.charCodeAt(end) !== 58) return null;
  return { label: rest.slice(2, end - 1), text: rest.slice(end + 1).trim() };
}

const COMMENT_HEAD_REST = /^ \u00b7 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC( \u00b7 \*on highlighted text\*)?$/;

/** The first line of a comment as the exporter writes it: `**Name** · 2026-02-10 10:12 UTC`, perhaps `· *on highlighted text*`. */
function commentHead(line: string): { who: string; when: string; note: boolean } | null {
  if (line.length > 400 || !line.startsWith('**')) return null;
  let k = 2;
  while (k < line.length && line.charCodeAt(k) !== 42) k += line.charCodeAt(k) === 92 ? 2 : 1;
  if (k <= 2 || line.charCodeAt(k + 1) !== 42) return null;
  const m = COMMENT_HEAD_REST.exec(line.slice(k + 2));
  if (!m || !m[1]) return null;
  return { who: plainText(parseInline(line.slice(2, k))), when: m[1], note: m[2] !== undefined };
}

function pushParagraph(out: Block[], lines: string[], from: number, to: number, comment: boolean): void {
  let start = from;
  if (comment) {
    const head = commentHead((lines[from] ?? '').trim());
    if (head) {
      out.push({ t: 'chead', ...head });
      start += 1;
    }
  }
  if (start >= to) return;
  const c = parseInline(
    lines
      .slice(start, to)
      .map((l) => l.trim())
      .join('\n'),
  );
  if (c.length > 0) out.push({ t: 'p', c });
}

/** `[!kind] title` on the first line of a quote: an Obsidian callout (the exporter writes one for a moved document). */
function calloutAt(line: string): { kind: string; title: string } | null {
  if (!line.startsWith('[!')) return null;
  const close = line.indexOf(']', 2);
  if (close < 3 || close > 24) return null;
  const kind = line.slice(2, close);
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(kind)) return null;
  const rest = line.slice(close + 1);
  return { kind: kind.toLowerCase(), title: (rest.startsWith('+') || rest.startsWith('-') ? rest.slice(1) : rest).trim() };
}

function parseQuote(lines: string[], start: number, depth: number, ctx: ParseCtx): { block: Block | null; next: number } {
  const inner: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const { col, pos } = scanIndent(line);
    if (col >= 4 || line.charCodeAt(pos) !== 62) break;
    const sep = line.charCodeAt(pos + 1);
    inner.push(line.slice(pos + (sep === 32 || sep === 9 ? 2 : 1)));
    i += 1;
  }
  const found = calloutAt((inner[0] ?? '').trim());
  const kids = parseBlocks(found ? inner.slice(1) : inner, depth + 1, ctx, true);
  if (kids.length === 0 && !found) return { block: null, next: i };
  const callout: Callout | null = found ? { kind: found.kind, title: parseInline(found.title) } : null;
  return { block: { t: 'quote', c: kids, comment: kids[0]?.t === 'chead', callout }, next: i };
}

function makeItem(body: string[], depth: number, ctx: ParseCtx): Item {
  let task: Item['task'] = null;
  const head = body[0] ?? '';
  const mark = head.charAt(1);
  if (head.length >= 3 && head.charAt(0) === '[' && head.charAt(2) === ']' && (mark === ' ' || mark === 'x' || mark === 'X')) {
    const after = head.charCodeAt(3);
    if (Number.isNaN(after) || after === 32 || after === 9) {
      task = mark === ' ' ? 'open' : 'done';
      body[0] = head.slice(3).trimStart();
    }
  }
  return { task, c: parseBlocks(body, depth + 1, ctx, false) };
}

function parseList(lines: string[], start: number, depth: number, ctx: ParseCtx): { block: Block; next: number } {
  const first = markerAt(lines[start] ?? '') as Marker;
  const items: Item[] = [];
  const n = lines.length;
  let m = first;
  let i = start;
  let end = start + 1;
  for (;;) {
    // The item is its first line's text and every line after it that is indented to line up with that text.
    const body: string[] = [m.text];
    let j = i + 1;
    while (j < n) {
      const line = lines[j] ?? '';
      if (isBlank(line)) {
        let k = j + 1;
        while (k < n && isBlank(lines[k] ?? '')) k += 1;
        if (k >= n || scanIndent(lines[k] ?? '').col < m.width) break;
        for (; j < k; j += 1) body.push('');
      } else if (scanIndent(line).col >= m.width) {
        body.push(stripCols(line, m.width));
        j += 1;
      } else {
        break;
      }
    }
    items.push(makeItem(body, depth, ctx));
    end = j;
    let k = j;
    while (k < n && isBlank(lines[k] ?? '')) k += 1;
    if (k >= n) break;
    const next = markerAt(lines[k] ?? '');
    if (!next || next.bullet !== first.bullet || next.delim !== first.delim || next.col - first.col > 3) break;
    if (isRule(lines[k]?.trimStart() ?? '')) break;
    // A numbered item after a blank line that does not carry on the count starts a new list.
    if (first.delim !== '' && k > j && next.num !== m.num + 1) break;
    m = next;
    i = k;
  }
  return { block: { t: 'list', ordered: first.delim !== '', start: first.num, items }, next: end };
}

function parseNote(lines: string[], start: number, note: { label: string; text: string }, ctx: ParseCtx): number {
  // The comments of a thread: the lines after the first are indented four blanks.
  const body: string[] = [note.text];
  const n = lines.length;
  let j = start + 1;
  while (j < n) {
    const line = lines[j] ?? '';
    if (isBlank(line)) {
      let k = j + 1;
      while (k < n && isBlank(lines[k] ?? '')) k += 1;
      if (k >= n || scanIndent(lines[k] ?? '').col < 4) break;
      for (; j < k; j += 1) body.push('');
    } else if (scanIndent(line).col >= 4) {
      body.push(stripCols(line, 4));
      j += 1;
    } else {
      break;
    }
  }
  if (!ctx.notes.has(note.label)) ctx.notes.set(note.label, parseBlocks(body, 1, ctx, true));
  return j;
}

/** The cells of one table row. A pipe starts a new cell unless a backslash escapes it. */
function splitRow(line: string): string[] {
  const s = line.trim();
  const cuts: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 92) i += 1;
    else if (c === 124) cuts.push(i);
  }
  const cells: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    cells.push(s.slice(from, cut));
    from = cut + 1;
  }
  cells.push(s.slice(from));
  // A pipe at either end only frames the row.
  if (cuts[0] === 0) cells.shift();
  if (cuts.length > 0 && cuts[cuts.length - 1] === s.length - 1) cells.pop();
  return cells.map((c) => c.trim());
}

/** The alignment a delimiter cell (`---`, `:--`, `--:`, `:-:`) stands for, or undefined when the cell is something else. */
function alignOf(cell: string): Align | undefined {
  let a = 0;
  let b = cell.length;
  const left = cell.charCodeAt(0) === 58;
  if (left) a = 1;
  const right = b > a && cell.charCodeAt(b - 1) === 58;
  if (right) b -= 1;
  if (b - a < 1) return undefined;
  for (let i = a; i < b; i += 1) if (cell.charCodeAt(i) !== 45) return undefined;
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

// The exporter escapes every pipe in a cell, also inside code, and a pipe escape is dropped before the cell is read.
const cellInline = (cell: string): Inline[] => parseInline(cell.replace(/\\\|/g, '|'));

function tableAt(lines: string[], i: number): { block: Block; next: number } | null {
  const delimiter = lines[i + 1];
  if (delimiter === undefined || !delimiter.includes('|')) return null;
  const head = splitRow(lines[i] ?? '');
  const align: Align[] = [];
  for (const cell of splitRow(delimiter)) {
    const a = alignOf(cell);
    if (a === undefined) return null;
    align.push(a);
  }
  if (align.length === 0 || align.length !== head.length) return null;
  const rows: Inline[][][] = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j] ?? '';
    if (!line.includes('|') || isBlank(line)) break;
    // Cells beyond the header are dropped; a short row is left short, so a table never costs more than it has pipes.
    rows.push(splitRow(line).slice(0, align.length).map(cellInline));
    j += 1;
  }
  return { block: { t: 'table', align, head: head.map(cellInline), rows }, next: j };
}

function parseBlocks(lines: string[], depth: number, ctx: ParseCtx, comment: boolean): Block[] {
  const out: Block[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i] ?? '';
    const { col, pos } = scanIndent(line);
    if (pos >= line.length) {
      i += 1;
      continue;
    }
    // Text indented four blanks or more is a paragraph here: the exporter writes code only as fenced blocks.
    if (col < 4) {
      const rest = line.slice(pos);
      const c = rest.charCodeAt(0);
      const fence = c === 96 || c === 126 ? fenceAt(rest) : null;
      if (fence) {
        const r = parseFence(lines, i, col, fence);
        out.push(r.block);
        i = r.next;
        continue;
      }
      const heading = c === 35 ? headingAt(rest) : null;
      if (heading) {
        const content = parseInline(heading.text);
        if (content.length > 0) out.push({ t: 'h', level: heading.level, c: content });
        i += 1;
        continue;
      }
      if (isRule(rest)) {
        out.push({ t: 'hr' });
        i += 1;
        continue;
      }
      if (c === 62 && depth < MAX_BLOCK_DEPTH) {
        const r = parseQuote(lines, i, depth, ctx);
        if (r.block) out.push(r.block);
        i = r.next;
        continue;
      }
      if (depth < MAX_BLOCK_DEPTH && markerAt(line)) {
        const r = parseList(lines, i, depth, ctx);
        out.push(r.block);
        i = r.next;
        continue;
      }
      const note = depth === 0 && c === 91 ? noteAt(rest) : null;
      if (note) {
        i = parseNote(lines, i, note, ctx);
        continue;
      }
    }
    const table = line.includes('|') ? tableAt(lines, i) : null;
    if (table) {
      out.push(table.block);
      i = table.next;
      continue;
    }
    let j = i + 1;
    while (j < n && !interrupts(lines[j] ?? '', depth)) j += 1;
    pushParagraph(out, lines, i, j, comment);
    i = j;
  }
  return out;
}

// ---- drawing

type Tag =
  | 'div' | 'span' | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'hr' | 'br' | 'pre' | 'code' | 'blockquote'
  | 'ul' | 'ol' | 'li' | 'input' | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td'
  | 'em' | 'strong' | 'del' | 'u' | 'sup' | 'sub' | 'details' | 'summary' | 'dl' | 'dt' | 'dd';

/** The only attributes the preview ever sets. None of them can load, navigate or run anything. */
const ATTRIBUTES: ReadonlySet<string> = new Set(['class', 'title', 'role', 'aria-label', 'aria-level', 'aria-hidden', 'start', 'type', 'disabled', 'checked']);

const HEADINGS: readonly Tag[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

interface Out {
  doc: Document;
  /** Elements and text nodes that may still be created. */
  left: number;
  /** Set when the budget ran out and part of the document was left out. */
  cut: boolean;
  notes: Map<string, Block[]>;
  /** Footnote numbers, by label, in the order they are first referenced. */
  numbers: Map<string, number>;
}

function el(o: Out, tag: Tag, cls?: string, attrs?: Record<string, string>): HTMLElement {
  o.left -= 1;
  const e = o.doc.createElement(tag);
  if (cls) e.setAttribute('class', cls);
  if (attrs) for (const [name, value] of Object.entries(attrs)) if (ATTRIBUTES.has(name)) e.setAttribute(name, value);
  return e;
}

function txt(o: Out, text: string): Text {
  o.left -= 1;
  return o.doc.createTextNode(text);
}

function textEl(o: Out, tag: Tag, cls: string | undefined, text: string, attrs?: Record<string, string>): HTMLElement {
  const e = el(o, tag, cls, attrs);
  e.appendChild(txt(o, text));
  return e;
}

const WEB_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel']);
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/;

/** What a link points at, for styling only: a note in the export, a file beside it, a web address, or something else. */
function linkKind(dest: string): 'doc' | 'file' | 'web' | 'unsafe' {
  const scheme = SCHEME.exec(dest);
  if (scheme) return WEB_SCHEMES.has((scheme[1] ?? '').toLowerCase()) ? 'web' : 'unsafe';
  if (dest.startsWith('//')) return 'web';
  const cut = dest.search(/[?#]/);
  return safeDecode(cut < 0 ? dest : dest.slice(0, cut)).toLowerCase().endsWith('.md') ? 'doc' : 'file';
}

const destTitle = (dest: string): string => clip(cleanText(safeDecode(dest)), 1000);

/** The file an image path names. Data and script addresses name nothing. */
function fileNameOf(dest: string): string {
  const scheme = SCHEME.exec(dest);
  if (scheme && !/^https?$/i.test(scheme[1] ?? '')) return '';
  const cut = dest.search(/[?#]/);
  const path = cut < 0 ? dest : dest.slice(0, cut);
  return clip(cleanText(safeDecode(path.slice(path.lastIndexOf('/') + 1))).trim(), 120);
}

const WRAP_TAG = { em: 'em', strong: 'strong', del: 'del', u: 'u', sup: 'sup', sub: 'sub' } as const;
const PICTURE = '\u{1F5BC}\u{FE0F}';

function noteNumber(o: Out, label: string): number {
  if (!o.notes.has(label)) return 0;
  let n = o.numbers.get(label);
  if (n === undefined) {
    n = o.numbers.size + 1;
    o.numbers.set(label, n);
  }
  return n;
}

function renderInlines(o: Out, nodes: readonly Inline[], parent: Node, depth: number): void {
  for (const n of nodes) {
    if (o.left <= 0) {
      o.cut = true;
      return;
    }
    switch (n.t) {
      case 'text':
        if (n.v !== '') parent.appendChild(txt(o, n.v));
        break;
      case 'br':
        parent.appendChild(el(o, 'br'));
        break;
      case 'code':
        parent.appendChild(textEl(o, 'code', 'md-code-inline', n.v));
        break;
      case 'em':
      case 'strong':
      case 'del':
      case 'u':
      case 'sup':
      case 'sub': {
        if (depth >= MAX_INLINE_DEPTH) {
          parent.appendChild(txt(o, plainText(n.c)));
          break;
        }
        const e = el(o, WRAP_TAG[n.t]);
        renderInlines(o, n.c, e, depth + 1);
        parent.appendChild(e);
        break;
      }
      case 'link': {
        // An inert span: its destination is only a tooltip, so nothing can be followed or loaded.
        const title = destTitle(n.dest);
        const e = el(o, 'span', `md-link md-link-${linkKind(n.dest)}`, { title });
        if (n.c.length === 0) e.appendChild(txt(o, clip(title, 120)));
        else if (depth >= MAX_INLINE_DEPTH) e.appendChild(txt(o, plainText(n.c)));
        else renderInlines(o, n.c, e, depth + 1);
        parent.appendChild(e);
        break;
      }
      case 'image': {
        const alt = clip(cleanText(n.alt).trim(), 500);
        const name = fileNameOf(n.dest);
        const card = el(o, 'span', 'md-image', { role: 'img', 'aria-label': alt || 'Image' });
        card.appendChild(textEl(o, 'span', 'md-image-icon', PICTURE, { 'aria-hidden': 'true' }));
        card.appendChild(textEl(o, 'span', 'md-image-alt', alt || 'Image'));
        if (name) card.appendChild(textEl(o, 'span', 'md-image-file', name));
        parent.appendChild(card);
        break;
      }
      case 'fnref': {
        const num = noteNumber(o, n.label);
        // A number, not a link: there is nothing to follow in a preview.
        if (num === 0) parent.appendChild(txt(o, `[^${n.label}]`));
        else parent.appendChild(textEl(o, 'sup', 'md-fnref', String(num), { title: `Comment ${num}` }));
        break;
      }
    }
  }
}

const hueOf = (who: string): number => {
  let h = 0;
  for (let i = 0; i < who.length; i += 1) h = (h * 31 + who.charCodeAt(i)) % 8;
  return h;
};

const calloutClass = (kind: string): string => kind.replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'note';

function renderItem(o: Out, item: Item): HTMLElement {
  const li = el(o, 'li', item.task ? `md-task md-task-${item.task}` : undefined);
  if (item.task) {
    const done = item.task === 'done';
    const box = el(o, 'input', undefined, { type: 'checkbox', disabled: '', 'aria-label': done ? 'Completed' : 'Not completed' });
    if (done) box.setAttribute('checked', '');
    li.appendChild(box);
  }
  let rest = item.c;
  const first = rest[0];
  // A tight item: its first paragraph is the item's own text, not a paragraph of its own.
  if (first && first.t === 'p') {
    const holder = item.task ? el(o, 'span', 'md-task-text') : li;
    renderInlines(o, first.c, holder, 0);
    if (holder !== li) li.appendChild(holder);
    rest = rest.slice(1);
  }
  renderBlocks(o, rest, li);
  return li;
}

function renderBlock(o: Out, b: Block, parent: Node): void {
  switch (b.t) {
    case 'h': {
      const h = el(o, HEADINGS[b.level - 1] ?? 'h6');
      renderInlines(o, b.c, h, 0);
      parent.appendChild(h);
      break;
    }
    case 'p': {
      const p = el(o, 'p');
      renderInlines(o, b.c, p, 0);
      parent.appendChild(p);
      break;
    }
    case 'hr':
      parent.appendChild(el(o, 'hr'));
      break;
    case 'code': {
      const pre = el(o, 'pre', 'md-code');
      pre.appendChild(textEl(o, 'code', b.lang ? `language-${b.lang}` : undefined, b.v));
      parent.appendChild(pre);
      break;
    }
    case 'quote': {
      const q = el(o, 'blockquote', b.callout ? `md-callout md-callout-${calloutClass(b.callout.kind)}` : b.comment ? 'md-comment' : undefined);
      if (b.callout) {
        const title = el(o, 'div', 'md-callout-title');
        if (b.callout.title.length > 0) renderInlines(o, b.callout.title, title, 0);
        else title.appendChild(txt(o, b.callout.kind.charAt(0).toUpperCase() + b.callout.kind.slice(1)));
        q.appendChild(title);
      }
      renderBlocks(o, b.c, q);
      parent.appendChild(q);
      break;
    }
    case 'list': {
      const list = el(o, b.ordered ? 'ol' : 'ul', undefined, b.ordered && b.start !== 1 ? { start: String(b.start) } : undefined);
      for (const item of b.items) {
        if (o.left <= 0) {
          o.cut = true;
          break;
        }
        list.appendChild(renderItem(o, item));
      }
      parent.appendChild(list);
      break;
    }
    case 'table': {
      const { head, rows, align } = b;
      const row = (cells: Inline[][], tag: 'th' | 'td'): HTMLElement => {
        const tr = el(o, 'tr');
        for (let c = 0; c < cells.length; c += 1) {
          if (o.left <= 0) {
            o.cut = true;
            break;
          }
          const a = align[c];
          const cell = el(o, tag, a ? `md-align-${a}` : undefined);
          renderInlines(o, cells[c] ?? [], cell, 0);
          tr.appendChild(cell);
        }
        return tr;
      };
      const table = el(o, 'table', 'md-table');
      const thead = el(o, 'thead');
      thead.appendChild(row(head, 'th'));
      const tbody = el(o, 'tbody');
      for (const r of rows) {
        if (o.left <= 0) {
          o.cut = true;
          break;
        }
        tbody.appendChild(row(r, 'td'));
      }
      table.append(thead, tbody);
      // The wrapper scrolls sideways when a table is wider than the page.
      const wrap = el(o, 'div', 'md-table-wrap');
      wrap.appendChild(table);
      parent.appendChild(wrap);
      break;
    }
    case 'chead': {
      const head = el(o, 'div', 'md-comment-head');
      const initial = Array.from(b.who.trim())[0]?.toUpperCase() ?? '?';
      head.appendChild(textEl(o, 'span', `md-avatar md-hue-${hueOf(b.who)}`, initial, { 'aria-hidden': 'true' }));
      head.appendChild(textEl(o, 'span', 'md-comment-who', clip(b.who, 120)));
      head.appendChild(textEl(o, 'span', 'md-comment-when', `${b.when} UTC`));
      if (b.note) head.appendChild(textEl(o, 'span', 'md-comment-note', 'on highlighted text'));
      parent.appendChild(head);
      break;
    }
  }
}

function renderBlocks(o: Out, blocks: readonly Block[], parent: Node): void {
  for (const b of blocks) {
    if (o.left <= 0) {
      o.cut = true;
      return;
    }
    renderBlock(o, b, parent);
  }
}

const EMBED_LABELS: ReadonlyMap<string, string> = new Map([
  ['calendar', 'Calendar'],
  ['kanban', 'Kanban board'],
  ['project_tracker', 'Project tracker'],
  ['process_bar', 'Process bar'],
  ['poll', 'Poll'],
  ['countdown', 'Countdown'],
  ['video', 'Video'],
  ['salesforce_record', 'Salesforce record'],
  ['salesforce_list', 'Salesforce list'],
  ['spreadsheet', 'Spreadsheet'],
  ['live_app_unknown', 'Live app'],
]);

function chipLabel(key: string): string {
  const known = EMBED_LABELS.get(key);
  if (known) return known;
  const words = key.replace(/[_-]+/g, ' ').trim();
  return clip(words.charAt(0).toUpperCase() + words.slice(1), 40);
}

/** A class-safe word for a chip, so each kind of embed can have its own colour. */
const chipSlug = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'other';

const dayOf = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : clip(iso, 40));

/** The details at the top of a note: who and when, a chip for each kind of embedded content, and everything else folded away. */
function renderMeta(o: Out, fields: readonly Field[], parent: Node, withTitle: boolean): void {
  const get = (key: string): Field | undefined => fields.find((f) => f.key === key);
  const box = el(o, 'div', 'md-meta');
  const title = get('title')?.value;
  if (withTitle && title) box.appendChild(textEl(o, 'h1', 'md-meta-title', clip(title, 300)));

  const bits: HTMLElement[] = [];
  const author = get('author')?.value;
  if (author) bits.push(textEl(o, 'span', 'md-meta-author', clip(author, 120)));
  const created = get('created')?.value;
  if (created) bits.push(textEl(o, 'span', 'md-meta-date', `Created ${dayOf(created)}`, { title: clip(created, 60) }));
  const updated = get('updated')?.value;
  if (updated) bits.push(textEl(o, 'span', 'md-meta-date', `Updated ${dayOf(updated)}`, { title: clip(updated, 60) }));
  if (bits.length > 0) {
    const line = el(o, 'div', 'md-meta-line');
    bits.forEach((bit, k) => {
      if (k > 0) line.appendChild(textEl(o, 'span', 'md-meta-sep', '\u00b7', { 'aria-hidden': 'true' }));
      line.appendChild(bit);
    });
    box.appendChild(line);
  }

  const embeds = get('embeds')?.items ?? [];
  if (embeds.length > 0) {
    const chips = el(o, 'div', 'md-chips');
    for (const key of embeds.slice(0, 40)) chips.appendChild(textEl(o, 'span', `md-chip md-chip-${chipSlug(key)}`, chipLabel(key)));
    box.appendChild(chips);
  }

  const details = el(o, 'details', 'md-front');
  details.appendChild(textEl(o, 'summary', undefined, 'Document details'));
  const list = el(o, 'dl', 'md-front-list');
  for (const f of fields.slice(0, 60)) {
    list.appendChild(textEl(o, 'dt', undefined, clip(f.key, 40)));
    const dd = el(o, 'dd');
    if (f.items.length > 0) for (const item of f.items.slice(0, 40)) dd.appendChild(textEl(o, 'span', 'md-front-item', clip(item, 200)));
    else dd.appendChild(txt(o, clip(f.value, 500)));
    list.appendChild(dd);
  }
  details.appendChild(list);
  box.appendChild(details);
  parent.appendChild(box);
}

/** The comments on highlighted text, numbered like the references that point at them, in the order the text meets them. */
function renderNotes(o: Out, parent: Node): void {
  if (o.notes.size === 0 || o.left <= 0) return;
  // A note nothing refers to is still shown, after the others.
  for (const label of o.notes.keys()) noteNumber(o, label);
  const box = el(o, 'div', 'md-footnotes', { role: 'doc-endnotes' });
  box.appendChild(textEl(o, 'div', 'md-footnotes-title', 'Comments on highlighted text', { role: 'heading', 'aria-level': '2' }));
  const list = el(o, 'ol', 'md-footnote-list');
  for (const label of o.numbers.keys()) {
    if (o.left <= 0) {
      o.cut = true;
      break;
    }
    const li = el(o, 'li', 'md-footnote');
    renderBlocks(o, o.notes.get(label) ?? [], li);
    list.appendChild(li);
  }
  box.appendChild(list);
  parent.appendChild(box);
}

function notice(doc: Document, text: string): HTMLElement {
  const p = doc.createElement('p');
  p.setAttribute('class', 'md-notice');
  p.setAttribute('role', 'note');
  p.appendChild(doc.createTextNode(text));
  return p;
}

function build(markdown: string, doc: Document, root: HTMLElement): void {
  const truncated = markdown.length > MAX_CHARS;
  let text = truncated ? markdown.slice(0, MAX_CHARS) : markdown;
  const last = text.charCodeAt(text.length - 1);
  if (truncated && last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  const lines = text.replace(/\u0000/g, '\ufffd').replace(/\r\n?/g, '\n').split('\n');
  if ((lines[0] ?? '').charCodeAt(0) === 0xfeff) lines[0] = (lines[0] ?? '').slice(1);

  const front = parseFrontMatter(lines);
  const ctx: ParseCtx = { notes: new Map() };
  const blocks = parseBlocks(front ? lines.slice(front.end) : lines, 0, ctx, false);

  const o: Out = { doc, left: MAX_NODES, cut: false, notes: ctx.notes, numbers: new Map() };
  const first = blocks[0];
  let rest: readonly Block[] = blocks;
  if (front) {
    // The details go under the note's own title, or carry the title when the note has none.
    if (first && first.t === 'h' && first.level === 1) {
      renderBlock(o, first, root);
      renderMeta(o, front.fields, root, false);
      rest = blocks.slice(1);
    } else {
      renderMeta(o, front.fields, root, true);
    }
  }
  renderBlocks(o, rest, root);
  renderNotes(o, root);
  if (truncated) {
    root.appendChild(notice(doc, `Only the first ${MAX_CHARS.toLocaleString('en-US')} characters of this document are shown. The rest is not shown here; the Markdown tab still has all of it.`));
  }
  if (o.cut) root.appendChild(notice(doc, 'This document is too large to draw in full. The rest is not shown here; the Markdown tab still has all of it.'));
}

/**
 * The Markdown of one note as a `div.md-preview`, to be placed in the page. Never throws, whatever the text is: the worst a note
 * can do is be shown as plain text.
 */
export function renderMarkdownPreview(markdown: string, doc: Document): HTMLElement {
  const root = doc.createElement('div');
  root.setAttribute('class', 'md-preview');
  try {
    build(String(markdown ?? ''), doc, root);
  } catch {
    // Not expected to happen; this keeps a bug from ever taking the page down with it.
    try {
      while (root.firstChild) root.removeChild(root.firstChild);
      root.appendChild(notice(doc, 'This document could not be drawn. The Markdown tab shows its text.'));
    } catch {
      // Nothing more can be done.
    }
  }
  return root;
}
