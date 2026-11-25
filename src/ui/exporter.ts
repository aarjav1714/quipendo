import {
  AuthError,
  DEFAULT_BASE_URL,
  MemorySink,
  QuipClient,
  QuipHttpError,
  createSession,
  parseQuipUrl,
  quipIdFrom,
  rootChoices,
  type CurrentUser,
  type ExportEvent,
  type ExportOptions,
  type ExportSummary,
  type Plan,
  type RootChoice,
} from '../core';
import { FsaSink } from './fsaSink';
import { installReadOnlyGuard } from './guard';
import { idbGet, idbSet } from './idb';
import { MemoryBackend, StoreSink, zipFileName, type StoreStats, type ZipPart } from './storeSink';
import { renderPlanTree, type PlanTree } from './tree';
import { TARGET, ext, hasHostAccess, requestHostAccess, sessionStore } from './webext';

declare const __E2E__: boolean;

type Phase = 'loading' | 'idle' | 'connecting' | 'connected' | 'scanning' | 'scanned' | 'running' | 'previewing' | 'done' | 'stopped' | 'error';
type Tone = 'info' | 'ok' | 'warn' | 'error';

interface PageTarget {
  kind: 'folder' | 'document';
  id: string;
  title: string;
}

interface Connection {
  token: string;
  user: CurrentUser;
  roots: Array<RootChoice & { title: string }>;
}

interface Settings {
  remember: boolean;
  includeComments: boolean;
  anchorComments: boolean;
  keepRaw: boolean;
  saveXlsx: boolean;
  saveDocx: boolean;
  saveEditHistory: boolean;
  skipUnchanged: boolean;
  includeUnfiled: boolean;
  maxDocs: string;
  /** A folder the user picked, or the browser's own storage (saved as a .zip). */
  output: 'folder' | 'store';
  roots: string[] | null;
}

const DEFAULT_SETTINGS: Settings = {
  remember: false,
  includeComments: true,
  anchorComments: true,
  keepRaw: true,
  saveXlsx: true,
  saveDocx: false,
  saveEditHistory: false,
  skipUnchanged: true,
  includeUnfiled: true,
  maxDocs: '',
  output: 'folder',
  roots: null,
};
const KIND_LABEL: Record<RootChoice['kind'], string> = {
  private: 'Private',
  desktop: 'Desktop',
  shared: 'Shared folder',
  group: 'Group folder',
  archive: 'Archive',
  starred: 'Starred',
  trash: 'Trash',
};

const params = new URLSearchParams(location.search);
const E2E = __E2E__ && params.get('e2e') === '1';
const BASE_URL = E2E ? (params.get('base') ?? DEFAULT_BASE_URL) : DEFAULT_BASE_URL;
/** The site the extension needs access to. Permissions are per host name, not per port. */
const SITE_HOST = new URL(BASE_URL).hostname;
/** Only Chromium browsers can write into a folder the user picks; the others keep the export in the browser instead. */
const CAN_PICK_FOLDER = typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const ui = {
  token: byId<HTMLInputElement>('token'),
  remember: byId<HTMLInputElement>('remember'),
  connect: byId<HTMLButtonElement>('btn-connect'),
  forget: byId<HTMLButtonElement>('btn-forget'),
  connectStatus: byId('connect-status'),
  previewUrl: byId<HTMLInputElement>('preview-url'),
  preview: byId<HTMLButtonElement>('btn-preview'),
  previewStatus: byId('preview-status'),
  previewResult: byId('preview-result'),
  previewText: byId<HTMLTextAreaElement>('preview-text'),
  copy: byId<HTMLButtonElement>('btn-copy'),
  downloadMd: byId<HTMLButtonElement>('btn-download-md'),
  accessNotice: byId('access-notice'),
  outFolder: byId<HTMLInputElement>('out-folder'),
  outStore: byId<HTMLInputElement>('out-store'),
  folderRow: byId('folder-row'),
  folderUnavailable: byId('folder-unavailable'),
  storeHint: byId('store-hint'),
  pick: byId<HTMLButtonElement>('btn-pick'),
  regrant: byId<HTMLButtonElement>('btn-regrant'),
  targetName: byId('target-name'),
  targetHint: byId('target-hint'),
  pageScope: byId('page-scope'),
  pageLabel: byId('page-label'),
  scopePage: byId<HTMLInputElement>('scope-page'),
  scopeAll: byId<HTMLInputElement>('scope-all'),
  roots: byId('roots'),
  comments: byId<HTMLInputElement>('opt-comments'),
  anchor: byId<HTMLInputElement>('opt-anchor'),
  raw: byId<HTMLInputElement>('opt-raw'),
  xlsx: byId<HTMLInputElement>('opt-xlsx'),
  docx: byId<HTMLInputElement>('opt-docx'),
  edits: byId<HTMLInputElement>('opt-edits'),
  since: byId<HTMLInputElement>('opt-since'),
  skip: byId<HTMLInputElement>('opt-skip'),
  unfiled: byId<HTMLInputElement>('opt-unfiled'),
  max: byId<HTMLInputElement>('opt-max'),
  scan: byId<HTMLButtonElement>('btn-scan'),
  scanStatus: byId('scan-status'),
  scanSummary: byId('scan-summary'),
  treePanel: byId('tree-panel'),
  tree: byId('tree'),
  treeFilter: byId<HTMLInputElement>('tree-filter'),
  treeAll: byId<HTMLButtonElement>('btn-tree-all'),
  treeNone: byId<HTMLButtonElement>('btn-tree-none'),
  treeCount: byId('tree-count'),
  run: byId<HTMLButtonElement>('btn-run'),
  stop: byId<HTMLButtonElement>('btn-stop'),
  progress: byId<HTMLProgressElement>('progress'),
  runStatus: byId('run-status'),
  storePanel: byId('store-panel'),
  storeInfo: byId('store-info'),
  zipParts: byId('zip-parts'),
  clear: byId<HTMLButtonElement>('btn-clear'),
  clearConfirm: byId('clear-confirm'),
  clearQuestion: byId('clear-question'),
  clearYes: byId<HTMLButtonElement>('btn-clear-yes'),
  clearNo: byId<HTMLButtonElement>('btn-clear-no'),
  log: byId('log'),
  guard: byId('guard-status'),
  version: byId('version'),
};

