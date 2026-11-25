/** The address pattern of a Quip page the toolbar button may offer as the scope of an export. */
const QUIP_PAGE = /^https:\/\/([a-z0-9-]+\.)?quip\.com\//i;

/** The parts of the extension API the toolbar button needs. */
export interface ExporterApi {
  runtime: {
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
  };
  tabs: { create(properties: { url: string }): Promise<unknown> };
}

/**
 * What the toolbar button does: show the exporter page, offering the Quip page the user was on as the scope of the export.
 * An exporter page that is already open answers the message, brings itself forward and takes the Quip page. Asking by
 * message, not by listing tabs, needs no permission to see tab addresses, so it works the same in every browser.
 */
export async function openExporter(api: ExporterApi, tab: { url?: string }): Promise<void> {
  const from = tab.url && QUIP_PAGE.test(tab.url) ? tab.url : undefined;
  const answered = await api.runtime.sendMessage({ type: 'quip-source-url', ...(from ? { url: from } : {}) }).then(
    (reply) => (reply as { handled?: boolean } | undefined)?.handled === true,
    () => false, // nothing is listening: no exporter page is open
  );
  if (answered) return;
  const page = api.runtime.getURL('exporter.html');
  await api.tabs.create({ url: from ? `${page}?from=${encodeURIComponent(from)}` : page });
}
