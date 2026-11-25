import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const failures = [];
const fail = (message) => failures.push(message);

const manifest = JSON.parse(await readFile(`${dist}manifest.json`, 'utf8'));
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://platform.quip.com/*'])) {
  fail(`host_permissions must be exactly platform.quip.com, got ${JSON.stringify(manifest.host_permissions)}`);
}
const allowedPermissions = ['storage', 'activeTab', 'declarativeNetRequest'];
for (const p of manifest.permissions ?? []) if (!allowedPermissions.includes(p)) fail(`unexpected permission: ${p}`);
if (manifest.optional_host_permissions) fail('unexpected optional_host_permissions');

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

for (const file of ['exporter.js', 'background.js']) {
  const code = await readFile(`${dist}${file}`, 'utf8');
  for (const token of ['tryMutation', '__e2e', 'e2e-target', 'freshTestTarget', 'zipMax']) if (code.includes(token)) fail(`${file} contains test-only token "${token}"`);
  if (/\beval\s*\(|new Function\s*\(/.test(code)) fail(`${file} uses eval or new Function`);
  const hosts = new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const host of hosts) if (!/(^|\.)quip\.com$/.test(host)) fail(`${file} references unexpected host ${host}`);
}

if (failures.length > 0) {
  console.error(`Build verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Build verification passed: minimal permissions, strict CSP, valid icons, only Quip hosts, no test hooks, no eval.');