let phase: Phase = 'loading';
let conn: Connection | undefined;
let target: FileSystemDirectoryHandle | undefined;
let pendingHandle: FileSystemDirectoryHandle | undefined;
let pageTarget: PageTarget | undefined;
let fromUrl = params.get('from') ?? undefined;
let controller: AbortController | undefined;
let session: ReturnType<typeof createSession> | undefined;
let sessionKey = '';
/** Bumped whenever the account or target folder changes, so a cached scan can never be reused for the wrong place. */
let epoch = 0;
/** Set by Stop, so a stop that arrives before an export has created its own controller is not lost. */
let stopRequested = false;
/** Only one of connect, scan and export may run at a time. */
let working = false;
let pendingFrom: string | undefined;
let throttleUntil = 0;
let exportStartedAt = 0;
/** Keep the export in the browser's own storage, to be saved as a .zip, instead of writing into a folder. */
let storeMode = false;
let store: StoreSink | undefined;
/** True when the browser would not give the extension storage of its own, so the export is only held in memory. */
let storeInMemory = false;
/** How much the store holds, and the .zip files it would be saved as. Read again whenever the store changes. */
let storeStats: StoreStats = { files: 0, bytes: 0 };
let storeParts: ZipPart[] = [];
let confirmingClear = false;
/** A .zip is being built from the stored export; nothing else may touch it meanwhile. */
let building = false;
/** Whether the browser lets the extension contact Quip yet; undefined when it cannot say. */
let hostAccess: boolean | undefined;
/** The folder and document tree of the last scan, and what the user unticked in it. */
let tree: PlanTree | undefined;
let excluded = new Set<string>();
let previewedTitle = '';

// ---- small helpers -------------------------------------------------------

