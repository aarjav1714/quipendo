import { describe, expect, it } from 'vitest';
import { openExporter, type ExporterApi } from '../../src/openExporter';

const PAGE = 'moz-extension://uuid/exporter.html';

function api(reply: 'handled' | 'silence' | 'nobody'): ExporterApi & { created: string[]; messages: unknown[] } {
  const created: string[] = [];
  const messages: unknown[] = [];
  return {
    created,
    messages,
    runtime: {
      getURL: (path) => `moz-extension://uuid/${path}`,
      sendMessage: async (message) => {
        messages.push(message);
        if (reply === 'nobody') throw new Error('Could not establish connection. Receiving end does not exist.');
        return reply === 'handled' ? { handled: true } : undefined;
      },
    },
    tabs: { create: async ({ url }) => void created.push(url) },
  };
}

describe('the toolbar button', () => {
  it('lets an exporter page that is already open take the Quip page, and opens nothing', async () => {
    const a = api('handled');
    await openExporter(a, { url: 'https://acme.quip.com/AbCdEfGhIjKl/Plan' });
    expect(a.messages).toEqual([{ type: 'quip-source-url', url: 'https://acme.quip.com/AbCdEfGhIjKl/Plan' }]);
    expect(a.created).toEqual([]);
  });

  it('opens the exporter with the Quip page as the scope when no exporter page is open', async () => {
    const a = api('nobody');
    await openExporter(a, { url: 'https://acme.quip.com/AbCdEfGhIjKl/Plan?x=1&y=2' });
    expect(a.created).toEqual([`${PAGE}?from=${encodeURIComponent('https://acme.quip.com/AbCdEfGhIjKl/Plan?x=1&y=2')}`]);
  });

  it('opens the exporter alone when the page is not Quip, or the browser did not say what the page is', async () => {
    for (const url of ['https://example.com/quip.com/x', 'http://acme.quip.com/x', 'https://quip.com.evil.test/x', undefined]) {
      const a = api('nobody');
      await openExporter(a, { url });
      expect(a.created, String(url)).toEqual([PAGE]);
      expect(a.messages, String(url)).toEqual([{ type: 'quip-source-url' }]);
    }
  });

  it('opens a page when the message was heard but not answered (a page still loading)', async () => {
    const a = api('silence');
    await openExporter(a, {});
    expect(a.created).toEqual([PAGE]);
  });
});
