// The browsers the extension is built for, and how its manifest differs between them. Shared by build.mjs and
// verify-build.mjs so that what is built and what is checked cannot drift apart.

export const TARGETS = {
  chrome: { dir: 'dist', e2eDir: 'dist-e2e', esbuild: 'chrome110', label: 'Chrome, Edge and other Chromium browsers' },
  firefox: { dir: 'dist-firefox', e2eDir: 'dist-e2e-firefox', esbuild: 'firefox115', label: 'Firefox' },
  safari: { dir: 'dist-safari', e2eDir: 'dist-e2e-safari', esbuild: 'safari16.4', label: 'Safari' },
};

/** The add-on id Firefox identifies the extension by. It cannot change once the add-on is published. */
export const GECKO_ID = 'quipendo@aarjav1714.github.io';
/** Firefox 140 is the first release that reads data_collection_permissions, which new add-ons must declare. */
export const GECKO_MIN_VERSION = '140.0';
/** On Android that key arrived one release later. Android is not tested; this only keeps the declaration valid. */
export const GECKO_ANDROID_MIN_VERSION = '142.0';
/** Safari 16.4 is the first release with every extension and web API the page uses (the browser-level guard needs 26). */
export const SAFARI_MIN_VERSION = '16.4';

export const targetNames = Object.keys(TARGETS);

export function parseTarget(name) {
  if (!TARGETS[name]) throw new Error(`Unknown target "${name}". Choose one of: ${targetNames.join(', ')}.`);
  return name;
}

/**
 * The manifest for one browser, made from extension/manifest.json (which is written for Chrome). The permissions, the
 * pages and the content security policy are the same everywhere; what differs is how the background script is
 * declared and the keys each browser wants or rejects.
 */
export function manifestFor(target, base, { e2e = false } = {}) {
  const manifest = structuredClone(base);
  // Only Chrome reads this key; the others warn about it.
  if (target !== 'chrome') delete manifest.minimum_chrome_version;

  if (target === 'firefox') {
    // Firefox runs the background script as an event page, not as a service worker.
    manifest.background = { scripts: ['background.js'] };
    manifest.browser_specific_settings = {
      gecko: {
        id: GECKO_ID,
        strict_min_version: GECKO_MIN_VERSION,
        // Nothing is collected by or sent to the developer; the token and documents only go to Quip, at the user's request.
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: GECKO_ANDROID_MIN_VERSION },
    };
  } else if (target === 'safari') {
    manifest.background = { scripts: ['background.js'] };
    manifest.browser_specific_settings = { safari: { strict_min_version: SAFARI_MIN_VERSION } };
  }

  if (e2e) {
    // Test builds may talk to a local mock server. The shipped builds never get this permission.
    // "localhost" gets a CSP entry but no host permission, to prove the write guard does not depend on one.
    manifest.host_permissions.push('http://127.0.0.1/*');
    manifest.name += ' (E2E build)';
    const csp = manifest.content_security_policy.extension_pages;
    const widened = csp.replace('connect-src https://platform.quip.com', 'connect-src https://platform.quip.com http://127.0.0.1:* http://localhost:*');
    if (widened === csp) throw new Error('could not widen connect-src for the E2E build');
    manifest.content_security_policy.extension_pages = widened;
  }
  return manifest;
}