const isAbort = (err: unknown): boolean => (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError';

function setStatus(el: HTMLElement, text: string, tone: Tone = 'info'): void {
  el.textContent = text;
  el.dataset.tone = tone;
}

function log(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
  const li = document.createElement('li');
  li.dataset.tone = tone;
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  ui.log.append(li);
  while (ui.log.childElementCount > 400) ui.log.firstElementChild?.remove();
  li.scrollIntoView({ block: 'nearest' });
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Time left, from how long the documents so far took. Only said once there is enough to go on. */
function timeLeft(startedAt: number, done: number, total: number): string {
  const elapsed = Date.now() - startedAt;
  if (done < 5 || elapsed < 10_000 || done >= total) return '';
  return ` · about ${duration((elapsed / done) * (total - done))} left`;
}

const TOKEN_REJECTED = 'Quip rejected the access token. Create a new one at quip.com/dev/token and connect again.';

function describeError(err: unknown): string {
  if (err instanceof AuthError) return TOKEN_REJECTED;
  if (err instanceof QuipHttpError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function setPhase(next: Phase): void {
  phase = next;
  document.body.dataset.state = next;
  refresh();
}

const hasDestination = (): boolean => storeMode || target !== undefined;

function refresh(): void {
  const busy = phase === 'loading' || phase === 'connecting' || phase === 'scanning' || phase === 'running' || phase === 'previewing' || building;
  ui.connect.disabled = busy;
  ui.forget.disabled = busy;
  ui.token.disabled = busy;
  ui.pick.disabled = busy;
  ui.regrant.disabled = busy;
  ui.scan.disabled = busy || !conn || !hasDestination();
  // Nothing ticked in the tree would export nothing.
  const nothingTicked = tree !== undefined && tree.counts().selected === 0;
  ui.run.disabled = busy || !conn || !hasDestination() || !hasScope() || nothingTicked;
  ui.stop.disabled = phase !== 'connecting' && phase !== 'scanning' && phase !== 'running' && phase !== 'previewing';
  ui.preview.disabled = busy || !conn;
  ui.previewUrl.disabled = busy;
  for (const el of [ui.comments, ui.raw, ui.xlsx, ui.docx, ui.unfiled, ui.max, ui.since, ui.scopeAll, ui.scopePage, ui.skip, ui.outStore]) el.disabled = busy;
  ui.outFolder.disabled = busy || !CAN_PICK_FOLDER;
  // These only mean something together with the option they depend on.
  ui.anchor.disabled = busy || !ui.comments.checked;
  ui.edits.disabled = busy || !ui.raw.checked;
  ui.treeFilter.disabled = busy;
  ui.treeAll.disabled = busy;
  ui.treeNone.disabled = busy;
  for (const box of ui.tree.querySelectorAll('input, button')) (box as HTMLInputElement | HTMLButtonElement).disabled = busy;
  for (const box of ui.roots.querySelectorAll('input')) box.disabled = busy;
  ui.folderRow.hidden = storeMode;
  ui.folderUnavailable.hidden = CAN_PICK_FOLDER;
  ui.storeHint.hidden = !storeMode;
  // What the store holds can be saved even after a run stopped or failed, and in a later visit to this page.
  ui.storePanel.hidden = !storeMode;
  for (const button of ui.zipParts.querySelectorAll('button')) button.disabled = busy;
  ui.clear.hidden = confirmingClear;
  ui.clear.disabled = busy || storeStats.files === 0;
  ui.clearConfirm.hidden = !confirmingClear;
  ui.clearYes.disabled = busy;
  ui.clearNo.disabled = busy;
}

// ---- settings and token --------------------------------------------------

async function loadSettings(): Promise<Settings> {
  const stored = (await ext.storage.local.get('settings')) as { settings?: Partial<Settings> & { output?: string } };
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
  // Before the export could be kept in the browser, a .zip was the other choice, and was called "zip".
  return { ...settings, output: settings.output === 'folder' ? 'folder' : 'store' };
}

function currentSettings(roots: string[] | null): Settings {
  return {
    remember: ui.remember.checked,
    includeComments: ui.comments.checked,
    anchorComments: ui.anchor.checked,
    keepRaw: ui.raw.checked,
    saveXlsx: ui.xlsx.checked,
    saveDocx: ui.docx.checked,
    saveEditHistory: ui.edits.checked,
    skipUnchanged: ui.skip.checked,
    includeUnfiled: ui.unfiled.checked,
    maxDocs: ui.max.value.trim(),
    output: storeMode ? 'store' : 'folder',
    roots,
  };
}

async function saveSettings(): Promise<void> {
  // Before connecting there are no folder checkboxes to read, so the selection saved earlier is kept.
  const roots = conn ? selectedRoots() : (await loadSettings()).roots;
  await ext.storage.local.set({ settings: currentSettings(roots) });
}

async function loadToken(): Promise<string | undefined> {
  const fromSession = (await sessionStore.get('token')) as string | undefined;
  if (fromSession) return fromSession;
  const local = (await ext.storage.local.get('token')) as { token?: string };
  return local.token;
}

async function saveToken(token: string, remember: boolean): Promise<void> {
  await sessionStore.set('token', token);
  if (remember) await ext.storage.local.set({ token });
  else await ext.storage.local.remove('token');
}

// ---- target folder -------------------------------------------------------

async function describeTarget(handle: FileSystemDirectoryHandle): Promise<void> {
  ui.targetName.textContent = handle.name;
  let entries = 0;
  for await (const _ of (handle as unknown as { values(): AsyncIterable<unknown> }).values()) {
    entries += 1;
    if (entries > 0) break;
  }
  ui.targetHint.textContent =
    entries > 0
      ? 'This folder already has files. The export adds files and updates only the ones it created earlier; it never deletes anything and never overwrites other files.'
      : "Quip's folder structure is recreated inside it. A new, empty folder or an Obsidian vault works well.";
}

async function useTarget(handle: FileSystemDirectoryHandle): Promise<void> {
  epoch += 1;
  session = undefined;
  target = handle;
  pendingHandle = undefined;
  ui.regrant.hidden = true;
  await describeTarget(handle);
  refresh();
}

async function pickTarget(): Promise<void> {
  try {
    const handle = await window.showDirectoryPicker({ id: 'quipendo', mode: 'readwrite', startIn: 'documents' });
    await idbSet('target', handle);
    await useTarget(handle);
  } catch (err) {
    if (!isAbort(err)) setStatus(ui.connectStatus, `Could not open that folder: ${describeError(err)}`, 'error');
  }
}

async function restoreTarget(): Promise<void> {
  if (__E2E__ && E2E) {
    await useTarget(await (await import('./e2eHooks')).freshTestTarget(params.get('target') ?? undefined, params.get('reuse') === '1'));
    return;
  }
  const handle = await idbGet<FileSystemDirectoryHandle>('target').catch(() => undefined);
  if (!handle) return;
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
    await useTarget(handle);
  } else {
    pendingHandle = handle;
    ui.targetName.textContent = `${handle.name} (permission needed)`;
    ui.regrant.hidden = false;
  }
}

async function regrantTarget(): Promise<void> {
  if (!pendingHandle) return;
  if ((await pendingHandle.requestPermission({ mode: 'readwrite' })) === 'granted') await useTarget(pendingHandle);
}

// ---- the export kept in the browser --------------------------------------

/** Opens the browser's own storage for the export, or memory where the browser will not give the extension any. */
async function openStore(): Promise<StoreSink> {
  if (store) return store;
  // Test builds can shrink the store's size limit to reach the "no room left" path without gigabytes of data.
  const options = __E2E__ && params.has('storeMax') ? { maxBytes: Number(params.get('storeMax')) } : {};
  try {
    store = await StoreSink.openInBrowser(options);
  } catch {
    store = await StoreSink.open(new MemoryBackend(), options);
    storeInMemory = true;
  }
  return store;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  let value = bytes / 1024;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function renderStorePanel(): void {
  const { files, bytes } = storeStats;
  const where = storeInMemory
    ? 'held in memory only, because this browser would not give the extension storage of its own; it is lost when this tab closes, so save it before then'
    : 'kept in this browser';
  setStatus(ui.storeInfo, files === 0 ? 'Nothing is kept yet.' : `${files.toLocaleString()} files, ${formatBytes(bytes)}, ${where}.`, storeInMemory ? 'warn' : 'info');
  ui.zipParts.replaceChildren();
  for (const part of storeParts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zip-part primary';
    button.textContent = part.count === 1 ? 'Save as .zip' : `Save part ${part.index} of ${part.count} (.zip)`;
    button.title = `${part.entries.toLocaleString()} files and folders, about ${formatBytes(part.bytes)} before compression`;
    button.addEventListener('click', () => void saveZip(part));
    ui.zipParts.append(button);
  }
  ui.clearQuestion.textContent = `Remove ${files.toLocaleString()} files (${formatBytes(bytes)}) from this browser? Quip is not touched, and a .zip you already saved stays where it is. Anything not saved as a .zip yet is gone; exporting again makes a new copy.`;
}

/** Reads what the store holds, and what .zip files it would make, so the panel shows the truth after every change. */
async function readStore(): Promise<void> {
  if (!storeMode) return;
  try {
    const open = await openStore();
    storeStats = await open.stats();
    const budget = __E2E__ && params.has('partEntries') ? { maxEntries: Number(params.get('partEntries')) } : {};
    storeParts = storeStats.files > 0 ? await open.zipParts(budget) : [];
  } catch (err) {
    storeStats = { files: 0, bytes: 0 };
    storeParts = [];
    setStatus(ui.runStatus, `The browser's storage could not be read: ${describeError(err)}`, 'error');
  }
  if (storeStats.files === 0) confirmingClear = false;
  renderStorePanel();
  refresh();
}

/** Builds one .zip of the stored export and hands it to the browser, which saves it. */
async function saveZip(part: ZipPart): Promise<void> {
  const name = zipFileName(part);
  building = true;
  refresh();
  setStatus(ui.runStatus, `Building ${name}…`);
  try {
    // Shared: several tabs may read the store at once, but not while one of them is exporting or clearing it.
    const blob = await navigator.locks.request(RUN_LOCK, { mode: 'shared', ifAvailable: true }, async (lock) => (lock ? part.build() : undefined));
    if (!blob) {
      setStatus(ui.runStatus, BUSY_ELSEWHERE, 'warn');
      return;
    }
    const url = download(blob, name, ZIP_LINK_MS);
    setStatus(ui.runStatus, `${name} (${formatBytes(blob.size)}) was sent to your browser to save.`, 'ok');
    // A browser that wants a click on the file itself, not on a button that had to build it first, gets that here.
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.textContent = 'Save it again';
    ui.runStatus.append(' ', link);
    window.setTimeout(() => link.remove(), ZIP_LINK_MS);
  } catch (err) {
    setStatus(ui.runStatus, `Could not build ${name}: ${describeError(err)}`, 'error');
    // What is stored may have changed in another tab, so the buttons offered may no longer fit it.
    await readStore();
  } finally {
    building = false;
    refresh();
  }
}

async function clearStore(): Promise<void> {
  await exclusive(async () => {
    try {
      // Alone: another tab may be exporting into the store, or saving it as a .zip.
      const cleared = await navigator.locks.request(RUN_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        await (await openStore()).clear();
        return true;
      });
      confirmingClear = false;
      if (!cleared) {
        await readStore();
        setStatus(ui.runStatus, BUSY_ELSEWHERE, 'warn');
        return;
      }
      epoch += 1;
      session = undefined;
      hidePlan();
      await readStore();
      setStatus(ui.runStatus, 'The copy kept in this browser was cleared. The next export starts from nothing.', 'ok');
    } catch (err) {
      setStatus(ui.runStatus, `Could not clear it: ${describeError(err)}`, 'error');
    }
  });
}

// ---- connection and scope ------------------------------------------------

function selectedRoots(): string[] {
  return [...ui.roots.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
}

function hasScope(): boolean {
  return ui.scopePage.checked && pageTarget !== undefined ? true : selectedRoots().length > 0;
}

function renderRoots(saved: string[] | null): void {
  ui.roots.replaceChildren();
  const legend = document.createElement('legend');
  legend.textContent = 'Folders';
  ui.roots.append(legend);
  // A selection saved for another account would leave nothing ticked, so it only counts if it matches something here.
  if ((conn?.roots ?? []).length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Connect first to list your folders.';
    ui.roots.append(hint);
  }
  const known = new Set((conn?.roots ?? []).map((r) => r.id));
  const usable = saved?.some((id) => known.has(id)) ? saved : null;
  for (const root of conn?.roots ?? []) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = root.id;
    input.checked = usable ? usable.includes(root.id) : root.defaultOn;
    input.addEventListener('change', onScopeInput);
    const name = document.createElement('span');
    name.textContent = root.title;
    const kind = document.createElement('small');
    kind.textContent = KIND_LABEL[root.kind];
    label.append(input, name, kind);
    ui.roots.append(label);
  }
}

function renderPageScope(): void {
  ui.pageScope.hidden = !pageTarget;
  if (pageTarget) {
    ui.pageLabel.textContent = `${pageTarget.kind === 'folder' ? 'Folder' : 'Document'}: ${pageTarget.title || '(untitled)'}`;
    ui.scopePage.checked = true;
  } else {
    ui.scopeAll.checked = true;
  }
}

interface PageLookup {
  target?: PageTarget;
  /** Why the page cannot be offered as the scope; shown to the user instead of silently falling back to all folders. */
  problem?: string;
}

async function lookUpPage(client: QuipClient, url: string): Promise<PageLookup> {
  const link = parseQuipUrl(url);
  if (!link) return { problem: 'The page you came from is not a Quip document or folder address, so choose the folders to export below.' };
  try {
    const folder = await client.getFolder(link.id);
    if (folder.ok) return { target: { kind: 'folder', id: folder.value.id, title: folder.value.title } };
    const thread = await client.getThread(link.id);
    if (thread.ok && thread.value.type !== 'chat') return { target: { kind: 'document', id: thread.value.id, title: thread.value.title } };
    const why = thread.ok ? 'it is a chat, which cannot be exported' : `this token cannot read it (HTTP ${thread.status || 'no response'})`;
    return { problem: `The page you came from cannot be offered: ${why}.` };
  } catch (err) {
    if (err instanceof AuthError || isAbort(err)) throw err;
    return { problem: `The page you came from could not be looked up: ${describeError(err)}` };
  }
}

/** Where each browser lets a person give an extension access to a site. */
function accessHelp(): string {
  const site = SITE_HOST;
  switch (TARGET) {
    case 'safari':
      return `In Safari, open Settings → Extensions → Quipendo and set ${site} to Allow.`;
    case 'firefox':
      return `In Firefox, open the add-ons manager (about:addons), choose Quipendo, then Permissions, and allow it to access your data for ${site}.`;
    default:
      return `Open the extensions page of your browser, choose Quipendo, then Details, and allow it on ${site} under Site access.`;
  }
}

function showAccessNotice(): void {
  const missing = hostAccess === false;
  ui.accessNotice.hidden = !missing;
  if (missing) setStatus(ui.accessNotice, `Your browser has not given Quipendo access to ${SITE_HOST} yet. Press Connect and allow it when asked.`, 'warn');
}

const connectedText = (): string => {
  const user = conn?.user;
  const site = user?.siteUrl ? ` (${new URL(user.siteUrl).host})` : '';
  return `Connected as ${user?.name || 'your account'}${site}.`;
};

async function connect(): Promise<void> {
  await exclusive(async () => {
    const token = ui.token.value.trim();
    if (!token) {
      setStatus(ui.connectStatus, 'Paste your Quip access token first.', 'warn');
      return;
    }
    // A browser only asks the user for access when the request comes straight from the click, so nothing is awaited before it.
    if (hostAccess === false) {
      const granted = await requestHostAccess(BASE_URL);
      hostAccess = granted ? true : false;
      showAccessNotice();
      if (!granted) {
        setStatus(ui.connectStatus, `Quipendo was not allowed to contact ${SITE_HOST}, so it cannot connect. ${accessHelp()}`, 'error');
        return;
      }
    }
    controller = new AbortController();
    setPhase('connecting');
    setStatus(ui.connectStatus, 'Connecting…');
    try {
      const client = new QuipClient({ token, baseUrl: BASE_URL, signal: controller.signal });
      const user = await client.currentUser();
      const choices = rootChoices(user);
      const folders = await client.getFolders(choices.map((c) => c.id));
      const roots = choices.map((c) => {
        const found = folders.get(c.id);
        return { ...c, title: (found?.ok && found.value.title) || KIND_LABEL[c.kind] };
      });
      conn = { token, user, roots };
      epoch += 1;
      session = undefined;
      const lookup = fromUrl ? await lookUpPage(client, fromUrl) : {};
      pageTarget = lookup.target;
      hidePlan();
      if (pageTarget?.kind === 'document' && fromUrl && !ui.previewUrl.value) ui.previewUrl.value = fromUrl;
      await saveToken(token, ui.remember.checked);
      const settings = await loadSettings();
      renderRoots(settings.roots);
      renderPageScope();
      setStatus(ui.connectStatus, lookup.problem ? `${connectedText()} ${lookup.problem}` : connectedText(), lookup.problem ? 'warn' : 'ok');
      setPhase('connected');
    } catch (err) {
      conn = undefined;
      // No answer at all, as opposed to a refusal from Quip, is what a browser that withholds the site gives.
      const noAnswer = err instanceof Error && err.message.startsWith('Network error');
      setStatus(
        ui.connectStatus,
        isAbort(err) ? 'Connecting was cancelled.' : noAnswer ? `${describeError(err)} If your browser has not allowed Quipendo to contact ${SITE_HOST}: ${accessHelp()}` : describeError(err),
        isAbort(err) ? 'warn' : 'error',
      );
      setPhase('idle');
    }
  });
}

/** Points the "only what I was viewing" scope at a Quip page without reconnecting. Shows as busy, and can be stopped, while it looks the page up. */
async function selectPage(url: string): Promise<void> {
  fromUrl = url;
  if (!conn) return;
  const { token } = conn;
  controller = new AbortController();
  setPhase('connecting');
  setStatus(ui.connectStatus, 'Looking up the Quip page you selected…');
  try {
    const lookup = await lookUpPage(new QuipClient({ token, baseUrl: BASE_URL, signal: controller.signal }), url);
    pageTarget = lookup.target;
    renderPageScope();
    // The scope changed, so a scan shown for the old one no longer applies.
    hidePlan();
    setStatus(ui.connectStatus, lookup.problem ? `${connectedText()} ${lookup.problem}` : connectedText(), lookup.problem ? 'warn' : 'ok');
    setPhase('connected');
  } catch (err) {
    if (err instanceof AuthError) {
      rejectToken();
      setPhase('idle');
      return;
    }
    setStatus(ui.connectStatus, `${connectedText()} ${isAbort(err) ? 'The page lookup was stopped.' : describeError(err)}`, 'warn');
    setPhase('connected');
  }
}

// ---- scan and export -----------------------------------------------------

/** Local midnight of the chosen day, in the microseconds Quip uses; undefined when no day is chosen. */
function sinceUsec(): number | undefined {
  const [y, m, d] = ui.since.value.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d).getTime() * 1000;
}

/**
 * What to export. A scan ignores what was unticked in the tree (the tree is drawn from the scan), so the tree always
 * shows everything; the export itself leaves the unticked out.
 */
function buildOptions(withExclusions = true): Partial<ExportOptions> {
  const max = Number.parseInt(ui.max.value, 10);
  const since = sinceUsec();
  const options: Partial<ExportOptions> = {
    includeComments: ui.comments.checked,
    anchorComments: ui.anchor.checked,
    keepRaw: ui.raw.checked,
    saveXlsx: ui.xlsx.checked,
    saveDocx: ui.docx.checked,
    saveEditHistory: ui.edits.checked && ui.raw.checked,
    skipUnchanged: ui.skip.checked,
    includeUnfiled: ui.unfiled.checked,
    maxDocs: Number.isFinite(max) && max > 0 ? max : undefined,
    ...(since !== undefined ? { sinceUsec: since } : {}),
    ...(withExclusions && excluded.size > 0 ? { excludeIds: [...excluded].sort() } : {}),
    siteUrl: conn?.user.siteUrl,
    ownerId: conn?.user.id,
    allRootIds: conn?.roots.filter((r) => r.kind !== 'starred').map((r) => r.id) ?? [],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  if (ui.scopePage.checked && pageTarget) {
    options.includeUnfiled = false;
    if (pageTarget.kind === 'folder') options.rootIds = [pageTarget.id];
    else {
      options.rootIds = [];
      options.threadIds = [pageTarget.id];
    }
  } else {
    options.rootIds = selectedRoots();
  }
  return options;
}

function handleEvent(event: ExportEvent): void {
  switch (event.type) {
    case 'phase':
      if (event.phase === 'export') exportStartedAt = Date.now();
      setStatus(phase === 'scanning' ? ui.scanStatus : ui.runStatus, event.message);
      log(event.message);
      break;
    case 'doc':
      throttleUntil = 0;
      ui.progress.max = Math.max(1, event.total);
      ui.progress.value = event.index;
      setStatus(ui.runStatus, `${event.index} of ${event.total}: ${event.title}${timeLeft(exportStartedAt, event.index, event.total)}`);
      if (event.status === 'exported') log(`Saved ${event.path}`);
      if (event.status === 'failed') log(`Failed: ${event.title} (${event.message ?? 'unknown error'})`, 'error');
      break;
    case 'throttle':
      throttleUntil = Date.now() + event.waitMs;
      log(`Quip's rate limit was reached; waiting ${duration(event.waitMs)} before continuing.`, 'warn');
      break;
    case 'log':
      log(event.message, event.level);
      break;
  }
}

async function makeSession(signal: AbortSignal, withExclusions = true): Promise<ReturnType<typeof createSession>> {
  if (!conn || !hasDestination()) throw new Error('Connect to Quip and choose where to save first.');
  const sink = storeMode ? await openStore() : new FsaSink(target as FileSystemDirectoryHandle);
  return createSession({
    token: conn.token,
    baseUrl: BASE_URL,
    sink,
    parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
    options: buildOptions(withExclusions),
    signal,
    onEvent: handleEvent,
    // Test builds skip the politeness delay because the mock server has no rate limit.
    ...(E2E ? { client: { minIntervalMs: 0 } } : {}),
  });
}

const scopeKey = (withExclusions = true): string => JSON.stringify([buildOptions(withExclusions), epoch, storeMode]);

/** Wipes the token from the page and from both kinds of browser storage, and disconnects. */
async function forgetToken(): Promise<void> {
  await exclusive(async () => {
    await sessionStore.remove('token');
    await ext.storage.local.remove('token');
    ui.token.value = '';
    ui.remember.checked = false;
    conn = undefined;
    session = undefined;
    epoch += 1;
    pageTarget = undefined;
    renderRoots(null);
    renderPageScope();
    hidePlan();
    setStatus(ui.connectStatus, 'The token was removed from this page and from the browser. Paste a token to connect again.');
    setPhase('idle');
  });
}

/** A rejected token disconnects, so nothing else is attempted until a working one is entered. */
function rejectToken(): void {
  conn = undefined;
  session = undefined;
  setStatus(ui.connectStatus, TOKEN_REJECTED, 'error');
}

/** Runs one connect, scan, export or page lookup at a time; a Quip page picked meanwhile is applied afterwards. */
async function exclusive(task: () => Promise<void>): Promise<void> {
  if (working) return;
  working = true;
  try {
    await task();
  } finally {
    working = false;
    const url = pendingFrom;
    pendingFrom = undefined;
    if (url) void exclusive(() => selectPage(url));
  }
}

function showPlan(plan: Plan): void {
  const perTop = new Map<string, number>();
  for (const t of plan.threads) {
    const top = t.path.includes('/') ? (t.path.split('/')[0] as string) : '(top level)';
    perTop.set(top, (perTop.get(top) ?? 0) + 1);
  }
  const lines = [`${plan.threads.length} documents in ${plan.folders.length} folders.`, ...[...perTop].map(([name, n]) => `  ${name}: ${n}`)];
  if (plan.unfiled > 0) lines.push(`${plan.unfiled} documents you wrote sit in no folder; they go under "_Unfiled".`);
  if (plan.othersUnfiled > 0) lines.push(`${plan.othersUnfiled} documents written by other people are in none of your folders and are not exported.`);
  if (plan.leftOut.older > 0) lines.push(`${plan.leftOut.older} documents last changed before ${ui.since.value} are left out.`);
  if (plan.relocated.length > 0) lines.push(`${plan.relocated.length} documents get a new file name or folder (moved or renamed in Quip, or the old file name is taken); the old copy stays.`);
  const unreadable = plan.unreadableFolders.length + plan.unreadableThreads.length;
  if (unreadable > 0) lines.push(`${unreadable} items could not be read with this token and will be listed in the report.`);
  // What is inside a folder that cannot be read is unknown, so the user decides before anything is written.
  const unknownFolders = plan.unreadableFolders.length + plan.unreadableUnselected.length;
  if (unknownFolders > 0 && ui.unfiled.checked) {
    lines.push(`${unknownFolders} folder${unknownFolders === 1 ? '' : 's'} could not be read, so documents you wrote inside ${unknownFolders === 1 ? 'it' : 'them'} may also be exported under "_Unfiled". Untick "Include documents you wrote that are in no folder" and scan again to leave them out.`);
  }
  lines.push('', `About ${plan.estimatedRequests} Quip API requests. How long that takes depends on the speed Quip allows for your account; an estimate appears once the export is running.`);
  ui.scanSummary.textContent = lines.join('\n');
  ui.scanSummary.hidden = false;
  if (plan.threads.length > 0) {
    ui.treePanel.hidden = false;
    tree = renderPlanTree(ui.tree, plan, excluded, onTreeChange);
    excluded = new Set(tree.excluded());
    updateTreeCount();
  }
}

function updateTreeCount(): void {
  const counts = tree?.counts();
  ui.treeCount.textContent = counts ? `${counts.selected} of ${counts.total} documents ticked` : '';
}

function onTreeChange(): void {
  excluded = new Set(tree?.excluded() ?? []);
  updateTreeCount();
  refresh();
}

/** What a scan covers changed (folders, date, limit), so the scan on screen, and what was unticked in it, no longer apply. */
function onScopeInput(): void {
  if (tree || !ui.scanSummary.hidden) hidePlan();
  refresh();
}

/** Hides the scan result and the tree. A re-scan keeps what was unticked; anything else that changes the scope forgets it. */
function hidePlan(keepSelection = false): void {
  ui.scanSummary.hidden = true;
  ui.treePanel.hidden = true;
  ui.tree.replaceChildren();
  ui.treeFilter.value = '';
  ui.treeCount.textContent = '';
  tree = undefined;
  if (!keepSelection) excluded = new Set();
}

async function scan(): Promise<void> {
  if (!conn || !hasDestination()) return;
  await exclusive(async () => {
    try {
      controller = new AbortController();
      // The scan ignores what was unticked, so the tree always shows everything; the export leaves it out.
      session = await makeSession(controller.signal, false);
      sessionKey = scopeKey(false);
      await saveSettings();
      hidePlan(true);
      setPhase('scanning');
      setStatus(ui.scanStatus, 'Scanning…');
      showPlan(await session.exporter.scan());
      setStatus(ui.scanStatus, 'Scan complete. Nothing has been written yet.', 'ok');
      setPhase('scanned');
    } catch (err) {
      session = undefined;
      if (err instanceof AuthError) rejectToken();
      setStatus(ui.scanStatus, isAbort(err) ? 'Scan stopped.' : describeError(err), isAbort(err) ? 'warn' : 'error');
      setPhase(isAbort(err) ? 'connected' : err instanceof AuthError ? 'idle' : 'error');
    }
  });
}

async function acquireWakeLock(): Promise<() => Promise<void>> {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    return async () => {
      await lock?.release().catch(() => undefined);
    };
  } catch {
    return async () => undefined;
  }
}

function summarize(s: ExportSummary): string {
  const parts = [`${s.docs.exported} saved`, `${s.docs.skipped} unchanged`];
  if (s.docs.failed > 0) parts.push(`${s.docs.failed} failed`);
  if (s.docs.notAttempted > 0) parts.push(`${s.docs.notAttempted} not attempted`);
  return `${parts.join(', ')} of ${s.docs.planned} documents. The report is ${s.reportPath} ${storeMode ? 'in the copy kept in this browser' : 'in the target folder'}.`;
}

/**
 * Held by the one exporter tab that is writing, so two tabs can never pick the same file name for different documents.
 * A tab that builds a .zip, which reads what is stored, holds it shared; a tab that clears the store holds it alone, as a run does.
 */
const RUN_LOCK = 'quipendo-run';
const BUSY_ELSEWHERE = 'Another exporter tab is exporting, saving or clearing this export. Wait for it to finish or close it, then try again.';

/** Runs one export and says which phase to end in. The caller applies it last, once nothing is left to wait for. */
async function runExport(): Promise<Phase> {
  let release: () => Promise<void> = async () => undefined;
  try {
    // Another tab may have exported since this one scanned: its saved state and plan are then out of date.
    if (session && !(await session.exporter.isStateCurrent())) session = undefined;
    if (!session || !controller || controller.signal.aborted || sessionKey !== scopeKey()) {
      controller = new AbortController();
      session = await makeSession(controller.signal);
      sessionKey = scopeKey();
    }
    if (stopRequested) {
      setStatus(ui.runStatus, 'Stopped before anything was written.', 'warn');
      return 'stopped';
    }
    const active = session;
    await saveSettings();
    release = await acquireWakeLock();
    const summary = await active.exporter.run();
    if (summary.aborted) {
      setStatus(ui.runStatus, `Stopped. ${summarize(summary)} Start again to continue where it left off.`, 'warn');
      return 'stopped';
    }
    ui.progress.value = ui.progress.max;
    setStatus(ui.runStatus, `Done. ${summarize(summary)}`, summary.docs.failed > 0 ? 'warn' : 'ok');
    return 'done';
  } catch (err) {
    if (err instanceof AuthError) rejectToken();
    const kept = storeMode ? 'What was exported so far is kept in this browser.' : 'Progress so far is saved.';
    const message = err instanceof AuthError ? `Stopped: ${TOKEN_REJECTED} ${kept} The report lists what was not exported.` : describeError(err);
    setStatus(ui.runStatus, isAbort(err) ? `Stopped. ${kept}` : message, isAbort(err) ? 'warn' : 'error');
    log(describeError(err), 'error');
    return isAbort(err) ? 'stopped' : err instanceof AuthError ? 'idle' : 'error';
  } finally {
    session = undefined;
    await release();
  }
}

async function run(): Promise<void> {
  if (!conn || !hasDestination()) return;
  await exclusive(async () => {
    const before = phase;
    stopRequested = false;
    // At once, so the click is visibly taken and nothing else can start while the lock is being asked for.
    // The log is cleared here, not later, so a message that arrives meanwhile is not wiped out.
    ui.log.replaceChildren();
    ui.progress.value = 0;
    setPhase('running');
    setStatus(ui.runStatus, 'Starting…');
    let final: Phase = before;
    const started = await navigator.locks.request(RUN_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      final = await runExport();
      return true;
    });
    if (!started) setStatus(ui.runStatus, BUSY_ELSEWHERE, 'warn');
    await readStore();
    // Last, with nothing asynchronous after it: the page never shows "done" while a click would still be ignored.
    setPhase(final);
  });
}

// ---- preview and saving a .zip -------------------------------------------

/** Hands a file to the browser's downloads and returns the address it can be fetched from until `keepMs` have passed. */
function download(blob: Blob, name: string, keepMs = 60_000): string {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), keepMs);
  return url;
}

