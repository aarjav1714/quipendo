import { TARGET, ext, type BrowserTarget } from './webext';

const GUARD_RULE_ID = 1;

/** The browsers whose request-blocking rules apply to an extension's own requests. Safari's do not (see below). */
type RuleBrowser = Exclude<BrowserTarget, 'safari'>;

/**
 * Methods that can change something on a server. GET, HEAD and OPTIONS stay allowed.
 * Each browser accepts its own list and refuses the whole rule over a name it does not know; Chrome and Firefox
 * both have "other" for any unusual method.
 */
const COMMON_METHODS = ['post', 'put', 'delete', 'patch', 'connect'];
const WRITE_METHODS: Record<RuleBrowser, string[]> = {
  chrome: [...COMMON_METHODS, 'other'],
  firefox: [...COMMON_METHODS, 'other'],
};

/** The kinds of request every browser can name in a rule. */
const COMMON_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];

/**
 * The kinds of request each browser accepts in a rule; naming one it does not know makes it refuse the whole rule.
 * Chrome knows them all; Firefox has no web transport or web bundles.
 */
const RESOURCE_TYPES: Record<RuleBrowser, string[]> = {
  chrome: [...COMMON_TYPES, 'object', 'csp_report', 'webtransport', 'webbundle'],
  firefox: [...COMMON_TYPES, 'object', 'csp_report'],
};

export type GuardRule = chrome.declarativeNetRequest.Rule;

/**
 * Blocks every request that is not a plain read, to any web address, when it comes from this
 * extension. The extension has no reason to change anything anywhere, so the rule is not limited to Quip.
 *
 * `initiatorHost` is the host of the extension's own address (chrome-extension://<id>/, moz-extension://<uuid>/,
 * safari-web-extension://<uuid>/). That is not always the extension's id: Firefox keeps a separate random one.
 */
export function guardRule(
  initiatorHost: string,
  browser: RuleBrowser = 'chrome',
  types: readonly string[] = RESOURCE_TYPES[browser],
  methods: readonly string[] = WRITE_METHODS[browser],
): GuardRule {
  return {
    id: GUARD_RULE_ID,
    priority: 1,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      regexFilter: '^https?://',
      requestMethods: [...methods] as chrome.declarativeNetRequest.RequestMethod[],
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
 * Safari takes such rules (they install without an error) but never applies them to the requests an extension's own
 * pages make: tested on Safari 27, where a rule blocking every request to a server, with no condition on who sends
 * it, let all of them through. So the Safari build neither asks for the permission nor claims the guard.
 */
const SAFARI_NOTE = "Safari does not apply request-blocking rules to an extension's own requests. The extension still sends only GET requests, and its pages can only connect to platform.quip.com";

/**
 * Second line of defence behind the client's own allow-list: the browser itself refuses any write
 * request this extension tries to send. Even a bug could not edit a document.
 */
export async function installReadOnlyGuard(browser: BrowserTarget = TARGET): Promise<GuardStatus> {
  if (browser === 'safari') return { active: false, detail: SAFARI_NOTE };
  const dnr = ext.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return { active: false, detail: 'declarativeNetRequest is unavailable in this browser' };
  const host = new URL(ext.runtime.getURL('')).host;
  // A version of the browser that knows fewer kinds of request or methods than expected gets the lists every browser knows.
  const attempts: Array<[readonly string[], readonly string[]]> = [
    [RESOURCE_TYPES[browser], WRITE_METHODS[browser]],
    [COMMON_TYPES, COMMON_METHODS],
  ];
  let failure: unknown;
  for (const [types, methods] of attempts) {
    try {
      await dnr.updateDynamicRules({ removeRuleIds: [GUARD_RULE_ID], addRules: [guardRule(host, browser, types, methods)] });
      return { active: true, detail: 'The browser blocks every POST, PUT, PATCH and DELETE this extension sends to any address.' };
    } catch (err) {
      failure ??= err;
    }
  }
  return { active: false, detail: `Could not install the browser-level guard: ${failure instanceof Error ? failure.message : String(failure)}` };
}
