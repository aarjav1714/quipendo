import { openExporter } from './openExporter';
import { ext } from './ui/webext';

declare const __E2E__: boolean;

/** Opens (or focuses) the exporter page; if the user was on a Quip page, offers it as the export scope. */
ext.action.onClicked.addListener((tab) => void openExporter(ext, tab));

if (__E2E__) {
  // A test cannot click the browser's toolbar, so a page asks for the same thing by message. `nobodyListens` pretends no
  // exporter page is open, to reach the part that opens a new tab even though the page that asked is open.
  ext.runtime.onMessage.addListener((message: { type?: string; url?: string; nobodyListens?: boolean } | undefined, _sender, sendResponse) => {
    if (message?.type !== 'e2e-toolbar') return false;
    const api = message.nobodyListens ? { runtime: { getURL: (path: string) => ext.runtime.getURL(path), sendMessage: () => Promise.reject(new Error('Nobody is listening')) }, tabs: ext.tabs } : ext;
    openExporter(api, { url: message.url }).then(
      () => sendResponse({ done: true }),
      (err: unknown) => sendResponse({ error: String(err) }),
    );
    return true;
  });
}