/** How long a built .zip stays available for "Save it again": long enough to retry, short enough not to hold a gigabyte for hours. */
const ZIP_LINK_MS = 10 * 60_000;

/** What the converter notes about a document, in words. Anything not listed shows as its code. */
const NOTE_TEXT: Record<string, string> = {
  'ambiguous-date': 'a date that may be a day off (Quip does not say which time zone it was written in)',
  'empty-html': 'Quip sent no content (often a permissions issue)',
  'comments-incomplete': 'some comments could not be listed',
  'nested-table-flattened': 'a table inside a table was flattened',
  'liveapp-truncated': 'a calendar, board or tracker was shortened',
  'unknown-live-app': 'an embedded app this tool does not know',
  'live-app-no-data': 'an embedded app sent no data',
};

/** Converts one document without saving anything or downloading attachments, so a person can see what an export would make of it. */
async function preview(): Promise<void> {
  if (!conn) return;
  const id = quipIdFrom(ui.previewUrl.value);
  if (!id) {
    setStatus(ui.previewStatus, 'Paste the address of a Quip document, such as https://your-site.quip.com/AbCdEfGhIjKl/Title.', 'warn');
    return;
  }
  await exclusive(async () => {
    if (!conn) return;
    const before = phase;
    controller = new AbortController();
    ui.previewResult.hidden = true;
    setPhase('previewing');
    setStatus(ui.previewStatus, 'Reading the document…');
    try {
      const { exporter } = createSession({
        token: conn.token,
        baseUrl: BASE_URL,
        sink: new MemorySink(),
        parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
        options: {
          includeComments: ui.comments.checked,
          anchorComments: ui.anchor.checked,
          siteUrl: conn.user.siteUrl,
          ownerId: conn.user.id,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        signal: controller.signal,
        ...(E2E ? { client: { minIntervalMs: 0 } } : {}),
      });
      const result = await exporter.preview(id);
      previewedTitle = result.title;
      ui.previewText.value = result.markdown;
      ui.previewResult.hidden = false;
      // Every link to another document counts as "outside" here, since nothing was exported for it to point at.
      const notes = [...new Set(result.warnings.map((w) => w.code))].filter((code) => code !== 'link-outside-export').map((code) => NOTE_TEXT[code] ?? code);
      setStatus(ui.previewStatus, `${result.title} (${result.type}). Nothing was saved.${notes.length > 0 ? ` Notes: ${notes.join('; ')}.` : ''}`, 'ok');
      setPhase(before);
    } catch (err) {
      if (err instanceof AuthError) {
        rejectToken();
        setStatus(ui.previewStatus, TOKEN_REJECTED, 'error');
        setPhase('idle');
        return;
      }
      setStatus(ui.previewStatus, isAbort(err) ? 'Preview stopped.' : describeError(err), isAbort(err) ? 'warn' : 'error');
      setPhase(before);
    }
  });
}

async function copyPreview(): Promise<void> {
  try {
    await navigator.clipboard.writeText(ui.previewText.value);
    setStatus(ui.previewStatus, 'Copied the Markdown to the clipboard.', 'ok');
  } catch {
    ui.previewText.select();
    setStatus(ui.previewStatus, 'The browser would not copy it for you. The text is selected: press Ctrl+C (⌘C on a Mac).', 'warn');
  }
}

function downloadPreview(): void {
  // eslint-disable-next-line no-control-regex
  const name = `${previewedTitle.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'Quip document'}.md`;
  download(new Blob([ui.previewText.value], { type: 'text/markdown' }), name);
}

/** Switches between saving to a folder and keeping the export in the browser. Whatever was scanned belongs to the other choice. */
async function setOutput(inBrowser: boolean): Promise<void> {
  storeMode = inBrowser;
  epoch += 1;
  session = undefined;
  confirmingClear = false;
  hidePlan();
  refresh();
  void saveSettings();
  await readStore();
}

// ---- start-up ------------------------------------------------------------

function applySettings(s: Settings): void {
  ui.remember.checked = s.remember;
  ui.comments.checked = s.includeComments;
  ui.anchor.checked = s.anchorComments;
  ui.raw.checked = s.keepRaw;
  ui.xlsx.checked = s.saveXlsx;
  ui.docx.checked = s.saveDocx;
  ui.edits.checked = s.saveEditHistory;
  ui.skip.checked = s.skipUnchanged;
  ui.unfiled.checked = s.includeUnfiled;
  ui.max.value = s.maxDocs;
  // A browser that cannot write into a folder keeps the export in itself, whatever was saved.
  storeMode = s.output === 'store' || !CAN_PICK_FOLDER;
  ui.outStore.checked = storeMode;
  ui.outFolder.checked = !storeMode;
}

/** Brings this page's tab and window to the front, for when the toolbar button is pressed while it is open somewhere else. */
async function bringForward(): Promise<void> {
  try {
    const tab = await ext.tabs.getCurrent();
    if (tab?.id !== undefined) await ext.tabs.update(tab.id, { active: true });
    if (tab?.windowId !== undefined) await ext.windows.update(tab.windowId, { focused: true });
  } catch {
    // Best effort: a browser that will not switch tabs for an extension leaves the page where it is.
  }
}

/** The toolbar button asks whether an exporter page is open; this one answers, and takes the Quip page it was pressed on. */
function listenForToolbarButton(): void {
  ext.runtime.onMessage.addListener((msg: { type?: string; url?: string } | undefined, _sender, sendResponse) => {
    if (msg?.type !== 'quip-source-url') return;
    // Answered at once, so the button knows this page is open and does not open another one.
    sendResponse({ handled: true });
    void bringForward();
    const url = msg.url;
    if (!url) return;
    if (working) {
      pendingFrom = url;
      log('Another Quip page was selected. It will be offered when the current task finishes.', 'warn');
      return;
    }
    void exclusive(() => selectPage(url));
  });
}

async function init(): Promise<void> {
  listenForToolbarButton();
  ui.version.textContent = ext.runtime.getManifest().version;
  const guard = await installReadOnlyGuard();
  ui.guard.textContent = guard.active ? 'Browser-level read-only guard: on' : `Browser-level read-only guard: unavailable (${guard.detail})`;
  ui.guard.dataset.tone = guard.active ? 'ok' : 'warn';

  applySettings(await loadSettings());
  if (CAN_PICK_FOLDER) await restoreTarget();
  hostAccess = await hasHostAccess(BASE_URL);
  showAccessNotice();
  // Whatever an earlier visit kept is shown at once, so a run that was cut short can be saved or continued.
  await readStore();
  if (__E2E__ && E2E) (await import('./e2eHooks')).installTestHooks({ target: () => target, store: () => (storeMode ? store : undefined), useTarget });

  ui.connect.addEventListener('click', () => void connect());
  ui.forget.addEventListener('click', () => void forgetToken());
  ui.token.addEventListener('keydown', (e) => e.key === 'Enter' && void connect());
  ui.pick.addEventListener('click', () => void pickTarget());
  ui.regrant.addEventListener('click', () => void regrantTarget());
  ui.scan.addEventListener('click', () => void scan());
  ui.run.addEventListener('click', () => void run());
  ui.preview.addEventListener('click', () => void preview());
  ui.previewUrl.addEventListener('keydown', (e) => e.key === 'Enter' && void preview());
  ui.copy.addEventListener('click', () => void copyPreview());
  ui.downloadMd.addEventListener('click', downloadPreview);
  for (const el of [ui.outFolder, ui.outStore]) el.addEventListener('change', () => void setOutput(ui.outStore.checked));
  ui.clear.addEventListener('click', () => {
    confirmingClear = true;
    refresh();
  });
  ui.clearNo.addEventListener('click', () => {
    confirmingClear = false;
    refresh();
  });
  ui.clearYes.addEventListener('click', () => void clearStore());
  ui.treeFilter.addEventListener('input', () => tree?.setFilter(ui.treeFilter.value));
  ui.treeAll.addEventListener('click', () => tree?.tickShown(true));
  ui.treeNone.addEventListener('click', () => tree?.tickShown(false));
  for (const el of [ui.comments, ui.raw]) el.addEventListener('change', refresh);
  for (const el of [ui.unfiled, ui.since, ui.max, ui.scopeAll, ui.scopePage]) el.addEventListener('change', onScopeInput);
  ui.max.addEventListener('input', onScopeInput);
  ui.stop.addEventListener('click', () => {
    stopRequested = true;
    controller?.abort();
  });
  ui.remember.addEventListener('change', () => {
    // Unticking must take effect now, not at the next connect.
    if (!ui.remember.checked) void ext.storage.local.remove('token');
    else if (conn) void ext.storage.local.set({ token: conn.token });
    void saveSettings();
  });
  window.addEventListener('beforeunload', (e) => {
    if (phase === 'running') e.preventDefault();
  });
  // Another tab may have exported into, or cleared, the store while this one was in the background.
  const refreshStore = (): void => {
    if (!document.hidden && !working && !building && phase !== 'running') void readStore();
  };
  window.addEventListener('focus', refreshStore);
  document.addEventListener('visibilitychange', refreshStore);
  window.setInterval(() => {
    const left = throttleUntil - Date.now();
    if (left > 0 && (phase === 'running' || phase === 'scanning')) {
      setStatus(phase === 'running' ? ui.runStatus : ui.scanStatus, `Waiting for Quip's rate limit: ${duration(left)} left.`, 'warn');
    }
  }, 1000);

  const stored = E2E ? (params.get('token') ?? undefined) : await loadToken();
  if (stored) ui.token.value = stored;
  setPhase('idle');
}

void init();
