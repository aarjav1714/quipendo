import { relativeLink, usecToIso } from './links';
import { escapeInline } from './markdownUtils';

export const INDEX_MD_PATH = '_Index.md';
export const INDEX_JSON_PATH = '_index.json';
const INDEX_MD_TITLE = '# Quip export index';
const INDEX_JSON_KIND = 'quipendo-index';

/** One exported document as the index files describe it. */
export interface IndexEntry {
  id: string;
  title: string;
  type: string;
  /** Root-relative path of the note. */
  path: string;
  folder?: string;
  alsoIn: string[];
  createdUsec?: number;
  updatedUsec?: number;
  author?: string;
  url: string;
  embeds: string[];
  /** Spreadsheet, slide and Word copies saved next to the note. */
  sidecars: string[];
}

export interface IndexInfo {
  /** For example "Quipendo 0.1.0". */
  tool: string;
  updated: string;
  site: string;
}

const byFolderThenTitle = (a: IndexEntry, b: IndexEntry): number =>
  (a.folder ?? '').localeCompare(b.folder ?? '', undefined, { sensitivity: 'base' }) ||
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
  a.path.localeCompare(b.path);

const day = (usec: number | undefined): string | undefined => usecToIso(usec)?.slice(0, 10);

/** A table of contents for browsing the export: one section per folder, linking every note. */
export function renderIndexMarkdown(entries: IndexEntry[], info: IndexInfo): string {
  const sorted = [...entries].sort(byFolderThenTitle);
  const lines = [INDEX_MD_TITLE, '', `- Tool: ${info.tool}`, `- Updated: ${info.updated}`, `- Documents: ${sorted.length}`, ''];
  lines.push('Each document is listed once, under the folder its note was saved in; other folders that contain it follow "also in". A machine-readable copy of this list is in `_index.json`.', '');
  let heading: string | undefined;
  for (const e of sorted) {
    const folder = e.folder ?? '';
    if (folder !== heading) {
      heading = folder;
      if (lines[lines.length - 1] !== '') lines.push('');
      lines.push(`## ${folder ? escapeInline(folder) : '(no folder)'}`, '');
    }
    const parts = [`[${escapeInline(e.title)}](${relativeLink(INDEX_MD_PATH, e.path)})`, e.type];
    const changed = day(e.updatedUsec);
    if (changed) parts.push(`changed ${changed}`);
    if (e.alsoIn.length > 0) parts.push(`also in ${e.alsoIn.map((f) => escapeInline(f)).join(', ')}`);
    for (const side of e.sidecars) parts.push(`[${side.slice(side.lastIndexOf('.') + 1)}](${relativeLink(INDEX_MD_PATH, side)})`);
    lines.push(`- ${parts.join(' · ')}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The same list for programs: one object per document, with the same relative paths. */
export function renderIndexJson(entries: IndexEntry[], info: IndexInfo): string {
  const documents = [...entries].sort(byFolderThenTitle).map((e) => ({
    id: e.id,
    title: e.title,
    type: e.type,
    path: e.path,
    ...(e.folder ? { folder: e.folder } : {}),
    ...(e.alsoIn.length > 0 ? { also_in: e.alsoIn } : {}),
    ...(usecToIso(e.createdUsec) ? { created: usecToIso(e.createdUsec) } : {}),
    ...(usecToIso(e.updatedUsec) ? { updated: usecToIso(e.updatedUsec) } : {}),
    ...(e.author ? { author: e.author } : {}),
    url: e.url,
    ...(e.embeds.length > 0 ? { embeds: e.embeds } : {}),
    ...(e.sidecars.length > 0 ? { files: e.sidecars } : {}),
  }));
  return `${JSON.stringify({ kind: INDEX_JSON_KIND, tool: info.tool, updated: info.updated, site: info.site, documents }, null, 1)}\n`;
}

/** First line and tool line, which is how an index written by this tool is recognised (and never mistaken for someone's file). */
export function isOwnIndexMarkdown(head: string, toolName: string): boolean {
  return head.startsWith(`${INDEX_MD_TITLE}\n`) && head.slice(0, 600).includes(`- Tool: ${toolName} `);
}

export function isOwnIndexJson(head: string, toolName: string): boolean {
  return head.startsWith('{') && head.slice(0, 600).includes(`"kind": "${INDEX_JSON_KIND}"`) && head.slice(0, 600).includes(`"tool": "${toolName} `);
}
