// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuipClient } from '../../src/core/quipClient';
import { buildDemoFixture } from '../../src/demo/account';
import { createDemoFetch, DEMO_TOKEN } from '../../src/demo/api';
import { SITE } from '../../src/demo/model';

const fixture = buildDemoFixture();
const client = (): QuipClient => new QuipClient({ token: DEMO_TOKEN, fetch: createDemoFetch(fixture), minIntervalMs: 0 });
const get = (path: string): Promise<Response> => createDemoFetch(fixture)(`https://platform.quip.com${path}`, { method: 'GET' });
const startsWith = (bytes: Uint8Array, text: string): boolean => new TextDecoder().decode(bytes.slice(0, text.length)) === text;

afterEach(() => vi.restoreAllMocks());

describe('the demo account', () => {
  it('answers the real client as a Quip account would', async () => {
    const quip = client();
    const user = await quip.currentUser();
    expect(user.name).toBe('Jane Doe');
    expect(user.siteUrl).toBe(SITE);
    const root = await quip.getFolder(user.folders.private ?? '');
    expect(root.ok && root.value.title).toBe('Private');
    const html = await quip.getThreadHtml('RELAUNCHpl1');
    expect(html).toContain('data-live-app-id');
    expect(html).toContain("data-section-style='11'");
    const names = await quip.getUsers(['uCARLOS0001', 'uPRIYA00001']);
    expect([...names.values()]).toEqual(['Carlos Mendes', 'Priya Nair']);
  });

  it('refuses everything but a GET, and never uses the network', async () => {
    const real = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the demo must not use the network'));
    const demo = createDemoFetch(fixture);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await demo('https://platform.quip.com/2/threads/RELAUNCHpl1', { method })).status, method).toBe(405);
    }
    expect((await get('/1/users/current')).status).toBe(200);
    expect(real).not.toHaveBeenCalled();
  });

  it('says so when something is not there, as Quip does', async () => {
    expect((await get('/2/threads/NOSUCHthread')).status).toBe(404);
    expect((await get('/1/blob/RELAUNCHpl1/NOSUCHblob01')).status).toBe(404);
    expect((await get('/no/such/route')).status).toBe(404);
    expect((await get('/1/threads/RELAUNCHpl1/export/pdf')).status).toBe(400);
  });

  it('serves real files: spreadsheets with their formulas, slides as a PDF, Word copies, pictures', async () => {
    const xlsx = new Uint8Array(await (await get('/1/threads/BUDGET2026x1/export/xlsx')).arrayBuffer());
    expect(startsWith(xlsx, 'PK')).toBe(true);
    expect(new TextDecoder().decode(xlsx)).toContain('<f>SUM(B2:B6)</f>');
    const pdf = new Uint8Array(await (await get('/1/threads/KICKOFFdeck1/export/pdf')).arrayBuffer());
    expect(startsWith(pdf, '%PDF-1.4')).toBe(true);
    const docx = new Uint8Array(await (await get('/1/threads/SOURDOUGHn1/export/docx')).arrayBuffer());
    expect(new TextDecoder().decode(docx)).toContain('Sourdough Notes');
    const photo = await get('/1/blob/LISBONtrip01/IMGlisbon001');
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await photo.arrayBuffer())[0]).toBe(0xff);
  });

  it('has a real .xlsx for every document that holds a spreadsheet and a PDF for every slide deck', async () => {
    for (const t of Object.values(fixture.threads)) {
      const sheet = t.type === 'SPREADSHEET' || t.pages.join('').includes("data-section-style='13'");
      if (sheet) expect(t.exports?.xlsx, `${t.title} needs its .xlsx`).toBeDefined();
      if (t.type === 'SLIDES') expect(t.exports?.pdf, `${t.title} needs its PDF`).toBeDefined();
    }
  });

  it('links only to things that exist: documents, pictures and attachments (apart from the one deliberate outside link)', () => {
    const outside = new Set(['ZZoutsideDoc']);
    for (const t of Object.values(fixture.threads)) {
      const html = t.pages.join('\n');
      for (const m of html.matchAll(new RegExp(`${SITE.replace(/[.]/g, '\\.')}/([A-Za-z0-9]{11,12})/`, 'g'))) {
        const id = m[1] as string;
        expect(Boolean(fixture.threads[id]) || outside.has(id), `${t.title} links to ${id}`).toBe(true);
      }
      for (const m of html.matchAll(/\/blob\/([\w-]+)\/([\w-]+)/g)) {
        expect(fixture.blobs[`${m[1]}/${m[2]}`], `${t.title} uses ${m[0]}`).toBeDefined();
      }
      for (const message of t.messages ?? []) {
        for (const file of message.files ?? []) expect(fixture.blobs[`${t.id}/${file.hash}`], `${t.title}: ${file.name}`).toBeDefined();
      }
    }
  });

  it('puts every document in a folder the account lists, or marks it as unfiled', () => {
    const inFolders = new Set(Object.values(fixture.folders).flatMap((f) => f.children.flatMap((c) => ('thread_id' in c ? [c.thread_id] : []))));
    const unfiled = Object.keys(fixture.threads).filter((id) => !inFolders.has(id));
    expect(unfiled.map((id) => fixture.threads[id]?.title)).toEqual(['Scratchpad']);
    expect(fixture.owned).toContain('SCRATCHpad01');
  });
});
