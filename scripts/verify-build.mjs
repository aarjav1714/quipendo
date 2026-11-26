import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GECKO_ANDROID_MIN_VERSION, GECKO_ID, GECKO_MIN_VERSION, SAFARI_MIN_VERSION, TARGETS, parseTarget, targetNames } from './targets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const requested = process.argv.includes('--all') ? targetNames : [parseTarget(flag('--target') ?? 'chrome')];

// Quip's own hosts are the only ones the code ever contacts. These two appear only as text and are never requested:
// example.com is the address documentation is meant to use (the made-up demo documents mention it), and the OOXML namespace
// is a name written inside the .xlsx and .docx files the demo hands out, not an address.
const TEXT_ONLY_HOSTS = new Set(['example.com', 'schemas.openxmlformats.org']);

// One version number: the extension, the npm package and the tool name written into every export must agree.
const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
const toolVersion = /export const TOOL_VERSION = '([^']+)'/.exec(await readFile(`${root}src/core/exporter.ts`, 'utf8'))?.[1];

async function verify(target) {
  const dist = `${root}${TARGETS[target].dir}/`;
  const failures = [];
  const fail = (message) => failures.push(`${target}: ${message}`);

  const manifest = JSON.parse(await readFile(`${dist}manifest.json`, 'utf8'));

  if (manifest.version !== pkg.version || toolVersion !== pkg.version) {
    fail(`versions disagree: manifest ${manifest.version}, package.json ${pkg.version}, TOOL_VERSION ${toolVersion}`);
  }
  if (pkg.private) fail('package.json is still private, so it could not be published');
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://platform.quip.com/*'])) {
    fail(`host_permissions must be exactly platform.quip.com, got ${JSON.stringify(manifest.host_permissions)}`);
  }
  // Safari ignores request-blocking rules for an extension's own requests, so its build does not ask for the permission.
  const allowedPermissions = target === 'safari' ? ['storage', 'activeTab'] : ['storage', 'activeTab', 'declarativeNetRequest'];
  for (const p of manifest.permissions ?? []) if (!allowedPermissions.includes(p)) fail(`unexpected permission: ${p}`);
  if (target !== 'safari' && !(manifest.permissions ?? []).includes('declarativeNetRequest')) fail('the read-only guard needs the declarativeNetRequest permission');
  if (manifest.optional_host_permissions) fail('unexpected optional_host_permissions');

  // Each browser declares the background script and its own settings differently.
  if (manifest.description.length > 132) fail(`the description is ${manifest.description.length} characters; the Chrome Web Store allows 132`);
  if (target === 'chrome') {
    if (manifest.background?.service_worker !== 'background.js') fail('Chrome needs background.service_worker = background.js');
    if (manifest.browser_specific_settings) fail('browser_specific_settings is for Firefox and Safari only');
  } else {
    if (manifest.background?.service_worker) fail('only Chrome runs a service worker; use background.scripts');
    if (JSON.stringify(manifest.background?.scripts) !== JSON.stringify(['background.js'])) fail('background.scripts must be ["background.js"]');
    if (manifest.minimum_chrome_version) fail('minimum_chrome_version is for Chrome only');
  }
  if (target === 'firefox') {
    const gecko = manifest.browser_specific_settings?.gecko;
    if (gecko?.id !== GECKO_ID) fail(`gecko id must be ${GECKO_ID}`);
    if (gecko?.strict_min_version !== GECKO_MIN_VERSION) fail(`gecko strict_min_version must be ${GECKO_MIN_VERSION}`);
    if (manifest.browser_specific_settings?.gecko_android?.strict_min_version !== GECKO_ANDROID_MIN_VERSION) fail(`gecko_android strict_min_version must be ${GECKO_ANDROID_MIN_VERSION}`);
    if (JSON.stringify(gecko?.data_collection_permissions) !== JSON.stringify({ required: ['authenticationInfo'] })) fail('data_collection_permissions must declare the one thing that leaves the browser: the Quip token, as authenticationInfo');
  }
  if (target === 'safari' && manifest.browser_specific_settings?.safari?.strict_min_version !== SAFARI_MIN_VERSION) fail(`safari strict_min_version must be ${SAFARI_MIN_VERSION}`);

  // The extension pages run under a strict policy: no inline code, no framing, and the network limited to Quip.
  const csp = Object.fromEntries(
    String(manifest.content_security_policy?.extension_pages ?? '')
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...sources]) => [name, sources.join(' ')]),
  );
  const expectedCsp = {
    'default-src': "'self'",
    'script-src': "'self'",
    'object-src': "'self'",
    'style-src': "'self'",
    'img-src': "'self' data:",
    'connect-src': 'https://platform.quip.com',
    'frame-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'none'",
  };
  for (const [name, value] of Object.entries(expectedCsp)) if (csp[name] !== value) fail(`CSP ${name} must be "${value}", got "${csp[name]}"`);
  for (const name of Object.keys(csp)) if (!(name in expectedCsp)) fail(`unexpected CSP directive ${name}`);
  if (JSON.stringify(csp).includes('unsafe-')) fail('the CSP must not allow unsafe-inline or unsafe-eval');
  if (manifest.content_scripts) fail('this extension must not inject content scripts into pages');
  if (manifest.externally_connectable || manifest.web_accessible_resources) fail('the extension must not be reachable from web pages');

  // Chrome refuses to load an extension whose manifest names an icon that is missing, so every declared icon must be
  // in the build, be a PNG, and be the size the manifest says it is.
  const icons = new Map();
  for (const [size, file] of [...Object.entries(manifest.icons ?? {}), ...Object.entries(manifest.action?.default_icon ?? {})]) icons.set(file, Number(size));
  if (icons.size === 0) fail('the manifest must declare icons');
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [file, size] of icons) {
    const bytes = await readFile(`${dist}${file}`).catch(() => undefined);
    if (!bytes) fail(`icon ${file} is declared in the manifest but missing from the build`);
    else if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail(`icon ${file} is not a PNG`);
    else if (bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) fail(`icon ${file} is ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}, but the manifest says ${size}x${size}`);
  }

  // Everything the page points at must be in the package (a missing file is a broken page, not a build error), and the
  // images it shows must be plain pictures.
  const html = await readFile(`${dist}exporter.html`, 'utf8');
  const local = new Set();
  for (const [, , value] of html.matchAll(/\b(src|srcset|href)="([^"]+)"/g)) {
    if (!/^(https?:|data:|#|mailto:)/i.test(value)) local.add(value.split(/\s+/)[0]);
  }
  for (const file of local) {
    const bytes = await readFile(`${dist}${file}`).catch(() => undefined);
    if (!bytes) fail(`exporter.html refers to ${file}, which is missing from the build`);
    else if (file.endsWith('.svg') && /<script|<foreignObject|\son\w+=|(?:href|src)=["'](?!#)/i.test(bytes.toString('utf8'))) fail(`${file} contains something other than plain artwork`);
  }

  for (const file of ['exporter.js', 'background.js']) {
    const code = await readFile(`${dist}${file}`, 'utf8');
    for (const token of ['tryMutation', '__e2e', 'e2e-target', 'e2e-toolbar', 'freshTestTarget', 'zipMax', 'storeMax', 'partEntries', 'takeDownloads']) if (code.includes(token)) fail(`${file} contains test-only token "${token}"`);
    if (/\beval\s*\(|new Function\s*\(/.test(code)) fail(`${file} uses eval or new Function`);
    const hosts = new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
    for (const host of hosts) if (!/(^|\.)quip\.com$/.test(host) && !TEXT_ONLY_HOSTS.has(host)) fail(`${file} references unexpected host ${host}`);
  }

  return failures;
}

const failures = [];
for (const target of requested) failures.push(...(await verify(target)));
if (failures.length > 0) {
  console.error(`Build verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Build verification passed for ${requested.join(', ')}: minimal permissions, strict CSP, valid icons, only Quip hosts (plus example.com and an XML namespace name, as text), no test hooks, no eval.`);
