import { TARGET, ext, type BrowserTarget } from './webext';

const GUARD_RULE_ID = 1;

/** Methods that can change something on a server. GET, HEAD and OPTIONS stay allowed. */
const WRITE_METHODS = ['post', 'put', 'delete', 'patch', 'connect', 'other'];

/** The kinds of request every browser can name in a rule. */
const COMMON_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];

/**
 * The kinds of request each browser accepts in a rule; naming one it does not know makes it refuse the whole rule.
 * Chrome knows them all, Firefox has no web transport or web bundles, and Safari only the common ones.
 */
const RESOURCE_TYPES: Record<BrowserTarget, string[]> = {
  chrome: [...COMMON_TYPES, 'object', 'csp_report', 'webtransport', 'webbundle'],
  firefox: [...COMMON_TYPES, 'object', 'csp_report'],
  safari: COMMON_TYPES,
};

export type GuardRule = chrome.declarativeNetRequest.Rule;

/**
 * Blocks every request that is not a plain read, to any web address, when it comes from this
 * extension. The extension has no reason to change anything anywhere, so the rule is not limited to Quip.
 *
 * `initiatorHost` is the host of the extension's own address (chrome-extension://<id>/, moz-extension://<uuid>/,
 * safari-web-extension://<uuid>/). That is not always the extension's id: Firefox keeps a separate random one.
 */
export function guardRule(initiatorHost: string, browser: BrowserTarget = 'chrome', types: readonly string[] = RESOURCE_TYPES[browser]): GuardRule {
  return {
    id: GUARD_RULE_ID,
    priority: 1,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      regexFilter: '^https?://',
      requestMethods: WRITE_METHODS as chrome.declarativeNetRequest.RequestMethod[],
      resourceTypes: [...types] as chrome.declarativeNetRequest.ResourceType[],
      initiatorDomains: [initiatorHost],
    },
  };
}

export interface GuardStatus {
  active: boolean;
  detail: string;
}

/**
 * Second line of defence behind the client's own allow-list: the browser itself refuses any write
 * request this extension tries to send. Even a bug could not edit a document.
 */
export async function installReadOnlyGuard(browser: BrowserTarget = TARGET): Promise<GuardStatus> {
  const dnr = ext.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return { active: false, detail: 'declarativeNetRequest is unavailable in this browser' };
  const host = new URL(ext.runtime.getURL('')).host;
  // A version of the browser that knows fewer kinds of request than expected gets the list every browser knows.
  const attempts = [RESOURCE_TYPES[browser], ...(browser === 'safari' ? [] : [COMMON_TYPES])];
  let failure: unknown;
  for (const types of attempts) {
    try {
      await dnr.updateDynamicRules({ removeRuleIds: [GUARD_RULE_ID], addRules: [guardRule(host, browser, types)] });
      return { active: true, detail: 'The browser blocks every POST, PUT, PATCH and DELETE this extension sends to any address.' };
    } catch (err) {
      failure ??= err;
    }
  }
  return { active: false, detail: `Could not install the browser-level guard: ${failure instanceof Error ? failure.message : String(failure)}` };
}
