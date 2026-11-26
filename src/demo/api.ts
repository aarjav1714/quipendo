/**
 * A read-only stand-in for Quip's API that answers from the made-up demo account. It serves the same endpoints the real client
 * is allowed to call (READ_ONLY_ENDPOINTS), in the same shapes, so the real exporter runs against it unchanged. It makes no
 * network request, and anything but a GET is refused.
 *
 * The extension's "Try the demo" uses it, and so does the script that makes the sample output in examples/sample-output/.
 */
import { buildDemoFixture } from './account';
import { makeDocx } from './files';
import { ANN, BOB, F_ARCH, F_DESK, F_PRIV, F_SHARED, F_STAR, F_TRASH, ME, SITE, type Fixture, type FixtureThread } from './model';

/** What the page treats as the demo's access token. Any token works; the demo never checks it. */
export const DEMO_TOKEN = 'demo-account';

export interface DemoReply {
  status: number;
  /** A JSON value, or the bytes of a file. */
  body: unknown;
  headers?: Record<string, string>;
}

const fail = (status: number, message: string): DemoReply => ({ status, body: { error: 'application_error', error_code: status, error_description: message } });

const people = (fx: Fixture): Array<{ id: string; name: string }> => [ME, ANN, BOB, ...(fx.users ?? [])];

const userInfo = (u: { id: string; name: string }): Record<string, unknown> => ({ id: u.id, name: u.name, emails: [`${u.name.split(' ')[0]?.toLowerCase()}@example.com`] });

const hasSheet = (t: FixtureThread): boolean => t.type === 'SPREADSHEET' || t.pages.join('').includes("data-section-style='13'");

function threadJson(t: FixtureThread): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    type: t.type,
    author_id: t.authorId,
    created_usec: t.created,
    updated_usec: t.updated,
    link: `${SITE}/${t.secret ?? t.id}`,
    ...(t.secret ? { secret_path: t.secret } : {}),
    ...(hasSheet(t) ? { spreadsheet_summary: { num_tables: t.type === 'SPREADSHEET' ? 2 : 1 } } : {}),
  };
}

