import { describe, expect, it, vi } from 'vitest';
import { guardRule, installReadOnlyGuard } from '../../src/ui/guard';

describe('browser-level guard rule', () => {
  const rule = guardRule('abcdefghijklmnopabcdefghijklmnop');
  const pattern = new RegExp(rule.condition.regexFilter as string);

  it('blocks every way of changing something and leaves reads alone', () => {
    const methods = rule.condition.requestMethods as string[];
    for (const m of ['post', 'put', 'patch', 'delete', 'other']) expect(methods).toContain(m);
    for (const m of ['get', 'head', 'options']) expect(methods).not.toContain(m);
    expect(rule.action.type).toBe('block');
  });

  it('applies to any web address, not just Quip, but only to requests the extension itself makes', () => {
    for (const url of ['https://platform.quip.com/1/threads/edit-document', 'https://acme.quip.com/x', 'https://example.com/', 'http://127.0.0.1:8080/1/x', 'http://localhost/x']) {
      expect(pattern.test(url), url).toBe(true);
    }
    expect(rule.condition.initiatorDomains).toEqual(['abcdefghijklmnopabcdefghijklmnop']);
  });

  it('includes page loads and every sub-resource type, so a form post or beacon cannot slip through', () => {
    const types = rule.condition.resourceTypes as string[];
    for (const t of ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'websocket', 'other']) expect(types).toContain(t);
  });

  it('names only the kinds of request each browser accepts, since one it does not know voids the whole rule', () => {
    const types = (browser: 'chrome' | 'firefox' | 'safari') => guardRule('host', browser).condition.resourceTypes as string[];
    expect(types('chrome')).toEqual(expect.arrayContaining(['webtransport', 'webbundle', 'object', 'csp_report']));
    expect(types('firefox')).toEqual(expect.arrayContaining(['object', 'csp_report']));
    for (const t of ['webtransport', 'webbundle']) expect(types('firefox')).not.toContain(t);
    for (const t of ['webtransport', 'webbundle', 'object', 'csp_report']) expect(types('safari')).not.toContain(t);
    for (const browser of ['chrome', 'firefox', 'safari'] as const) for (const t of ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'websocket', 'other']) expect(types(browser)).toContain(t);
  });
});

describe('installing the guard', () => {
  function withApi(updateDynamicRules: (arg: { addRules: Array<{ condition: { resourceTypes: string[]; initiatorDomains: string[] } }> }) => Promise<void>, url = 'moz-extension://11111111-2222-3333-4444-555555555555/') {
    vi.stubGlobal('chrome', { declarativeNetRequest: { updateDynamicRules }, runtime: { getURL: () => url, id: 'quipendo@example.org' } });
  }

  it("names the extension by the host of its own address, which is not its id in Firefox", async () => {
    const calls: string[][] = [];
    withApi(async (arg) => void calls.push(arg.addRules[0]?.condition.initiatorDomains ?? []));
    expect((await installReadOnlyGuard('firefox')).active).toBe(true);
    expect(calls).toEqual([['11111111-2222-3333-4444-555555555555']]);
    vi.unstubAllGlobals();
  });

  it('falls back to the kinds of request every browser knows when the first list is refused', async () => {
    const tried: string[][] = [];
    withApi(async (arg) => {
      const types = arg.addRules[0]?.condition.resourceTypes ?? [];
      tried.push(types);
      if (types.includes('webtransport')) throw new Error('Invalid enumeration value "webtransport"');
    });
    expect((await installReadOnlyGuard('chrome')).active).toBe(true);
    expect(tried).toHaveLength(2);
    expect(tried[1]).not.toContain('webtransport');
    vi.unstubAllGlobals();
  });

  it('says so, with the browser\'s own words, when no rule can be installed', async () => {
    withApi(() => Promise.reject(new Error('requestMethods is not supported')));
    const status = await installReadOnlyGuard('safari');
    expect(status.active).toBe(false);
    expect(status.detail).toContain('requestMethods is not supported');
    vi.unstubAllGlobals();
  });

  it('says so where the browser has no such API at all', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://abc/' } });
    expect(await installReadOnlyGuard('chrome')).toEqual({ active: false, detail: 'declarativeNetRequest is unavailable in this browser' });
    vi.unstubAllGlobals();
  });
});