/** The plain paragraphs of a document, for the Word copy the demo hands out when asked. */
function paragraphsOf(t: FixtureThread): string[] {
  return t.pages
    .join('\n')
    .replace(/<\/(p|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Answers one GET request for a path and query on Quip's API. */
export function routeDemo(fx: Fixture, url: URL): DemoReply {
  const path = url.pathname;
  const q = url.searchParams;
  let m: RegExpExecArray | null;

  if (path === '/1/users/current') {
    return {
      status: 200,
      body: {
        ...userInfo(ME),
        url: SITE,
        desktop_folder_id: F_DESK,
        archive_folder_id: F_ARCH,
        starred_folder_id: F_STAR,
        private_folder_id: F_PRIV,
        trash_folder_id: F_TRASH,
        shared_folder_ids: [F_SHARED],
        group_folder_ids: [],
      },
    };
  }
  if (path === '/1/users/') {
    const out: Record<string, unknown> = {};
    for (const id of (q.get('ids') ?? '').split(',')) {
      const person = people(fx).find((u) => u.id === id);
      if (person) out[id] = userInfo(person);
    }
    return { status: 200, body: out };
  }
  if (path === '/1/users/current/threads') {
    const threads = Object.fromEntries(
      fx.owned.flatMap((id) => {
        const t = fx.threads[id];
        return t ? [[id, { updated_usec: t.updated, is_deleted: false, link: `${SITE}/${id}`, type: t.type === 'DOCUMENT' ? 'TEXT_DOCUMENT' : t.type === 'SPREADSHEET' ? 'SPREADSHEET_DOCUMENT' : t.type }]] : [];
      }),
    );
    return { status: 200, body: { threads, response_metadata: {} } };
  }

  const folderJson = (id: string): Record<string, unknown> | undefined => {
    const f = fx.folders[id];
    return f ? { folder: { id: f.id, title: f.title, creator_id: ME.id, folder_class: 'standard' }, member_ids: [ME.id], children: f.children } : undefined;
  };
  if (path === '/1/folders/') {
    const ids = (q.get('ids') ?? '').split(',').filter(Boolean);
    if (ids.some((id) => fx.restrictedFolders.includes(id))) return fail(403, 'forbidden');
    if (ids.some((id) => !fx.folders[id])) return fail(404, 'not found');
    return { status: 200, body: Object.fromEntries(ids.map((id) => [id, folderJson(id)])) };
  }
  if ((m = /^\/1\/folders\/([\w-]+)$/.exec(path))) {
    const id = m[1] as string;
    if (fx.restrictedFolders.includes(id)) return fail(403, 'forbidden');
    const folder = folderJson(id);
    return folder ? { status: 200, body: folder } : fail(404, 'not found');
  }

  if (path === '/2/threads/') {
    const ids = (q.get('ids') ?? '').split(',').filter(Boolean);
    if (ids.some((id) => !fx.threads[id])) return fail(404, 'not found');
    return { status: 200, body: Object.fromEntries(ids.map((id) => [id, threadJson(fx.threads[id] as FixtureThread)])) };
  }
  if ((m = /^\/2\/threads\/([\w-]+)\/html$/.exec(path))) {
    const t = fx.threads[m[1] as string];
    if (!t) return fail(404, 'not found');
    const cursor = q.get('cursor');
    const index = cursor ? Number(cursor.replace('page', '')) : 0;
    if (!cursor && t.pages.length === 0) return { status: 200, body: { html: '', response_metadata: {} } };
    const page = t.pages[index];
    if (page === undefined) return fail(400, 'bad cursor');
    return { status: 200, body: { html: page, response_metadata: index + 1 < t.pages.length ? { next_cursor: `page${index + 1}` } : {} } };
  }
  if ((m = /^\/2\/threads\/([\w-]+)$/.exec(path))) {
    const t = fx.threads[m[1] as string] ?? Object.values(fx.threads).find((x) => x.secret === m?.[1]);
    return t ? { status: 200, body: { thread: threadJson(t) } } : fail(404, 'not found');
  }

  if ((m = /^\/1\/messages\/([\w-]+)$/.exec(path))) {
    const t = fx.threads[m[1] as string];
    if (!t) return fail(404, 'not found');
    const count = Number(q.get('count') ?? 25);
    const max = q.get('max_created_usec') ? Number(q.get('max_created_usec')) : Number.POSITIVE_INFINITY;
    const source: Array<{ created_usec: number }> = q.get('message_type') === 'edit' ? (t.edits ?? []) : (t.messages ?? []);
    const list = source.filter((x) => x.created_usec <= max).sort((a, b) => b.created_usec - a.created_usec).slice(0, count);
    return { status: 200, body: list.map((x) => ({ ...x, updated_usec: x.created_usec, visible: true })) };
  }

  if ((m = /^\/1\/blob\/([\w-]+)\/([\w-]+)$/.exec(path))) {
    const blob = fx.blobs[`${m[1]}/${m[2]}`];
    if (!blob) return fail(404, 'not found');
    if ('forbidden' in blob) return fail(403, 'forbidden');
    return { status: 200, body: blob.bytes, headers: { 'content-type': blob.type } };
  }

  if ((m = /^\/1\/threads\/([\w-]+)\/export\/(xlsx|docx|pdf)$/.exec(path))) {
    const t = fx.threads[m[1] as string];
    if (!t) return fail(404, 'not found');
    const kind = m[2] as 'xlsx' | 'docx' | 'pdf';
    if (kind === 'xlsx') return hasSheet(t) && t.exports?.xlsx ? { status: 200, body: t.exports.xlsx, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } } : fail(400, 'thread has no spreadsheet');
    if (kind === 'pdf') return t.type === 'SLIDES' && t.exports?.pdf ? { status: 200, body: t.exports.pdf, headers: { 'content-type': 'application/pdf' } } : fail(400, 'not a slide deck');
    return t.type === 'DOCUMENT'
      ? { status: 200, body: t.exports?.docx ?? makeDocx(paragraphsOf(t)), headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }
      : fail(400, 'not a document');
  }

  return fail(404, `no route for ${path}`);
}

/** A `fetch` for the real client to use in place of the network, answering from the demo account. */
export function createDemoFetch(fixture: Fixture = buildDemoFixture()): typeof fetch {
  return (input, init) => {
    if (init?.signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const reply = method === 'GET' ? routeDemo(fixture, new URL(href)) : fail(405, 'The demo account is read-only.');
    const bytes = reply.body instanceof Uint8Array;
    return Promise.resolve(
      new Response(bytes ? (reply.body as Uint8Array<ArrayBuffer>) : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': bytes ? 'application/octet-stream' : 'application/json', ...reply.headers },
      }),
    );
  };
}
